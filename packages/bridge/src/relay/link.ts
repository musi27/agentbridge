// Relay ↔ engine glue (§12.3, §13.2, §13.3). Turns the relay client's calls (Grok tool calls, live or held) into engine
// tool calls for the calling bot, and keeps the on-demand relay connection up while Grok is active.
//
// The relay client lives in @agentbridge/relay/client (PR #3). The bridge codes against the small structural interface
// below, so it builds without that package:
//   const link = new RelayLink({ engine });
//   const client = new RelayClient({ url, userId, signer, x25519, onCall: (c) => link.handleCall(c), ... });
//   link.attach(client, { origin: url, userId });
import { timingSafeEqual } from 'node:crypto';
import { botTokenHash, GROK_TOOLS, LIMITS, type Reason, type RelayCall, type ToolResult } from '@agentbridge/protocol';
import type { Engine } from '../core/engine.ts';
import type { TimerHandle } from '../clock.ts';

/** Mirrors `IncomingRelayCall` in @agentbridge/relay/client. */
export interface RelayCallIn { reqId: string; entryId?: string; call: RelayCall; deadlineMs?: number; held: boolean }
/** Mirrors `RelayCallResponse` in @agentbridge/relay/client. `null` = send no `res`. */
export type RelayCallOut = { result: unknown } | { error: { code: string; message: string } };

/** The parts of `RelayClient` (@agentbridge/relay/client, PR #3) the bridge uses. */
export interface RelayTransport {
  /** Control request (§13.3: register_bot, revoke_bot, …). Connects by itself (15 s grace, ignores the daily cap).
   *  Rejects with `RelayControlError { code }` (e.g. rate_limited, not_allowed, timeout, bridge_offline). */
  control(method: string, params: unknown): Promise<unknown>;
  /** Grok activity: connect and stay connected for 10 min (§13.2); subject to the daily cap. */
  markActive(): void;
  /** Connect now for a CLI-driven step, regardless of the cap, and stay connected `graceMs` afterwards. */
  ensureConnected(graceMs?: number): Promise<void>;
}

/** Results above this are refused by the relay client (`LIMITS.relayResponseBytes` on PR #3). */
export const RELAY_RESPONSE_MAX_BYTES = 1024 * 1024;
/** §13.2 "reply awaited": keep marking activity this long after a hand-off to Grok (cards hold runs ≈ 20 min, M0 V6). */
export const REPLY_AWAIT_MS = 25 * 60_000;
export const REPLY_AWAIT_TICK_MS = 5 * 60_000;
export interface RelayEndpoint { origin: string; userId: string }

export class RelayUnavailableError extends Error {
  readonly code = 'bridge_offline';
  constructor(message = 'the relay is not configured on this bridge yet (relay identity comes with `agentbridge init`, M2)') { super(message); }
}

/** Short, actionable texts: they reach the Grok model verbatim (§13.3). */
const GROK_TEXT: Partial<Record<Reason, string>> = {
  duplicate_reply: 'You already replied to that message. Do not reply again; wait for the next delivery.',
  not_participant: 'This bot is not a participant in that conversation.',
  unknown_conversation: 'No such conversation.',
  conversation_ended: 'The conversation has ended.',
  turn_limit: 'The conversation reached its turn limit.',
  too_large: `Message too large (max ${LIMITS.bodyBytes / 1024} KB).`,
  not_allowed: "The user's agentbridge policy does not allow this.",
  rate_limited: 'Too many conversation requests. Try again later.',
  recipient_gone: 'That agent no longer exists. Call bridge_list_agents.',
  recipient_ambiguous: 'Several agents match that address. Call bridge_list_agents and use the exact address.',
  recipient_unsafe_mode: 'That agent cannot take part in conversations right now.',
  recipient_unreachable: 'That agent cannot receive agentbridge messages right now; the request is queued.',
  invalid_message: 'Invalid request.',
  policy_tampered: "agentbridge is paused on the user's computer.",
  grok_run_not_started: 'The delivery could not be started.',
  host_refused: 'The recipient refused the message.',
};
const BAD_TOKEN = 'Invalid or revoked agentbridge token.';

const GROK_PARAMS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  GROK_TOOLS.map((t) => [t.name, new Set(Object.keys((t.inputSchema['properties'] ?? {}) as Record<string, unknown>))]),
);

