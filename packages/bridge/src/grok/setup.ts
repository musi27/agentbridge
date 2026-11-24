// Bridge side of `agentbridge add grok`, `agentbridge revoke grok:<name>` and the Grok part of `doctor` (§12.5, §12.6).
// The interactive part (clipboard, hidden input, prompts) runs in the CLI process; everything that touches secrets, the
// relay or the database runs here. `begin`/`rotate` run after the bridge-owned presence check; the follow-up steps of
// the same flow carry the setup id they returned (a 256-bit secret, 30 min) instead of asking for presence again.
import { randomBytes } from 'node:crypto';
import {
  GROK_ALLOW_RULE_TOOLS, GROK_CONNECTORS_URL, GROK_ROUTINE_INSTRUCTION, LIMITS, SECRET_NAMES, grokMcpPath, renderBootstrap, sanitizeLabel, ulid,
  REASONS, type Adapter, type OutboundItem, type Reason, type SecretStore,
} from '@agentbridge/protocol';
import type { Engine } from '../core/engine.ts';
import { Probe, type RelayLink } from '../relay/link.ts';
import { botTokenHash, mintBotId, mintBotToken, webhookUrlProblem } from '@agentbridge/adapter-grok';

export const SETUP_TTL_MS = 30 * 60_000;
export const SETUP_CHECK_PEER = 'agentbridge:setup-check';
export const SETUP_CHECK_BODY = 'This is the agentbridge setup check. Please reply with one short sentence so agentbridge can confirm the round trip works.';

export type GrokSetupErrorCode = Reason | 'internal';
export class GrokSetupError extends Error {
  readonly code: GrokSetupErrorCode;
  constructor(code: GrokSetupErrorCode, message: string) { super(message); this.code = code; }
}

/** Keep the relay client's error code (`RelayControlError.code`: rate_limited for the bot limit, not_allowed, …). */
export function relayError(e: unknown, what: string): GrokSetupError {
  const code = (e as { code?: unknown })?.code;
  const mapped: GrokSetupErrorCode = typeof code === 'string' && (REASONS as readonly string[]).includes(code) ? code as Reason : code === 'timeout' ? 'bridge_offline' : 'internal';
  return new GrokSetupError(mapped, `${what}: ${(e as Error)?.message ?? String(e)}`);
}

/** Doctor/setup round trips per bot per hour (each one starts a Grok run, §6.5 cap budget). */
export const ROUND_TRIPS_PER_HOUR = 6;

interface Session { kind: 'add' | 'revoke'; bot_id: string; participant_id: string; expires_at: number; completed: boolean }

export interface BeginResult {
  setup_id: string; bot_id: string; address: string; token: string; relay_origin: string; user_id: string;
  bootstrap: string; instruction: string; allow_rule_tools: readonly string[];
}

/** The MCP connector URL Grok must use for this bot: `<relay origin>/v1/u/<user id>/b/<bot id>/mcp` (§12.5 step 1). */
export function connectorUrl(relayOrigin: string, userId: string, botId: string): string {
  return relayOrigin.replace(/\/+$/, '') + grokMcpPath(userId, botId);
}

/**
 * Likely causes when the round trip fails, in the order §12.5 lists them. With `url`, the connector cause names the
 * exact connector URL: a connector left over from an earlier identity (agentbridge reinstalled or its data purged)
 * still passes the relay's token check, so Grok's replies are queued for a bridge that never connects ("waiting to go
 * out until your computer is back online") while this bridge sees no call at all.
 */