/** A pending setup round-trip check (§12.5): calls for its conversation id are answered here, not by the engine. */
export interface ProbeMessage { message_id: string; seq: number; from: string; body: string; created_at: string }
export interface ProbeCall { method: string; at: number; params: Record<string, unknown> }
export class Probe {
  readonly calls: ProbeCall[] = [];
  readonly reply: Promise<{ body: string; in_reply_to?: string }>;
  private resolveReply!: (r: { body: string; in_reply_to?: string }) => void;
  readonly botId: string;
  readonly conversationId: string;
  readonly message: ProbeMessage;
  constructor(botId: string, conversationId: string, message: ProbeMessage) {
    this.botId = botId; this.conversationId = conversationId; this.message = message;
    this.reply = new Promise((r) => { this.resolveReply = r; });
  }
  /** @internal */
  handle(method: string, params: Record<string, unknown>, now: number): unknown {
    this.calls.push({ method, at: now, params });
    const m = { ...this.message };
    switch (method) {
      case 'bridge_send': {
        const body = typeof params['body'] === 'string' ? params['body'] : '';
        this.resolveReply({ body, ...(typeof params['in_reply_to'] === 'string' ? { in_reply_to: params['in_reply_to'] } : {}) });
        return { status: 'delivered', conversation_id: this.conversationId };
      }
      case 'bridge_get_messages': return { status: 'delivered', conversation_id: this.conversationId, data: { messages: [m], next_after_seq: null } };
      case 'bridge_get_transcript': return { status: 'delivered', conversation_id: this.conversationId, data: { conversation: null, messages: [m], next_before_seq: null } };
      case 'bridge_end_conversation': return { status: 'delivered', conversation_id: this.conversationId };
      default: return { status: 'failed', reason: 'invalid_message' };
    }
  }
}

export interface RelayLinkOptions {
  engine: Engine;
  transport?: RelayTransport | null;
  endpoint?: RelayEndpoint | null;
  /** Result budget per call (default LIMITS.relayResultBytes). */
  resultBytes?: number;
}

export class RelayLink {
  private readonly engine: Engine;
  private transport: RelayTransport | null;
  private ep: RelayEndpoint | null;
  private readonly resultBytes: number;
  private readonly probes = new Map<string, Probe>();
  private watchTimer: TimerHandle | null = null;

  /** Stable API (stream A wires the real client against it): `new RelayLink({ engine, transport?, endpoint?, resultBytes? })`. */
  constructor(o: RelayLinkOptions) {
    this.engine = o.engine; this.transport = o.transport ?? null; this.ep = o.endpoint ?? null;
    this.resultBytes = o.resultBytes ?? LIMITS.relayResultBytes;
  }

  /**
   * §13.2 "reply awaited": while a Grok conversation waits on the bot (handed off ≤ REPLY_AWAIT_MS ago), call
   * markActive() every REPLY_AWAIT_TICK_MS, so the run's first read after the user allows a card finds the bridge online.
   */
  startReplyWatch(): void {
    this.stopReplyWatch();
    const tick = (): void => {
      if (this.awaitingGrok() > 0) this.markActive();
      this.watchTimer = this.engine.clock.setTimeout(tick, REPLY_AWAIT_TICK_MS);
    };
    this.watchTimer = this.engine.clock.setTimeout(tick, REPLY_AWAIT_TICK_MS);
  }
  stopReplyWatch(): void { this.engine.clock.clearTimeout(this.watchTimer); this.watchTimer = null; }

  /** Active conversations whose reply from a Grok bot is awaited, handed off within REPLY_AWAIT_MS. */
  awaitingGrok(): number {
    return this.engine.store.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM conversations c JOIN participants p ON p.id = c.waiting_on WHERE c.state = 'active' AND p.agent = 'grok' AND c.waiting_since IS NOT NULL AND c.waiting_since >= ?",
      this.engine.clock.now() - REPLY_AWAIT_MS)?.n ?? 0;
  }

  attach(transport: RelayTransport, endpoint: RelayEndpoint): void { this.transport = transport; this.ep = endpoint; }
  get configured(): boolean { return this.transport !== null && this.ep !== null; }
  get endpoint(): RelayEndpoint | null { return this.ep; }

  /** Grok activity (a delivery to Grok, a call from Grok): hold the on-demand connection for the next 10 min (§13.2). */
  markActive(): void { try { this.transport?.markActive(); } catch { /* best effort */ } }

  /** Connect now for a CLI-driven step (round trip, §13.2), staying connected `graceMs` afterwards. */
  async ensureConnected(graceMs?: number): Promise<void> {
    if (!this.transport || !this.ep) throw new RelayUnavailableError();
    await this.transport.ensureConnected(graceMs);
  }

  /** Run a control request (the client connects for it by itself). Errors keep the client's `code`. */
  async control(method: string, params: unknown): Promise<unknown> {
    if (!this.transport || !this.ep) throw new RelayUnavailableError();
    return this.transport.control(method, params);
  }

  /** Register a setup round-trip probe; `done()` removes it. */
  watchProbe(p: Probe): { done: () => void } {
    this.probes.set(p.conversationId, p);
    return { done: () => { if (this.probes.get(p.conversationId) === p) this.probes.delete(p.conversationId); } };
  }

  /**
   * The relay client's `onCall`. Resolves after the engine has stored the call (SQLite, synchronous), so the client may
   * ack it. Throws only if the engine did (the entry is then redelivered after reconnect).
   */
  async handleCall(c: RelayCallIn): Promise<RelayCallOut | null> {
    this.markActive();
    const { call } = c;
    // Caller identity: the relay's `caller` bot id, and the token re-verified against the bridge's own copy (§13.3).
    const bot = this.engine.store.bot(call.caller);
    const participant = bot ? this.engine.store.participant(bot.participant_id) : undefined;
    if (!bot || bot.revoked_at !== null || !participant || participant.state === 'gone' || participant.agent !== 'grok' || !sameHash(call.token, bot.token_hash)) {
      this.engine.event('warning', 'relay_call_rejected', { bot_id: call.caller, method: call.method, why: !bot ? 'unknown_bot' : 'token' });
      return { error: { code: 'not_participant', message: BAD_TOKEN } };
    }
    const allowed = GROK_PARAMS.get(call.method);
    if (!allowed) return { error: { code: 'invalid_message', message: 'Unknown tool.' } };
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(call.params)) if (allowed.has(k)) params[k] = v;
    const convId = typeof call.params['conversation_id'] === 'string' ? call.params['conversation_id'] : undefined;

    const probe = convId ? this.probes.get(convId) : undefined;
    if (probe && probe.botId === call.caller) return { result: probe.handle(call.method, params, this.engine.clock.now()) };

    const opts = { resultBytes: this.resultBytes, ...(call.method === 'bridge_start_conversation' && convId ? { conversation_id: convId } : {}) };
    const r = await this.engine.callTool({ participant_id: participant.id, epoch: 0 }, `tool.${call.method}`, params, opts);
    // a held write rejected later → notice-only delivery (§13.3); not for duplicate_reply (the run already replied)
    if (r.status === 'failed' && c.held && r.reason !== 'duplicate_reply') this.engine.heldRejected(participant.id, call.method, r.conversation_id ?? convId ?? null, r.reason ?? 'invalid_message', r.hint);
    return this.toRelay(r);
  }

  private toRelay(r: ToolResult): RelayCallOut {
    if (r.status === 'failed') {
      const reason = r.reason ?? 'invalid_message';
      const base = GROK_TEXT[reason] ?? 'The request failed.';
      return { error: { code: reason, message: (r.hint && reason !== 'duplicate_reply' ? `${base} (${r.hint})` : base).slice(0, 400) } };
    }
    // reads page under resultBytes but always return at least one message, so a single escaped 32 KB body may exceed
    // the page budget; the hard limit is what the relay client accepts
    if (Buffer.byteLength(JSON.stringify(r), 'utf8') > RELAY_RESPONSE_MAX_BYTES) {
      return { error: { code: 'too_large', message: 'The result is too large. Use smaller pages (before_seq, after_seq, limit).' } };
    }
    return { result: r };
  }
}

function sameHash(token: string, hashHex: string): boolean {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(hashHex)) return false;
  return timingSafeEqual(Buffer.from(botTokenHash(token), 'hex'), Buffer.from(hashHex, 'hex'));
}