export function roundTripCauses(address: string, url?: string): string[] {
  return [
    'The routine instruction is still the placeholder: open "Inbox from agentbridge", paste the instruction again and save. The panel must show text starting "You receive deliveries from agentbridge".',
    `The reply is held on an Auto-review card: look in your Grok chat for an "Allow … to use agentbridge?" card, and make sure the Allow rule covers ${GROK_ALLOW_RULE_TOOLS.join(', ')} on the agentbridge connector.`,
    `The connector is missing or the token is wrong: check the agentbridge connector (URL and "Authorization: Bearer" token) in Grok. \`agentbridge revoke ${address}\` makes a new token.`
      + (url ? ` Its URL must be exactly ${url}. If Grok says the reply is waiting until your computer is back online, the connector still points at an older address (for example from before agentbridge was reinstalled): edit it to this URL, or delete it yourself at ${GROK_CONNECTORS_URL} (Grok will not delete it) and run \`agentbridge add grok\` again.` : ''),
    'The routine is paused: resume "Inbox from agentbridge" in Grok Bot.',
  ];
}

export type RoundTripResult =
  | { ok: true; address: string; run_uuid?: string; seconds: number; reply_preview: string }
  | { ok: false; address: string; stage: 'network' | 'webhook' | 'cap' | 'busy' | 'no_reply'; detail: string; causes: string[]; calls_seen: string[]; seconds: number };

export interface GrokSetupOptions {
  engine: Engine;
  link: RelayLink;
  secrets: SecretStore;
  /** The Grok adapter (deliveries for the round trip). */
  adapter?: Adapter;
  /** Round-trip budget including the POST and its retries (default LIMITS.grokRoundTripMs). */
  roundTripMs?: number;
  /** Waits before re-POSTing after a network error or 5xx within the budget (default 2 s, 10 s). */
  roundTripRetryMs?: readonly number[];
  now?: () => number;
}

export class GrokSetup {
  private readonly o: GrokSetupOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();

  constructor(o: GrokSetupOptions) { this.o = o; this.now = o.now ?? Date.now; }

  /** The setup session for `id` if it is valid for `kind` ('add' sessions also allow the check). */
  session(id: unknown, kinds: ReadonlyArray<Session['kind']>): Session | null {
    void this.sweepAbandoned();
    if (typeof id !== 'string') return null;
    const s = this.sessions.get(id);
    if (!s || s.expires_at <= this.now() || !kinds.includes(s.kind)) return null;
    return s;
  }

  private newSession(s: Omit<Session, 'expires_at' | 'completed'>): string {
    void this.sweepAbandoned();
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { ...s, expires_at: this.now() + SETUP_TTL_MS, completed: s.kind === 'revoke' });
    if (s.kind === 'add') { const t = setTimeout(() => { void this.sweepAbandoned(); }, SETUP_TTL_MS + 1000); t.unref?.(); }
    return id;
  }

  /** Expired `add` flows that never got their webhook: undo them (relay registration, keychain token, participant). */
  async sweepAbandoned(): Promise<number> {
    let n = 0;
    for (const [k, v] of [...this.sessions]) {
      if (v.expires_at > this.now()) continue;
      this.sessions.delete(k);
      if (v.kind === 'add' && !v.completed) { await this.discard(v, 'abandoned'); n++; }
    }
    return n;
  }

  /** `cli.add_grok {step:'abort'}` (Ctrl-C, error) before the webhook was saved. */
  async abort(setupId: string): Promise<{ removed: boolean }> {
    const s = this.sessions.get(setupId);
    if (!s || s.kind !== 'add') throw new GrokSetupError('not_allowed', 'unknown or expired setup');
    this.sessions.delete(setupId);
    if (s.completed) return { removed: false };
    await this.discard(s, 'aborted');
    return { removed: true };
  }

  private async discard(s: Session, why: string): Promise<void> {
    const p = this.o.engine.store.participant(s.participant_id);
    await this.retire(s.participant_id).catch(() => {});
    if (p && p.state !== 'gone') this.o.engine.removeParticipant(p.id);
    this.o.engine.event('info', 'grok_setup_discarded', { bot_id: s.bot_id, why }, s.participant_id);
  }

  /**
   * A Grok bot leaves (remove, abandoned setup): `revoke_bot` on the relay (best effort), its secrets out of the keychain,
   * revoked in the DB. Returns the relay error, if any, so the CLI can say so.
   */
  async retire(participantId: string): Promise<{ relay_error?: string }> {
    const bot = this.o.engine.store.botByParticipant(participantId);
    if (!bot) return {};
    let relay_error: string | undefined;
    if (this.o.link.configured) {
      try { await this.o.link.control('revoke_bot', { bot_id: bot.bot_id }); } catch (e) { relay_error = (e as Error)?.message ?? String(e); }
    } else relay_error = 'relay not configured';
    for (const n of [SECRET_NAMES.botToken(bot.bot_id), SECRET_NAMES.webhookUrl(bot.bot_id), SECRET_NAMES.webhookKey(bot.bot_id)]) await this.o.secrets.delete(n).catch(() => {});
    this.o.engine.store.updateBot(bot.bot_id, { revoked_at: this.o.engine.clock.now() });
    this.o.engine.event(relay_error ? 'warning' : 'info', 'grok_bot_retired', { bot_id: bot.bot_id, ...(relay_error ? { relay_error } : {}) }, participantId);
    return relay_error ? { relay_error } : {};
  }

  private discovery(): 'names' | 'none' { return this.o.engine.policyStore.policy().discovery.relay; }

  /** Step 1 (§12.5): mint bot_id + token, store the token, register with the relay, create the participant. */
  async begin(rawName: string): Promise<BeginResult> {
    const { engine, link, secrets } = this.o;
    const label = sanitizeLabel(rawName, LIMITS.nameChars);
    if (!/[A-Za-z0-9]/.test(label)) throw new GrokSetupError('invalid_message', 'choose a name with letters or digits, e.g. researcher');
    const ep = link.endpoint;
    if (!link.configured || !ep) throw new GrokSetupError('bridge_offline', 'the relay is not configured on this bridge yet (agentbridge init sets up the relay identity)');
    const botId = mintBotId(); const token = mintBotToken(); const hash = botTokenHash(token);
    await secrets.set(SECRET_NAMES.botToken(botId), token);
    try {
      await link.control('register_bot', { bot_id: botId, token_hash: hash, discovery: this.discovery() });
    } catch (e) {
      await secrets.delete(SECRET_NAMES.botToken(botId)).catch(() => {});
      throw relayError(e, 'the relay did not register the bot');
    }
    const p = engine.createBot({ name: label, bot_id: botId, token_hash: hash });
    const address = `grok:${p.name}`;
    engine.event('info', 'grok_bot_added', { bot_id: botId, address }, p.id);
    return {
      setup_id: this.newSession({ kind: 'add', bot_id: botId, participant_id: p.id }), bot_id: botId, address, token,
      relay_origin: ep.origin, user_id: ep.userId, bootstrap: renderBootstrap(ep.origin.replace(/\/+$/, ''), ep.userId, botId),
      instruction: GROK_ROUTINE_INSTRUCTION, allow_rule_tools: GROK_ALLOW_RULE_TOOLS,
    };
  }

  /** Step 4: the webhook URL and key the user pasted (hidden input) go to the keychain. */
  async saveWebhook(setupId: string, url: string, key: string): Promise<{ address: string }> {
    const s = this.session(setupId, ['add']);
    if (!s) throw new GrokSetupError('not_allowed', 'this setup has expired; run agentbridge add grok again');
    const problem = webhookUrlProblem(url);
    if (problem) throw new GrokSetupError('invalid_message', problem);
    const k = key.trim();
    if (!k || /\s/.test(k) || k.length > 1024) throw new GrokSetupError('invalid_message', 'the webhook key looks wrong (empty, has spaces, or too long)');
    await this.o.secrets.set(SECRET_NAMES.webhookUrl(s.bot_id), url.trim());
    await this.o.secrets.set(SECRET_NAMES.webhookKey(s.bot_id), k);
    s.completed = true; // no longer an abandoned setup if it expires
    const address = this.addressOf(s.participant_id);
    this.o.engine.event('info', 'grok_webhook_saved', { bot_id: s.bot_id }, s.participant_id);
    return { address };
  }

  /** `agentbridge revoke grok:<name>`: a new token replaces the old one in the keychain, the relay and the DB (§12.6). */
  async rotate(participantId: string): Promise<{ setup_id: string; bot_id: string; address: string; token: string }> {
    const { engine, link, secrets } = this.o;
    const bot = engine.store.botByParticipant(participantId);
    if (!bot) throw new GrokSetupError('unknown_conversation', 'that address is not a Grok bot');
    if (!link.configured) throw new GrokSetupError('bridge_offline', 'the relay is not configured on this bridge');
    const old = await secrets.get(SECRET_NAMES.botToken(bot.bot_id));
    const token = mintBotToken(); const hash = botTokenHash(token);
    // keychain and DB first, then the relay: a crash in between leaves the bridge holding the new token, and running
    // revoke again re-registers it (the relay never knows a token the bridge does not)
    await secrets.set(SECRET_NAMES.botToken(bot.bot_id), token);
    engine.rotateBotToken(bot.bot_id, hash);
    try {
      await link.control('register_bot', { bot_id: bot.bot_id, token_hash: hash, discovery: this.discovery() });
    } catch (e) {
      engine.rotateBotToken(bot.bot_id, bot.token_hash);
      if (old !== null) await secrets.set(SECRET_NAMES.botToken(bot.bot_id), old).catch(() => {}); else await secrets.delete(SECRET_NAMES.botToken(bot.bot_id)).catch(() => {});
      throw relayError(e, 'the relay did not accept the new token (the old one still works)');
    }
    return { setup_id: this.newSession({ kind: 'revoke', bot_id: bot.bot_id, participant_id: participantId }), bot_id: bot.bot_id, address: this.addressOf(participantId), token };
  }

  private addressOf(pid: string): string { const p = this.o.engine.store.participant(pid); return p ? `${p.agent}:${p.name}` : 'grok:?'; }

  /**
   * Mandatory round trip (§12.5 step 5, and `doctor` on demand): send a test delivery and wait for the run's
   * bridge_send. The probe answers the run's calls for its own conversation id; no conversation is stored.
   */
  async roundTrip(participantId: string): Promise<RoundTripResult> {
    const { engine, link, adapter } = this.o;
    const budget = this.o.roundTripMs ?? LIMITS.grokRoundTripMs;
    const started = Date.now(); const deadline = started + budget; // one budget for POSTs, retries and the wait
    const secs = (): number => Math.round((Date.now() - started) / 1000);
    const bot = engine.store.botByParticipant(participantId);
    const address = this.addressOf(participantId);
    if (!bot) throw new GrokSetupError('unknown_conversation', 'that address is not a Grok bot');
    if (!adapter) throw new GrokSetupError('internal', 'the Grok adapter is not loaded in this bridge');
    if (!link.configured) throw new GrokSetupError('bridge_offline', 'the relay is not configured on this bridge');
    const ep = link.endpoint;
    const url = ep ? connectorUrl(ep.origin, ep.userId, bot.bot_id) : undefined;
    const fail = (stage: Extract<RoundTripResult, { ok: false }>['stage'], detail: string, causes: string[] = [], calls: string[] = []): RoundTripResult =>
      ({ ok: false, address, stage, detail, causes, calls_seen: calls, seconds: secs() });
    if (this.inFlight.has(bot.bot_id)) return fail('busy', 'a round trip for this bot is already running');
    const hour = engine.clock.now() - 3600_000;
    const recent = engine.store.db.get<{ n: number }>("SELECT count(*) AS n FROM events WHERE type = 'grok_round_trip_started' AND participant_id = ? AND ts >= ?", participantId, hour)?.n ?? 0;
    if (recent >= ROUND_TRIPS_PER_HOUR) return fail('cap', `at most ${ROUND_TRIPS_PER_HOUR} round trips per bot per hour; try again later`);
    if (engine.store.countHandedOffSince(participantId, hour) >= LIMITS.grokDeliveriesPerHour) return fail('cap', 'the hourly delivery cap for this bot is reached; try again later');
    this.inFlight.add(bot.bot_id);
    const conv = ulid(); const mid = ulid(); const at = new Date(engine.clock.now()).toISOString();
    const probe = new Probe(bot.bot_id, conv, { message_id: mid, seq: 1, from: SETUP_CHECK_PEER, body: SETUP_CHECK_BODY, created_at: at });
    const watch = link.watchProbe(probe);
    const item: OutboundItem = {
      item_id: ulid(), conversation: { id: conv, topic: 'agentbridge setup check', peer_address: SETUP_CHECK_PEER, turn: 1, turn_limit: 2, state: 'active' },
      messages: [{ message_id: mid, seq: 1, turn: 1, from_address: SETUP_CHECK_PEER, body: SETUP_CHECK_BODY, created_at: at }], notices: [], reply_to: mid,
    };
    try {
      await link.ensureConnected(budget + 15_000); // stay connected for the whole check (§13.2), regardless of the cap
      engine.event('info', 'grok_round_trip_started', { bot_id: bot.bot_id }, participantId);
      const retries = [...(this.o.roundTripRetryMs ?? [2_000, 10_000])];
      let out = await adapter.deliver(item, { participant_id: participantId, address, agent: 'grok' });
      while (out.status === 'failed' && out.retryable && retries.length && Date.now() + retries[0]! < deadline - Math.min(5_000, budget / 4)) {
        await sleep(retries.shift()!);
        out = await adapter.deliver(item, { participant_id: participantId, address, agent: 'grok' }); // same payload
      }
      if (out.status === 'failed') {
        if (out.retryable) return fail('network', out.hint ?? 'the Grok webhook could not be reached', [`agentbridge could not reach the Grok webhook (${out.hint ?? 'network error'}), so no run started. Check your internet connection, then run \`agentbridge doctor ${address}\`.`]);
        const causes = roundTripCauses(address, url);
        if (/paused/.test(out.hint ?? '')) return fail('webhook', out.hint ?? out.reason, [causes[3]!]);
        return fail('webhook', out.hint ?? out.reason, /key changed|not set up|missing/.test(out.hint ?? '') ? [`Paste the webhook URL and key again: agentbridge add grok (or check them in the routine panel). ${out.hint ?? ''}`.trim()] : causes);
      }
      if (out.status === 'queued' || out.status === 'held_by_host') return fail('cap', out.hint ?? 'the hourly delivery cap for this bot is reached; try again later');
      const runUuid = 'run_uuid' in out ? out.run_uuid : undefined;
      // counts toward the bot's hourly delivery cap like any hand-off (§6.5)
      const now = engine.clock.now();
      engine.store.insertDelivery({ id: ulid(), participant_id: participantId, conversation_id: null, item: JSON.stringify({ item_id: item.item_id, setup_check: true }), message_ids: '[]', state: 'handed_off', hold: null, reason: null, hint: null, attempts: 1, run_uuid: runUuid ?? null, created_at: now, updated_at: now, expires_at: now });
      const left = Math.max(0, deadline - Date.now());
      const reply = await Promise.race([probe.reply, sleep(left).then(() => null)]);
      if (reply) {
        engine.event('info', 'grok_round_trip_ok', { bot_id: bot.bot_id, seconds: secs() }, participantId);
        return { ok: true, address, ...(runUuid ? { run_uuid: runUuid } : {}), seconds: secs(), reply_preview: sanitizeLabel(reply.body, 200) };
      }
      const seen = probe.calls.map((c) => c.method);
      engine.event('warning', 'grok_round_trip_failed', { bot_id: bot.bot_id, calls_seen: seen }, participantId);
      return fail('no_reply', seen.length === 0
        ? `the run started (${runUuid ?? 'no run id'}) but no agentbridge call from it reached this bridge`
        : `the run called ${[...new Set(seen)].join(', ')} but did not reply with bridge_send`, roundTripCauses(address, url), seen);
    } finally { watch.done(); this.inFlight.delete(bot.bot_id); }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
