// The bridge engine: the single sequencer and source of truth (§4.1). Tool calls, approvals, conversation state,
// notices and deliveries all go through here. Transport layers (IPC, relay) authenticate callers and pass a Caller.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  LIMITS, NONCE_RE, escapeNonce, renderStandingInstruction, toolParams, sanitizeBody, sanitizeLabel, slugifyName, ulid, shortId, AUTO_MODE_WARNING, zConversationSummary, zUlid,
  type Adapter, type AgentType, type ApprovalFacts, type ConversationSummary, type EndReason, type Notifier, type OutboundItem,
  type OutboundMessage, type OutboundNotice, type ParticipantLink, type ParticipantRef, type PermissionMode, type PresenceChecker,
  type Reason, type ToolMethod, type ToolResult, type Origin,
} from '@agentbridge/protocol';
import { z } from 'zod';
import type { Clock, TimerHandle } from '../clock.ts';
import type { ConversationRow, DeliveryRow, Inbound, MessageRow, ParticipantRow, Store } from '../db/store.ts';
import { decide, type AllowDecision } from '../policy/allowlist.ts';
import { DEFAULT_POLICY, isSelfHostedRelay, rulesOf, type Policy } from '../policy/policy.ts';
import type { PolicyStore } from '../policy/integrity.ts';
import { Pipeline, type Gate, type Settled } from '../delivery/pipeline.ts';
import { ClaudeLinkAdapter } from '../delivery/claude-adapter.ts';
import { ApprovalStore, type Approval, type StartContext } from './approvals.ts';
import * as N from './notices.ts';
import { readSessionTitle, sessionBaseName } from './session-label.ts';
import {
  canConfirm, canSend, checkExtend, checkInviteLimits, nextTurn, recipientMode, requesterMode, resolveAddress, resolveTurnLimit,
  transition, uniqueName, COOLDOWN_END_REASONS,
} from './rules.ts';

export { BRIDGE_VERSION } from '../version.ts';
const LOCAL_AGENTS: ReadonlySet<AgentType> = new Set(['claude', 'codex', 'fake']);
/** Local sessions linked by an MCP server child process; they need a live link to receive (§10, §11a). */
const isHost = (a: AgentType): boolean => a === 'claude' || a === 'codex';
const isLocal = (p: ParticipantRow): boolean => LOCAL_AGENTS.has(p.agent);
const address = (p: ParticipantRow): string => `${p.agent}:${p.name}`;

export interface Caller { participant_id: string; epoch: number }
export interface CallOptions { conversation_id?: string; resultBytes?: number }
/** Default read-result budget: what fits in an IPC frame (§10). */
const IPC_RESULT_BYTES = 200 * 1024;
/** Room kept for the ToolResult envelope (status, ids, hint) around paged data. */
const RESULT_ENVELOPE_BYTES = 1024;
/** Most messages / notices one merged Grok delivery carries (C1: keeps every delivery packable as stubs). */
export const GROK_MERGE_MAX_MESSAGES = 10;
export const GROK_MERGE_MAX_NOTICES = 8;
const zGetMessages = z.object({ conversation_id: zUlid, after_seq: z.number().int().min(0).optional() });

export interface EngineOptions {
  store: Store;
  policy: PolicyStore;
  clock: Clock;
  notifier: Notifier;
  presence: PresenceChecker;
  /** Adapters by agent type. Claude deliveries always go through the built-in link adapter. */
  adapters?: Partial<Record<AgentType, Adapter>>;
  /** Effective crossSessionInbound for a session's cwd (§11.3). Default: accept. */
  inboundReader?: (cwd: string | null) => Inbound;
  transcriptExists?: (path: string) => boolean;
  /** How long a tool call waits for its delivery to settle before answering `queued` (default 15 s). */
  deliveryWaitMs?: number;
  /** How long register_session waits for the SessionStart hook's session_event (default 3 s). */
  registerWaitMs?: number;
  log?: (line: string) => void;
  onStopRequested?: () => void;
}

interface LinkEntry { link: ParticipantLink; epoch: number; nonce: string; connId: string; claude_pid: number; close: () => void; replace: (reason: string) => void }
/** A transport connection offered to registerSession/reconnectSession. */
export interface ConnHandle {
  connId: string; link: ParticipantLink; close: () => void;
  /** False once the socket closed (it may close while registration awaits). */
  isOpen?: () => boolean;
  /** Tell the client a newer registration replaced it (IPC `replaced` event), then close. */
  replace?: (reason: string) => void;
}
const entryFor = (c: ConnHandle, x: { epoch: number; nonce: string; claude_pid: number }): LinkEntry =>
  ({ link: c.link, epoch: x.epoch, nonce: x.nonce, connId: c.connId, claude_pid: x.claude_pid, close: c.close, replace: c.replace ?? (() => c.close()) });
interface PidInfo { session_id: string; source: string; transcript_path: string | null; cwd: string | null; at: number; permission_mode?: PermissionMode }

export type EngineError = { error: { code: Reason | 'unauthenticated' | 'method_not_found' | 'internal'; message: string } };
const err = (code: EngineError['error']['code'], message: string): EngineError => ({ error: { code, message } });
export const isEngineError = (x: unknown): x is EngineError => typeof x === 'object' && x !== null && 'error' in x;

const fail = (reason: Reason, extra: Partial<ToolResult> = {}): ToolResult => ({ status: 'failed', reason, ...extra });
const MUTATING: ReadonlySet<string> = new Set(['tool.bridge_start_conversation', 'tool.bridge_confirm', 'tool.bridge_send', 'tool.bridge_extend_conversation', 'tool.bridge_decline', 'tool.bridge_end_conversation', 'tool.bridge_cancel']);
const IDEMPOTENT: ReadonlySet<string> = new Set(['tool.bridge_start_conversation', 'tool.bridge_send']);

/**
 * Popup types where the user must act (§9.1): shown *and* kept for the next `agentbridge status`
 * until listed there. Others are informational and only need to be shown.
 * relay_disconnected is reserved for the relay (M2).
 */
export const MUST_ACT_POPUPS: ReadonlySet<string> = new Set([
  'approval_needed', 'approval_expired', 'queue_expired', 'grok_delivery_failed', 'policy_tampered', 'relay_disconnected', 'unreachable',
  'relay_cap_reached', 'relay_expired',
]);

export class Engine {
  readonly store: Store;
  readonly policyStore: PolicyStore;
  readonly clock: Clock;
  readonly approvals: ApprovalStore;
  readonly pipeline: Pipeline;
  private readonly notifier: Notifier;
  private readonly presence: PresenceChecker;
  private readonly adapters: Partial<Record<AgentType, Adapter>>;
  private readonly claudeAdapter: ClaudeLinkAdapter;
  private readonly inboundReader: (cwd: string | null) => Inbound;
  private readonly transcriptExists: (path: string) => boolean;
  private readonly deliveryWaitMs: number;
  private readonly registerWaitMs: number;
  private readonly logLine: (line: string) => void;
  private readonly onStopRequested: () => void;

  private readonly links = new Map<string, LinkEntry>();
  private readonly secrets = new Map<string, { participant_id: string; claude_pid: number; nonce: string; epoch: number }>();
  private readonly pidInfo = new Map<number, PidInfo>();
  private readonly pidWaiters = new Map<number, Array<() => void>>();
  private readonly linkWaiters = new Map<number, Array<() => void>>();
  private readonly localEpochs = new Map<string, number>();
  private readonly idemInFlight = new Map<string, Promise<ToolResult>>();
  private readonly dedup = new Map<string, { at: number; peerSeq: number; result: ToolResult }>();
  private readonly confirmed = new Map<string, { at: number; caller: string; facts: ApprovalFacts; result: ToolResult }>();
  private readonly grokAwaiting = new Map<string, { since: number; timer: TimerHandle }>();
  private readonly rideAlong = new Map<string, OutboundNotice[]>();
  private readonly convTimers = new Map<string, TimerHandle[]>();
  private readonly syncWaits = new Set<string>();
  private readonly popupOnce = new Set<string>();
  private readonly unknownModeTimers = new Map<string, TimerHandle>();
  private readonly titleChecked = new Map<string, { at: number; path: string; size: number }>();
  private sweepTimer: TimerHandle | null = null;
  private started = false;
  private stopped = false;

  constructor(o: EngineOptions) {
    this.store = o.store; this.policyStore = o.policy; this.clock = o.clock; this.notifier = o.notifier; this.presence = o.presence;
    this.adapters = o.adapters ?? {};
    this.inboundReader = o.inboundReader ?? (() => 'accept');
    this.transcriptExists = o.transcriptExists ?? existsSync;
    this.deliveryWaitMs = o.deliveryWaitMs ?? 15_000;
    this.registerWaitMs = o.registerWaitMs ?? 3_000;
    this.logLine = o.log ?? (() => {});
    this.onStopRequested = o.onStopRequested ?? (() => {});
    this.claudeAdapter = new ClaudeLinkAdapter((pid) => this.links.get(pid)?.link ?? null);
    this.approvals = new ApprovalStore({ clock: this.clock, timeoutMs: () => this.policyOrDefault().approval.timeout_ms, onExpire: (a) => this.onApprovalExpired(a) });
    this.pipeline = new Pipeline({
      store: this.store, clock: this.clock,
      hooks: {
        gate: (d, p) => this.gate(d, p),
        adapterFor: (p) => (isHost(p.agent) ? this.claudeAdapter : this.adapters[p.agent]),
        refFor: (p) => this.refFor(p),
        onSettled: (d, s, prev) => this.onSettled(d, s, prev),
        onError: (where, e) => this.event('error', 'internal_error', { where, error: String((e as Error)?.stack ?? e).slice(0, 500) }),
      },
    });
  }

  // =====================================================================================================
  // lifecycle
  // =====================================================================================================

  /** Load policy, recover from a restart (§7.3: pending approvals dropped, requesters notified), resume timers. */
  async start(): Promise<void> {
    const ps = await this.policyStore.load();
    if (!ps.ok) {
      this.event('error', 'policy_tampered', { reason: ps.reason, detail: ps.detail });
      await this.popup('policy_tampered', 'agentbridge stopped all conversations', `Policy integrity check failed (${ps.reason}). Run: agentbridge config verify`);
    }
    const now = this.clock.now();
    this.store.tx(() => {
      for (const p of this.store.participants()) if (LOCAL_AGENTS.has(p.agent) && (p.state === 'live' || p.state === 'unreachable')) this.store.updateParticipant(p.id, { state: 'closed', updated_at: now });
    });
    this.recoverApprovals();
    this.checkGone();
    for (const c of this.store.conversations('active')) this.scheduleConvTimers(c);
    this.started = true;
    this.sweep();
    this.pipeline.kickAll();
  }

  stop(): void {
    this.started = false; this.stopped = true;
    this.clock.clearTimeout(this.sweepTimer); this.sweepTimer = null;
    for (const ts of this.convTimers.values()) for (const t of ts) this.clock.clearTimeout(t);
    this.convTimers.clear();
    for (const g of this.grokAwaiting.values()) this.clock.clearTimeout(g.timer);
    this.grokAwaiting.clear();
    for (const t of this.unknownModeTimers.values()) this.clock.clearTimeout(t);
    this.unknownModeTimers.clear();
    this.approvals.clear();
    this.pipeline.stop();
    for (const l of this.links.values()) { try { l.close(); } catch { /* closing */ } }
    this.links.clear();
  }

  /** Periodic: queue expiry, invite expiry, gone participants, idempotency purge. */
  sweep(): void {
    if (!this.started) return;
    this.clock.clearTimeout(this.sweepTimer);
    const now = this.clock.now();
    this.pipeline.sweep();
    const pol = this.policyOrDefault();
    for (const c of this.store.conversations('pending')) {
      if (c.invite_issued_at === null && c.created_at + pol.queue.expiry_ms <= now) this.endConversation(c, 'invite_expired', null);
    }
    this.checkGone();
    this.store.purgeIdem(now - LIMITS.idempotencyTtlMs);
    for (const [k, v] of this.dedup) if (now - v.at > LIMITS.grokDedupWindowMs) this.dedup.delete(k);
    for (const [k, v] of this.confirmed) if (now - v.at > LIMITS.approvalTimeoutMs) this.confirmed.delete(k);
    this.sweepTimer = this.clock.setTimeout(() => this.sweep(), 60_000);
  }

  private policyOrDefault(): Policy {
    const s = this.policyStore.current();
    return s.ok ? s.policy : DEFAULT_POLICY; // fallback only drives timers while integrity failed (activity is refused)
  }
  private policyOk(): boolean { return this.policyStore.current().ok; }

  // =====================================================================================================
  // participants, registration, session events (§5, §10)
  // =====================================================================================================

  /** In-process participant (fake adapter, tests). Each call is a new registration epoch. */
  registerLocal(o: { agent?: 'fake' | 'claude'; name: string; cwd?: string; permission_mode?: PermissionMode; id?: string }): Caller & { address: string } {
    const agent = o.agent ?? 'fake'; const now = this.clock.now();
    let p = o.id ? this.store.participant(o.id) : undefined;
    if (!p) {
      const taken = new Set(this.store.participants().filter((x) => x.agent === agent && x.state !== 'gone').map((x) => x.name));
      p = this.newParticipant(agent, uniqueName(slugifyName(o.name), taken), o.name, o.cwd ?? null);
    }
    const epoch = p.epoch + 1;
    this.store.updateParticipant(p.id, { epoch, state: 'live', permission_mode: o.permission_mode ?? 'default', updated_at: now, ...(o.cwd ? { cwd: o.cwd } : {}) });
    this.localEpochs.set(p.id, epoch);
    this.reissueStaleInvites(p.id, epoch);
    this.afterLive(p.id);
    return { participant_id: p.id, epoch, address: `${agent}:${p.name}` };
  }

  setLocalLive(participantId: string, live: boolean): void {
    this.store.updateParticipant(participantId, { state: live ? 'live' : 'closed', updated_at: this.clock.now() });
    if (live) this.afterLive(participantId);
  }

  setPermissionMode(participantId: string, mode: PermissionMode): void {
    const p = this.store.participant(participantId); if (!p || p.permission_mode === mode) return;
    this.store.updateParticipant(participantId, { permission_mode: mode, updated_at: this.clock.now() });
    this.event('info', 'permission_mode', { mode }, participantId);
    if (mode !== 'unknown') { this.clearUnknownModeTimer(participantId); this.afterLive(participantId); }
  }

  /** Grok bot participant (setup itself lives in `agentbridge add grok`, M2). */
  createBot(o: { name: string; bot_id: string; token_hash: string }): ParticipantRow {
    const taken = new Set(this.store.participants().filter((x) => x.agent === 'grok' && x.state !== 'gone').map((x) => x.name));
    const p = this.newParticipant('grok', uniqueName(slugifyName(o.name), taken), o.name, null, 'live', o.bot_id);
    this.store.insertBot({ bot_id: o.bot_id, participant_id: p.id, token_hash: o.token_hash, created_at: this.clock.now(), revoked_at: null });
    return p;
  }

  /** `agentbridge revoke grok:<name>`: the new token's hash replaces the old one at once (§12.6). */
  rotateBotToken(botId: string, tokenHash: string): void {
    const b = this.store.bot(botId); if (!b) throw new Error(`unknown bot ${botId}`);
    this.store.updateBot(botId, { token_hash: tokenHash, revoked_at: null });
    this.event('warning', 'bot_token_rotated', { bot_id: botId }, b.participant_id);
  }

  private newParticipant(agent: AgentType, name: string, display: string, cwd: string | null, state: ParticipantRow['state'] = 'closed', botId: string | null = null): ParticipantRow {
    const now = this.clock.now();
    const p: ParticipantRow = {
      id: ulid(now), agent, name, display_name: sanitizeLabel(display, LIMITS.nameChars) || name, title: null, cwd, claude_pid: null, session_id: null, transcript_path: null,
      permission_mode: agent === 'grok' ? 'default' : 'unknown', inbound: 'accept', state, epoch: 0, bot_id: botId, created_at: now, updated_at: now,
    };
    this.store.insertParticipant(p);
    this.event('info', 'participant_created', { address: `${agent}:${name}` }, p.id);
    return p;
  }

  /** The participant binding of a live connection (follows adoption and epoch changes). */
  bindingFor(connId: string): Caller | null {
    for (const [pid, l] of this.links) if (l.connId === connId) return { participant_id: pid, epoch: l.epoch };
    return null;
  }

  /** Is `connId` the current live connection of this participant? (One live connection per participant, §10.) */
  isCurrentConnection(participantId: string, connId: string): boolean { return this.links.get(participantId)?.connId === connId; }

  private participantForPid(pid: number): ParticipantRow | undefined {
    for (const [id, l] of this.links) if (l.claude_pid === pid) return this.store.participant(id);
    return this.store.participantByPid(pid);
  }

  /** Hook → bridge (§10). The IPC layer has already checked the peer is a child of claude_pid (best effort). */
  sessionEvent(e: { event: 'start' | 'end' | 'state'; claude_pid: number; session_id: string; source?: string | undefined; permission_mode?: PermissionMode | undefined; transcript_path?: string | undefined; cwd?: string | undefined }): void {
    const now = this.clock.now();
    if (e.event === 'start') {
      const source = e.source ?? 'startup';
      // Codex reports the mode at SessionStart, often before its MCP server registers: keep it for registration
      this.pidInfo.set(e.claude_pid, { session_id: e.session_id, source, transcript_path: e.transcript_path ?? null, cwd: e.cwd ?? null, at: now, ...(e.permission_mode ? { permission_mode: e.permission_mode } : {}) });
      const linked = this.participantForPid(e.claude_pid);
      const known = this.store.session(e.session_id);
      // `--resume` while the session still runs in another terminal: keep both; the new process is its own participant
      const elsewhere = source === 'resume' && !!known && this.liveElsewhere(known.participant_id, e.claude_pid);
      if (elsewhere) {
        this.event('warning', 'resume_while_live', { session_id: e.session_id }, known.participant_id);
        if (linked) this.store.updateParticipant(linked.id, { session_id: e.session_id, claude_pid: e.claude_pid, ...(e.transcript_path ? { transcript_path: e.transcript_path } : {}) });
      } else {
        if (source === 'resume' && known && linked && known.participant_id !== linked.id) this.adopt(linked.id, known.participant_id);
        const target = source === 'resume' && known ? this.store.participant(known.participant_id) : linked;
        if (target) this.linkSession(target, e.claude_pid, e.session_id, source, e.transcript_path ?? null, e.cwd ?? null);
      }
      const ws = this.pidWaiters.get(e.claude_pid); if (ws) { this.pidWaiters.delete(e.claude_pid); for (const w of ws) w(); }
    }
    const p = this.participantForPid(e.claude_pid) ?? (() => { const s = this.store.session(e.session_id); return s ? this.store.participant(s.participant_id) : undefined; })();
    if (!p) return;
    if (e.event === 'end') {
      // early hint only; MCP disconnect is authoritative
      if (p.state === 'live') this.store.updateParticipant(p.id, { state: 'closed', updated_at: now });
      this.event('info', 'session_end_hint', {}, p.id);
    } else if (e.event === 'start' && this.links.has(p.id) && p.state === 'closed') {
      this.store.updateParticipant(p.id, { state: p.inbound === 'accept' ? 'live' : 'unreachable', updated_at: now });
      this.afterLive(p.id);
    }
    if (e.permission_mode) this.setPermissionMode(p.id, e.permission_mode);
    if (e.transcript_path && e.transcript_path !== p.transcript_path) this.store.updateParticipant(p.id, { transcript_path: e.transcript_path });
    const tp = e.transcript_path ?? p.transcript_path; if (tp) this.refreshTitle(p.id, tp);
  }

  private linkSession(p: ParticipantRow, pid: number, sessionId: string, source: string, transcript: string | null, cwd: string | null): void {
    const now = this.clock.now();
    const prev = p.session_id && p.session_id !== sessionId ? p.session_id : null;
    this.store.upsertSession({ session_id: sessionId, participant_id: p.id, claude_pid: pid, source, transcript_path: transcript, cwd, linked_from: prev, created_at: now, last_seen_at: now });
    this.store.updateParticipant(p.id, { session_id: sessionId, claude_pid: pid, updated_at: now, ...(transcript ? { transcript_path: transcript } : {}), ...(cwd && !p.cwd ? { cwd } : {}) });
    if (prev) this.event('info', 'session_linked', { from: prev, to: sessionId, source }, p.id);
  }

  /** A provisional participant (MCP registered before the resume hook) folds into the resumed one. */
  private adopt(provisionalId: string, targetId: string): void {
    const prov = this.store.participant(provisionalId); const target = this.store.participant(targetId);
    if (!prov || !target) return;
    if (this.store.conversationsOf(provisionalId).length > 0) { this.event('warning', 'adopt_skipped', { provisional: provisionalId }, targetId); return; }
    const l = this.links.get(provisionalId);
    const targetLink = this.links.get(targetId);
    if (targetLink && l && targetLink.connId !== l.connId) {
      // never leave a live-but-unbound connection behind (callers avoid this case via liveElsewhere)
      this.links.delete(targetId);
      try { targetLink.replace('this session was resumed in another Claude Code process'); } catch { /* closed */ }
    }
    this.store.tx(() => { this.store.moveSessions(provisionalId, targetId); this.store.deleteParticipant(provisionalId); });
    if (l) {
      const epoch = Math.max(target.epoch, prov.epoch) + 1;
      this.links.delete(provisionalId); this.links.set(targetId, { ...l, epoch });
      for (const [s, v] of this.secrets) if (v.participant_id === provisionalId) this.secrets.set(s, { ...v, participant_id: targetId, epoch });
      this.store.updateParticipant(targetId, { epoch, state: target.inbound === 'accept' ? 'live' : 'unreachable', claude_pid: l.claude_pid, updated_at: this.clock.now() });
      this.afterLive(targetId);
    }
    this.event('info', 'participant_adopted', { provisional: provisionalId }, targetId);
  }

  /** Plugin MCP server → bridge (§10 step 2). Returns the binding for this connection. */
  async registerSession(r: { claude_pid: number; host?: 'claude' | 'codex' | undefined; tag_nonce: string; inbox?: { socket: string; token: string } | undefined; plugin_version: string; cwd?: string | undefined },
    conn: ConnHandle): Promise<{ participant_id: string; address: string; epoch: number; session_secret: string } | EngineError> {
    const open = (): boolean => !this.stopped && (conn.isOpen ? conn.isOpen() : true);
    const alreadyLinked = [...this.links.values()].some((l) => l.claude_pid === r.claude_pid);
    if (!alreadyLinked && !this.pidInfo.has(r.claude_pid) && this.registerWaitMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.registerWaitMs); t.unref?.();
        const list = this.pidWaiters.get(r.claude_pid) ?? []; list.push(() => { clearTimeout(t); resolve(); }); this.pidWaiters.set(r.claude_pid, list);
      });
    }
    // the connection may have closed while we waited: never let a dead registration displace a live one
    if (!open()) return err('unauthenticated', 'connection closed during registration');
    const host = r.host ?? 'claude';
    if (host === 'claude' && !r.inbox) return err('invalid_message', 'Claude Code registrations need the session inbox');
    let p = this.findForRegistration(r.claude_pid);
    if (p && p.agent !== host) p = undefined; // a reused pid from another host never inherits a participant
    const info = this.pidInfo.get(r.claude_pid);
    const cwd = r.cwd ?? info?.cwd ?? null;
    if (!p) {
      const taken = new Set(this.store.participants().filter((x) => x.agent === host && x.state !== 'gone').map((x) => x.name));
      // address = folder + branch, fixed for the session's life; Claude Code's title is only a label (refreshTitle)
      const base = sessionBaseName(cwd);
      p = this.newParticipant(host, uniqueName(base, taken), cwd ? basename(cwd) : 'session', cwd);
    }
    const now = this.clock.now();
    const epoch = p.epoch + 1;
    const inbound = this.inboundReader(cwd ?? p.cwd);
    const old = this.links.get(p.id);
    if (old && old.connId !== conn.connId) { this.links.delete(p.id); try { old.replace('a newer registration for this session replaced this connection'); } catch { /* already closed */ } }
    for (const [s, v] of this.secrets) if (v.participant_id === p.id) this.secrets.delete(s);
    const secret = randomBytes(32).toString('base64url');
    this.secrets.set(secret, { participant_id: p.id, claude_pid: r.claude_pid, nonce: r.tag_nonce, epoch });
    this.links.set(p.id, entryFor(conn, { epoch, nonce: r.tag_nonce, claude_pid: r.claude_pid }));
    this.store.updateParticipant(p.id, { epoch, claude_pid: r.claude_pid, inbound, state: inbound === 'accept' ? 'live' : 'unreachable', updated_at: now, ...(cwd && !p.cwd ? { cwd } : {}) });
    if (info) {
      const owner = this.store.session(info.session_id)?.participant_id;
      // a session id still live in another Claude process stays linked there (`--resume` in a second terminal)
      if (owner && owner !== p.id && this.liveElsewhere(owner, r.claude_pid)) this.store.updateParticipant(p.id, { session_id: info.session_id, ...(info.transcript_path ? { transcript_path: info.transcript_path } : {}) });
      else this.linkSession(this.store.participant(p.id)!, r.claude_pid, info.session_id, info.source, info.transcript_path, info.cwd);
    }
    if (info?.permission_mode) this.setPermissionMode(p.id, info.permission_mode);
    this.reissueStaleInvites(p.id, epoch);
    this.event('info', 'registered', { epoch, plugin_version: r.plugin_version, host }, p.id);
    const ws = this.linkWaiters.get(r.claude_pid); if (ws) { this.linkWaiters.delete(r.claude_pid); for (const w of ws) w(); }
    if (inbound !== 'accept') {
      void this.popupOncePer(`unreachable:${p.id}`, 'agentbridge cannot reach a Claude session', `${address(p)}: crossSessionInbound is "${inbound}". Set it to "accept" in Claude Code settings so agentbridge messages arrive.`);
    }
    this.afterLive(p.id);
    return { participant_id: p.id, address: address(this.store.participant(p.id)!), epoch, session_secret: secret };
  }

  /** Is this participant live on a connection from another Claude process? */
  private liveElsewhere(participantId: string, pid: number): boolean {
    const l = this.links.get(participantId);
    return !!l && l.claude_pid !== pid && (this.store.participant(participantId)?.state ?? 'closed') !== 'gone';
  }

  private findForRegistration(pid: number): ParticipantRow | undefined {
    const linked = [...this.links.entries()].find(([, l]) => l.claude_pid === pid);
    if (linked) return this.store.participant(linked[0]);
    const info = this.pidInfo.get(pid);
    if (info) {
      if (info.source === 'fork') return undefined; // fork → new participant (§10)
      const s = this.store.session(info.session_id);
      if (s && this.liveElsewhere(s.participant_id, pid)) return undefined; // `--resume` of a session still running elsewhere → own participant
      if (s) return this.store.participant(s.participant_id); // resume/compact/known session
      if (info.source === 'clear') return this.store.participantByPid(pid); // /clear: same Claude process
      return undefined; // startup with a new session id (a reused PID must not inherit an old participant)
    }
    // No hook event seen (e.g. the bridge restarted under a running session): same Claude process, same participant.
    return this.store.participantByPid(pid);
  }

  /** Accept approvals bound to an older epoch can no longer be confirmed: withdraw them so afterLive re-issues the invite. */
  private reissueStaleInvites(participantId: string, epoch: number): void {
    for (const a of this.approvals.all()) {
      if (a.participant_id !== participantId || a.epoch === epoch || a.context.kind !== 'accept') continue;
      const convId = a.context.conversation_id;
      this.approvals.resolve(a.facts.approval_id, 'cancelled');
      this.event('info', 'approval_resolved', { approval_id: a.facts.approval_id, state: 'cancelled', why: 'reregistered' }, participantId, convId);
      for (const [did, aid] of this.inviteDeliveries) if (aid === a.facts.approval_id) { this.inviteDeliveries.delete(did); this.store.db.run("DELETE FROM deliveries WHERE id = ? AND state IN ('accepted','queued','held_by_host')", did); }
      const c = this.store.conversation(convId);
      if (c && c.state === 'pending') this.store.updateConversation(convId, { invite_issued_at: null });
    }
  }

  /** Reconnect with the in-memory session secret (same epoch, §10). */
  reconnectSession(r: { participant_id: string; session_secret: string; claude_pid: number }, conn: ConnHandle):
  { participant_id: string; address: string; epoch: number; session_secret: string } | EngineError {
    const s = this.secrets.get(r.session_secret);
    if (!s || s.claude_pid !== r.claude_pid) return err('unauthenticated', 'unknown session secret; register again');
    const p = this.store.participant(s.participant_id);
    if (!p || p.state === 'gone') return err('unauthenticated', 'unknown participant; register again');
    const cur = this.links.get(p.id);
    // a newer registration for this participant supersedes this secret
    if (p.epoch !== s.epoch) return err('unauthenticated', 'superseded by a newer registration; register again');
    if (conn.isOpen && !conn.isOpen()) return err('unauthenticated', 'connection closed');
    if (cur && cur.connId !== conn.connId) { try { cur.replace('a reconnect for this session replaced this connection'); } catch { /* closed */ } }
    this.links.set(p.id, entryFor(conn, { epoch: s.epoch, nonce: s.nonce, claude_pid: r.claude_pid }));
    const epoch = s.epoch;
    this.store.updateParticipant(p.id, { state: p.inbound === 'accept' ? 'live' : 'unreachable', updated_at: this.clock.now() });
    this.event('info', 'reconnected', { epoch }, p.id);
    this.afterLive(p.id);
    return { participant_id: p.id, address: address(p), epoch, session_secret: r.session_secret };
  }

  /** The connection closed: authoritative liveness (§10). */
  connectionClosed(connId: string): void {
    if (this.stopped) return;
    for (const [pid, l] of this.links) {
      if (l.connId !== connId) continue;
      this.links.delete(pid);
      const p = this.store.participant(pid);
      if (p && p.state !== 'gone') this.store.updateParticipant(pid, { state: 'closed', updated_at: this.clock.now() });
      this.event('info', 'disconnected', {}, pid);
    }
  }

  private afterLive(participantId: string): void {
    if (!this.started) return;
    for (const c of this.store.conversationsOf(participantId)) if (c.state === 'pending' && c.invitee_id === participantId && c.invite_issued_at === null) this.tryIssueInvite(c);
    void this.pipeline.kick(participantId);
  }

  private checkGone(): void {
    for (const p of this.store.participants()) {
      if (!isHost(p.agent) || p.state !== 'closed' || !p.transcript_path || this.transcriptExists(p.transcript_path)) continue;
      this.store.updateParticipant(p.id, { state: 'gone', updated_at: this.clock.now() });
      this.event('info', 'participant_gone', {}, p.id);
      for (const c of this.store.conversationsOf(p.id)) if (c.state !== 'ended') this.endConversation(c, 'participant_gone', null);
      for (const d of this.store.pendingDeliveries(p.id)) this.pipeline.settle(d, { state: 'failed', reason: 'recipient_gone' });
    }
  }

  /**
   * Codex SessionStart hook (§11a): the standing instruction with this session's tag code. The MCP server owns the
   * code, so wait briefly for it to register if the hook got here first. Undefined if it never does.
   */
  async standingInstructionFor(hostPid: number, waitMs = LIMITS.codexContextWaitMs): Promise<string | undefined> {
    const find = (): LinkEntry | undefined => [...this.links.values()].find((l) => l.claude_pid === hostPid);
    if (!find() && waitMs > 0 && !this.stopped) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, waitMs); t.unref?.();
        const list = this.linkWaiters.get(hostPid) ?? []; list.push(() => { clearTimeout(t); resolve(); }); this.linkWaiters.set(hostPid, list);
      });
    }
    const l = find();
    return l && NONCE_RE.test(l.nonce) ? renderStandingInstruction(l.nonce, 'codex') : undefined;
  }

  private refFor(p: ParticipantRow): ParticipantRef {
    const nonce = this.links.get(p.id)?.nonce;
    return { participant_id: p.id, address: address(p), agent: p.agent, ...(nonce ? { tag_nonce: nonce } : {}), ...(p.agent === 'codex' && p.session_id ? { session_id: p.session_id } : {}) };
  }

  /** A Claude sender's own tag code never enters stored text, so a leaked code can't be echoed back as a genuine tag. */
  private escapeOwnNonce(p: ParticipantRow, text: string): string {
    const nonce = isHost(p.agent) ? this.links.get(p.id)?.nonce : undefined;
    return nonce && NONCE_RE.test(nonce) ? escapeNonce(text, nonce) : text;
  }

  private epochOf(participantId: string): number { return this.links.get(participantId)?.epoch ?? this.localEpochs.get(participantId) ?? -1; }

  // =====================================================================================================
  // tool calls (§11.4, §12.3)
  // =====================================================================================================

  /**
   * `opts.conversation_id`: relay-allocated id for Grok starts (§13.3). `opts.resultBytes`: size budget for read results
   * (bridge_get_messages, bridge_get_transcript, bridge_list_conversations); the relay link passes LIMITS.relayResultBytes.
   */
  async callTool(caller: Caller, method: string, raw: unknown, opts: CallOptions = {}): Promise<ToolResult> {
    const p = this.store.participant(caller.participant_id);
    if (!p || p.state === 'gone') return fail('not_participant', { hint: 'unknown caller' });
    if (isLocal(p) && this.epochOf(p.id) !== caller.epoch) return fail('not_participant', { hint: 'stale registration; reconnect' });
    if (method === 'tool.bridge_get_messages') return this.getMessages(p, raw, opts.resultBytes);
    const schema = (toolParams as Record<string, z.ZodType>)[method];
    if (!schema) return fail('invalid_message', { hint: `unknown tool ${method}` });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const tooLarge = parsed.error.issues.some((i) => i.message === 'too_large');
      return fail(tooLarge ? 'too_large' : 'invalid_message', { hint: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300) });
    }
    const params = parsed.data as Record<string, unknown>;
    if (MUTATING.has(method) && !this.policyOk()) return fail('policy_tampered', { hint: 'agentbridge stopped all conversations: run agentbridge config verify' });

    const key = typeof params['idempotency_key'] === 'string' ? params['idempotency_key'] : null;
    if (key && IDEMPOTENT.has(method)) {
      const hit = this.store.idem(p.id, caller.epoch, key);
      if (hit && hit.method === method && this.clock.now() - hit.created_at < LIMITS.idempotencyTtlMs) return JSON.parse(hit.result) as ToolResult;
    }
    if (!key || !IDEMPOTENT.has(method)) return this.dispatch(p, caller, method as ToolMethod, params, opts, key);
    // a retry that arrives while the first call is still running shares its result (§6.4)
    const flightKey = `${p.id}|${caller.epoch}|${method}|${key}`;
    const running = this.idemInFlight.get(flightKey);
    if (running) return running;
    const pending = this.dispatch(p, caller, method as ToolMethod, params, opts, key)
      .then((result) => { this.store.putIdem(p.id, caller.epoch, key, method, JSON.stringify(result), this.clock.now()); return result; })
      .finally(() => this.idemInFlight.delete(flightKey));
    this.idemInFlight.set(flightKey, pending);
    return pending;
  }

  private async dispatch(p: ParticipantRow, caller: Caller, method: ToolMethod, a: Record<string, unknown>, opts: CallOptions, key: string | null): Promise<ToolResult> {
    switch (method) {
      case 'tool.bridge_list_agents': return this.listAgents(p);
      case 'tool.bridge_start_conversation': return this.startConversation(p, caller, a as z.infer<(typeof toolParams)['tool.bridge_start_conversation']>, opts, key);
      case 'tool.bridge_confirm': return this.confirm(p, caller, a as ApprovalFacts);
      case 'tool.bridge_cancel': return this.cancel(p, caller, a['approval_id'] as string);
      case 'tool.bridge_decline': return this.decline(p, a['conversation_id'] as string);
      case 'tool.bridge_send': return this.send(p, a as z.infer<(typeof toolParams)['tool.bridge_send']>, key);
      case 'tool.bridge_extend_conversation': return this.extend(p, caller, a['conversation_id'] as string, a['add_turns'] as number);
      case 'tool.bridge_end_conversation': return this.endByParticipant(p, a['conversation_id'] as string);
      case 'tool.bridge_list_conversations': return this.listConversations(p, opts.resultBytes);
      case 'tool.bridge_get_transcript': return this.transcript(p, a['conversation_id'] as string, a['before_seq'] as number | undefined, a['limit'] as number | undefined, opts.resultBytes);
    }
  }

  private listAgents(p: ParticipantRow): ToolResult {
    const local = isLocal(p);
    if (!local && this.policyOrDefault().discovery.relay === 'none') return { status: 'delivered', data: [] };
    const rows = this.store.participants().filter((x) => x.id !== p.id && x.state !== 'gone');
    return { status: 'delivered', data: rows.map((x) => ({ address: address(x), ...(x.title ? { title: x.title } : {}), state: x.state, ...(local ? { short_id: shortId(x.id), ...(x.cwd ? { folder: basename(x.cwd) } : {}) } : {}) })) };
  }

  private participantView(): Array<{ id: string; agent: AgentType; name: string; state: string; cwd: string | null }> {
    return this.store.participants().map((x) => ({ id: x.id, agent: x.agent, name: x.name, state: x.state, cwd: x.cwd }));
  }

  private allowDecision(from: ParticipantRow, to: ParticipantRow, origin: Origin): AllowDecision {
    const pol = this.policyOrDefault();
    const autoPermitted = origin === 'local' || (isSelfHostedRelay(pol) && pol.auto.allow_relay_origin);
    const local = isLocal(from) ? from : isLocal(to) ? to : null;
    return decide(rulesOf(pol), pol.approval.mode, { from: address(from), to: address(to), cwd: local?.cwd ?? null }, autoPermitted);
  }

  private inviteLimits(from: ParticipantRow, to: ParticipantRow): ReturnType<typeof checkInviteLimits> {
    const pol = this.policyOrDefault(); const now = this.clock.now();
    const pair = this.store.db.get<{ t: number | null }>(
      `SELECT max(ended_at) AS t FROM conversations WHERE ((initiator_id = ? AND invitee_id = ?) OR (initiator_id = ? AND invitee_id = ?)) AND end_reason IN (${COOLDOWN_END_REASONS.map(() => '?').join(',')}) AND (invite_issued_at IS NOT NULL OR end_reason = 'invite_expired')`, // only invites a human saw (or that expired) count
      from.id, to.id, to.id, from.id, ...COOLDOWN_END_REASONS);
    return checkInviteLimits({
      pendingByRequester: this.store.countPendingInvites({ initiator: from.id }),
      pendingForTarget: this.store.countPendingInvites({ invitee: to.id }),
      lastPairRefusalAt: pair?.t ?? null,
    }, pol.invites, now);
  }

  private async startConversation(p: ParticipantRow, caller: Caller, a: z.infer<(typeof toolParams)['tool.bridge_start_conversation']>, opts: CallOptions, key: string | null): Promise<ToolResult> {
    const pol = this.policyOrDefault();
    const origin: Origin = isLocal(p) ? 'local' : 'relay';
    if (isLocal(p)) {
      const m = requesterMode(p.permission_mode, pol.delivery.allow_bypass_sessions);
      if (!m.ok) { await this.popup('unsafe', 'agentbridge refused a conversation', `${address(p)} runs in bypassPermissions mode and cannot start conversations.`); return fail(m.reason!); }
    }
    const res = resolveAddress(this.participantView(), a.peer, { local: isLocal(p), excludeId: p.id });
    if (!res.ok) return fail(res.reason, res.candidates ? { candidates: res.candidates } : {});
    const to = this.store.participant(res.id)!;
    if (to.agent === 'grok' && p.agent === 'grok') return fail('not_allowed', { hint: 'Grok bots cannot start conversations with each other' });
    const topic = this.escapeOwnNonce(p, sanitizeLabel(a.topic, LIMITS.topicChars));
    if (!topic) return fail('invalid_message', { hint: 'topic is empty after sanitising' });
    const turnLimit = resolveTurnLimit(a.turn_limit, pol.limits.turns);
    if (turnLimit === null) return fail('invalid_message', { hint: `turn_limit must be 1..${LIMITS.turnLimitMax}` });
    if (a.continues) {
      const old = this.store.conversation(a.continues);
      if (!old) return fail('unknown_conversation');
      if (old.initiator_id !== p.id && old.invitee_id !== p.id) return fail('not_participant');
      if (old.state !== 'ended') return fail('invalid_message', { hint: 'continues must name an ended conversation' });
    }
    if (opts.conversation_id && this.store.conversation(opts.conversation_id)) return fail('invalid_message', { hint: 'duplicate conversation id' });
    const decision = this.allowDecision(p, to, origin);
    if (decision.kind === 'deny') { this.event('info', 'not_allowed', { rule: decision.rule.text }, p.id); return fail('not_allowed'); }
    const lim = this.inviteLimits(p, to);
    if (!lim.ok) {
      this.event('info', 'rate_limited', { hint: lim.hint }, p.id);
      if (!isLocal(p)) this.notify(p.id, null, N.refusedNotice('rate_limited', address(to), lim.hint));
      return fail('rate_limited', { hint: lim.hint });
    }
    if (isLocal(to)) {
      const rm = recipientMode(to.permission_mode, pol.delivery.allow_bypass_sessions);
      if (!rm.ok && rm.reason) return fail(rm.reason);
    }
    const ctx: StartContext = { kind: 'start', recipient_id: to.id, topic, first_message: this.escapeOwnNonce(p, sanitizeBody(a.first_message)), turn_limit: turnLimit, continues: a.continues ?? null, ...(key ? { idempotency: { epoch: caller.epoch, key } } : {}) };
    if (isLocal(p) && decision.kind === 'approval') {
      const appr = this.approvals.issue({ kind: 'start', participant_id: p.id, epoch: caller.epoch, peer: address(to), topic, turn_limit: turnLimit, context: ctx });
      this.event('info', 'approval_issued', { approval_id: appr.facts.approval_id, kind: 'start', peer: address(to) }, p.id);
      return {
        status: 'pending_approval', approval: appr.facts,
        ...(p.permission_mode === 'auto' ? { warning: AUTO_MODE_WARNING } : {}),
        ...(!canConfirm(p.permission_mode) ? { hint: N.dontAskHint(appr.facts.approval_id) } : {}),
      };
    }
    return this.createConversation(p, to, ctx, origin, decision.kind === 'auto', opts.conversation_id);
  }

  /** Conversation enters `pending` (§6.2) after any initiator-side approval. */
  private async createConversation(from: ParticipantRow, to: ParticipantRow, ctx: StartContext, origin: Origin, auto: boolean, id?: string): Promise<ToolResult> {
    const now = this.clock.now(); const pol = this.policyOrDefault();
    const c: ConversationRow = {
      id: id ?? ulid(now), initiator_id: from.id, invitee_id: to.id, topic: ctx.topic, state: 'pending', end_reason: null, turn_count: 0, turn_limit: ctx.turn_limit,
      effective_mode: auto ? 'auto' : 'per_conversation', origin, continues: ctx.continues, first_message_id: null, invite_issued_at: null,
      waiting_on: null, waiting_since: null, waiting_notified: 0, grok_hint_sent: 0, queued: 0, created_at: now, updated_at: now, ended_at: null,
    };
    const first: MessageRow = {
      id: ulid(now), conversation_id: c.id, seq: 1, turn: 1, from_id: from.id, to_id: to.id, kind: 'message', body: ctx.first_message, in_reply_to: null,
      reply_expected: 1, notice_code: null, notice_severity: null, status: 'accepted', reason: null, replied_by: null, created_at: now,
    };
    c.first_message_id = first.id;
    this.store.tx(() => { this.store.insertConversation(c); this.store.insertMessage(first); });
    this.event('info', 'conversation_created', { origin, auto, peer: address(to) }, from.id, c.id);
    // Grok invitees auto-accept (§7.4 A3); auto allow match skips the accept approval (§7.4 B5).
    if (to.agent === 'grok' || auto) {
      if (isLocal(to) && auto) this.addRideAlong(c.id, to.id, N.autoAcceptedNotice(address(from), c.topic, c.turn_limit));
      return this.activate(this.store.conversation(c.id)!, true);
    }
    const r = this.tryIssueInvite(this.store.conversation(c.id)!);
    const fresh = this.store.conversation(c.id)!;
    if (r === 'unreachable') return { status: 'queued', reason: 'recipient_unreachable', conversation_id: c.id };
    if (r === 'refused') return fail('recipient_unsafe_mode', { conversation_id: c.id });
    if (fresh.invite_issued_at === null && this.store.participant(to.id)!.state !== 'live') {
      await this.popupOncePer(`approval_needed:${c.id}`, 'agentbridge: invitation queued', `${address(to)} is closed. Reopen it to see the invitation: agentbridge open ${address(to)}`);
      return { status: 'queued', conversation_id: c.id, hint: `${address(to)} is closed${this.liveSiblingsHint(to, from)}; the invitation waits up to ${Math.round(pol.queue.expiry_ms / 86_400_000)} days` };
    }
    return { status: 'awaiting_local_approval', conversation_id: c.id };
  }

  /**
   * "; claude:x-2 is live": other live sessions in the closed participant's folder (addresses only; e2e run 1).
   * A relay (Grok) caller gets it only when discovery.relay = names, like bridge_list_agents (§12.3).
   */
  private liveSiblingsHint(to: ParticipantRow, from: ParticipantRow): string {
    if (!to.cwd) return '';
    if (!isLocal(from) && this.policyOrDefault().discovery.relay === 'none') return '';
    const live = this.store.participants().filter((x) => x.id !== to.id && x.agent === to.agent && x.cwd === to.cwd && x.state === 'live').map(address);
    return live.length ? `; ${live.slice(0, 3).join(', ')} ${live.length === 1 ? 'is' : 'are'} live` : '';
  }

  /** Issue the accept approval and post the invite when the invitee is live and its mode is known (§7.4 B3). */
  private tryIssueInvite(c: ConversationRow): 'issued' | 'held' | 'unreachable' | 'refused' {
    if (c.state !== 'pending' || c.invite_issued_at !== null) return 'held';
    const to = this.store.participant(c.invitee_id); const from = this.store.participant(c.initiator_id);
    if (!to || !from) return 'held';
    if (!this.policyOk()) return 'held';
    if (to.inbound !== 'accept') { this.store.updateConversation(c.id, { queued: 1 }); return 'unreachable'; }
    if (to.state !== 'live' || (isHost(to.agent) && !this.links.has(to.id))) { this.store.updateConversation(c.id, { queued: 1 }); return 'held'; }
    const pol = this.policyOrDefault();
    const rm = recipientMode(to.permission_mode, pol.delivery.allow_bypass_sessions);
    if (rm.hold) return 'held';
    if (!rm.ok) {
      this.endConversation(c, 'declined', null, { initiatorNotice: N.unsafeModeNotice(address(to), 'recipient') });
      void this.popup('unsafe', 'agentbridge refused a conversation', `${address(to)} runs in bypassPermissions mode and cannot accept conversations.`);
      return 'refused';
    }
    const epoch = this.epochOf(to.id);
    const appr = this.approvals.issue({ kind: 'accept', participant_id: to.id, epoch, peer: address(from), topic: c.topic, turn_limit: c.turn_limit, context: { kind: 'accept', conversation_id: c.id }, startTimer: false });
    this.event('info', 'approval_issued', { approval_id: appr.facts.approval_id, kind: 'accept', peer: address(from), conversation_id: c.id }, to.id, c.id);
    const now = this.clock.now();
    this.store.updateConversation(c.id, { invite_issued_at: now, queued: 0, updated_at: now });
    const notice = N.inviteNotice({ facts: appr.facts, conversationId: c.id, autoModeWarning: to.permission_mode === 'auto', dontAsk: !canConfirm(to.permission_mode) });
    const d = this.pipeline.enqueue({
      participant_id: to.id, conversation_id: c.id, message_ids: [],
      item: { conversation: this.header(this.store.conversation(c.id)!, to.id), messages: [], notices: [notice], reply_to: null },
      expires_at: now + pol.queue.expiry_ms,
    });
    this.inviteDeliveries.set(d.id, appr.facts.approval_id);
    void this.pipeline.kick(to.id);
    return 'issued';
  }
  private readonly inviteDeliveries = new Map<string, string>();

  /** pending → active, then deliver first_message as turn 1. */
  private async activate(c: ConversationRow, wait: boolean): Promise<ToolResult> {
    const t = transition(c.state, { type: 'accept' });
    if (!t.ok) return fail(t.reason, { conversation_id: c.id });
    const now = this.clock.now();
    this.store.updateConversation(c.id, { state: 'active', turn_count: 1, updated_at: now });
    const first = c.first_message_id ? this.store.message(c.first_message_id) : undefined;
    const conv = this.store.conversation(c.id)!;
    this.event('info', 'conversation_active', {}, null, c.id);
    if (!first) return { status: 'delivered', conversation_id: c.id };
    this.setWaiting(conv, first.to_id);
    const res = await this.deliverMessage(this.store.conversation(c.id)!, first, wait);
    return { ...res, conversation_id: c.id, message_id: first.id };
  }

  private async confirm(p: ParticipantRow, caller: Caller, facts: ApprovalFacts): Promise<ToolResult> {
    const prev = this.confirmed.get(facts.approval_id);
    if (prev && prev.caller === `${p.id}|${caller.epoch}` && JSON.stringify(prev.facts) === JSON.stringify(facts)) return prev.result;
    const chk = this.approvals.check(caller, facts);
    if (!chk.ok) {
      this.event('warning', 'confirm_refused', { approval_id: facts.approval_id, reason: chk.reason }, p.id);
      return fail(chk.reason, chk.reason === 'approval_mismatch' ? { hint: 'The confirmed facts differ from the approval as issued. Ask the user to approve the facts exactly as issued, or cancel.' } : {});
    }
    if (!canConfirm(p.permission_mode)) return fail('approval_unavailable', { hint: N.dontAskHint(facts.approval_id) });
    const result = await this.resolveApproval(chk.approval, 'confirmed');
    // remember the result for retries only once the approval is gone (a refusal leaves it confirmable)
    if (!this.approvals.get(facts.approval_id)) this.confirmed.set(facts.approval_id, { at: this.clock.now(), caller: `${p.id}|${caller.epoch}`, facts, result });
    return result;
  }

  /** Mode check for start/accept approvals at confirm time (requester/acceptor and recipient). */
  private unsafeAtConfirm(a: Approval): Reason | null {
    const allow = this.policyOrDefault().delivery.allow_bypass_sessions;
    const ctx = a.context;
    if (ctx.kind === 'extend') return null;
    const self = this.store.participant(a.participant_id);
    if (self && isLocal(self) && !requesterMode(self.permission_mode, allow).ok) return 'requester_unsafe_mode';
    const otherId = ctx.kind === 'start' ? ctx.recipient_id : this.store.conversation(ctx.conversation_id)?.initiator_id;
    const other = otherId ? this.store.participant(otherId) : undefined;
    if (other && isLocal(other)) { const m = recipientMode(other.permission_mode, allow); if (!m.ok && !m.hold) return 'recipient_unsafe_mode'; }
    return null;
  }

  /** Apply a confirmed approval (bridge_confirm or `agentbridge approve`). */
  private async resolveApproval(a: Approval, how: 'confirmed'): Promise<ToolResult> {
    // §8.4 at confirm time: a session may have switched to bypassPermissions since the approval was issued.
    // Refuse before any state change; the approval stays issued in case the mode is switched back.
    const unsafe = this.unsafeAtConfirm(a);
    if (unsafe) {
      this.event('warning', 'confirm_refused', { approval_id: a.facts.approval_id, reason: unsafe }, a.participant_id);
      void this.popup('unsafe', 'agentbridge refused an approval', 'A session involved runs in bypassPermissions mode.');
      return fail(unsafe);
    }
    this.approvals.resolve(a.facts.approval_id, how);
    this.event('info', 'approval_resolved', { approval_id: a.facts.approval_id, state: how }, a.participant_id);
    const ctx = a.context;
    if (ctx.kind === 'start') {
      const from = this.store.participant(a.participant_id); const to = this.store.participant(ctx.recipient_id);
      if (!from || !to || to.state === 'gone') return fail('recipient_gone');
      const decision = this.allowDecision(from, to, 'local');
      if (decision.kind === 'deny') return fail('not_allowed');
      const lim = this.inviteLimits(from, to);
      if (!lim.ok) return fail('rate_limited', { hint: lim.hint });
      return this.createConversation(from, to, ctx, 'local', false);
    }
    const c = this.store.conversation(ctx.conversation_id);
    if (!c) return fail('unknown_conversation');
    if (ctx.kind === 'accept') {
      if (c.state !== 'pending') return fail(c.state === 'ended' ? 'conversation_ended' : 'invalid_message', { conversation_id: c.id });
      const invitee = this.store.participant(c.invitee_id)!;
      this.addRideAlong(c.id, c.initiator_id, N.acceptedNotice(address(invitee)));
      return this.activate(c, true);
    }
    const chk = checkExtend(c, ctx.new_limit - c.turn_limit);
    if (!chk.ok) return fail(chk.reason, { conversation_id: c.id, ...(chk.hint ? { hint: chk.hint } : {}) });
    this.store.updateConversation(c.id, { turn_limit: ctx.new_limit, updated_at: this.clock.now() });
    const requester = this.store.participant(a.participant_id)!;
    const other = c.initiator_id === requester.id ? c.invitee_id : c.initiator_id;
    const conv = this.store.conversation(c.id)!;
    this.notify(other, conv, N.extendedNotice(address(requester), ctx.new_limit));
    this.event('info', 'extended', { turn_limit: ctx.new_limit }, requester.id, c.id);
    return { status: 'delivered', conversation_id: c.id, data: { turn_limit: ctx.new_limit } };
  }

  private async cancel(p: ParticipantRow, caller: Caller, approvalId: string): Promise<ToolResult> {
    const a = this.approvals.get(approvalId);
    if (!a || a.participant_id !== p.id || a.epoch !== caller.epoch) return fail('unknown_approval');
    if (!canConfirm(p.permission_mode)) {
      // dontAsk: Claude Code denied the prompt without asking; keep the approval for `agentbridge approve` (§8.4).
      return fail('approval_unavailable', { hint: N.dontAskHint(approvalId) });
    }
    this.rejectApproval(a, 'cancelled');
    return { status: 'declined', ...(a.context.kind !== 'start' ? { conversation_id: a.context.conversation_id } : {}) };
  }

  /** Cancel/decline an approval (bridge_cancel, `agentbridge decline`). Accept → conversation declined. */
  private rejectApproval(a: Approval, state: 'cancelled' | 'declined'): void {
    this.approvals.resolve(a.facts.approval_id, state);
    this.event('info', 'approval_resolved', { approval_id: a.facts.approval_id, state }, a.participant_id);
    if (a.context.kind === 'accept') {
      const c = this.store.conversation(a.context.conversation_id);
      if (c && c.state === 'pending') this.endConversation(c, 'declined', a.participant_id);
    }
  }

  private decline(p: ParticipantRow, conversationId: string): ToolResult {
    const c = this.store.conversation(conversationId);
    if (!c) return fail('unknown_conversation');
    if (c.invitee_id !== p.id) return fail('not_participant');
    if (c.state === 'ended') return fail('conversation_ended', { conversation_id: c.id });
    if (c.state !== 'pending') return fail('invalid_message', { conversation_id: c.id, hint: 'only pending invitations can be declined; use bridge_end_conversation' });
    const a = this.approvals.find((x) => x.context.kind === 'accept' && x.context.conversation_id === c.id);
    if (a) { this.approvals.resolve(a.facts.approval_id, 'declined'); this.event('info', 'approval_resolved', { approval_id: a.facts.approval_id, state: 'declined' }, p.id); }
    this.endConversation(c, 'declined', p.id);
    return { status: 'declined', conversation_id: c.id };
  }

  private async send(p: ParticipantRow, a: z.infer<(typeof toolParams)['tool.bridge_send']>, key: string | null): Promise<ToolResult> {
    const c = this.store.conversation(a.conversation_id);
    if (!c) return fail('unknown_conversation');
    if (c.initiator_id !== p.id && c.invitee_id !== p.id) return fail('not_participant');
    const peerId = c.initiator_id === p.id ? c.invitee_id : c.initiator_id;
    const body = this.escapeOwnNonce(p, sanitizeBody(a.body));
    // Grok calls without a key: dedupe (caller, conversation, body hash) for 120 s if no peer message arrived since (§6.4).
    let dedupKey: string | null = null; let peerSeq = 0;
    if (p.agent === 'grok' && !key) {
      peerSeq = this.store.db.get<{ s: number | null }>('SELECT max(seq) AS s FROM messages WHERE conversation_id = ? AND from_id = ?', c.id, peerId)?.s ?? 0;
      dedupKey = `${p.id}|${c.id}|${createHash('sha256').update(body).digest('hex')}`;
      const hit = this.dedup.get(dedupKey);
      if (hit && this.clock.now() - hit.at <= LIMITS.grokDedupWindowMs && hit.peerSeq === peerSeq) return hit.result;
    }
    const can = canSend(c);
    if (!can.ok) return fail(can.reason, { conversation_id: c.id, ...(can.reason === 'invalid_message' ? { hint: 'the conversation has not been accepted yet' } : {}) });
    let target: MessageRow | undefined;
    if (p.agent === 'grok') {
      // One Grok reply per local message it was delivered (§6.5).
      // An explicit in_reply_to may name a message whose delivery has not settled yet: the run can call back before the
      // webhook answer is processed, or after an ambiguous network error that did start a run (§12.4 retries).
      target = a.in_reply_to ? this.store.message(a.in_reply_to)
        : this.store.db.get<MessageRow>("SELECT * FROM messages WHERE conversation_id = ? AND to_id = ? AND kind = 'message' AND status IN ('handed_off','delivered') ORDER BY seq DESC LIMIT 1", c.id, p.id);
      if (!target || target.conversation_id !== c.id || target.to_id !== p.id || target.replied_by || !this.postedTo(target, p.id)) {
        return fail('duplicate_reply', { conversation_id: c.id, hint: 'you already replied to that message; wait for the next delivery' });
      }
    } else if (a.in_reply_to) {
      const r = this.store.message(a.in_reply_to);
      if (!r || r.conversation_id !== c.id) return fail('invalid_message', { hint: 'in_reply_to is not a message in this conversation' });
    }
    const now = this.clock.now();
    // turn_count counts consumed turns (a failed delivery refunds one); turn numbers are labels and never reused
    const { turn: count, reachesLimit } = nextTurn(c);
    const turn = this.maxTurn(c.id) + 1;
    const m: MessageRow = {
      id: ulid(now), conversation_id: c.id, seq: 0, turn, from_id: p.id, to_id: peerId, kind: 'message', body, in_reply_to: a.in_reply_to ?? target?.id ?? null,
      reply_expected: a.reply_expected === false ? 0 : 1, notice_code: null, notice_severity: null, status: 'accepted', reason: null, replied_by: null, created_at: now,
    };
    this.store.tx(() => {
      m.seq = this.store.nextSeq(c.id);
      this.store.insertMessage(m);
      this.store.updateConversation(c.id, { turn_count: count, updated_at: now });
      if (target && p.agent === 'grok') this.store.updateMessage(target.id, { replied_by: m.id });
    });
    if (p.agent === 'grok') this.clearGrokAwaiting(c.id);
    const conv = this.store.conversation(c.id)!;
    if (conv.waiting_on === p.id) this.clearWaiting(conv);
    if (m.reply_expected) this.setWaiting(this.store.conversation(c.id)!, peerId);
    this.event('info', 'message_accepted', { turn, count, seq: m.seq, reaches_limit: reachesLimit }, p.id, c.id);
    const res = await this.deliverMessage(this.store.conversation(c.id)!, m, true);
    const out: ToolResult = { ...res, conversation_id: c.id, message_id: m.id };
    if (dedupKey) this.dedup.set(dedupKey, { at: now, peerSeq, result: out });
    return out;
  }

  /** Enqueue a message delivery (merging into a pending Grok delivery, §6.5) and wait for its first outcome. */
  private async deliverMessage(c: ConversationRow, m: MessageRow, wait: boolean): Promise<ToolResult> {
    const to = this.store.participant(m.to_id)!; const from = this.store.participant(m.from_id)!;
    const om: OutboundMessage = { message_id: m.id, seq: m.seq, ...(m.turn !== null ? { turn: m.turn } : {}), from_address: address(from), body: m.body, ...(m.in_reply_to ? { in_reply_to: m.in_reply_to } : {}), created_at: new Date(m.created_at).toISOString() };
    const d = this.enqueueFor(to, c, { messages: [om], notices: this.takeRideAlong(c.id, to.id), reply_to: m.reply_expected ? m.id : null }, [m.id]);
    if (!wait) { void this.pipeline.kick(to.id); return { status: 'queued' }; }
    this.syncWaits.add(d.id);
    let row: DeliveryRow;
    try {
      const p = this.pipeline.waitFor(d.id, this.deliveryWaitMs);
      void this.pipeline.kick(to.id);
      row = await p;
    } finally { this.syncWaits.delete(d.id); }
    return this.statusOf(row, to);
  }

  private statusOf(row: DeliveryRow, to: ParticipantRow): ToolResult {
    switch (row.state) {
      case 'handed_off': case 'delivered': return { status: row.state };
      case 'failed': return { status: 'failed', reason: row.reason ?? 'host_refused', ...(row.hint ? { hint: row.hint } : {}) };
      case 'expired': return { status: 'expired', reason: 'queue_expired' };
      case 'accepted': return { status: 'queued', hint: 'delivery in progress' };
      default:
        if (row.hold === 'unreachable') return { status: 'queued', reason: 'recipient_unreachable' };
        if (row.hold === 'closed') return { status: 'queued', hint: `${address(to)} is closed; it will be delivered when it reopens (agentbridge open ${address(to)})` };
        if (row.hold === 'unknown_mode') return { status: 'queued', hint: N.unknownModeHint(address(to)) };
        if (row.hold === 'serialized') return { status: 'queued', hint: 'held until the peer replies to the previous delivery' };
        if (row.hold === 'cap') return { status: 'queued', hint: 'held: hourly delivery cap for this bot reached' };
        return { status: 'queued', ...(row.reason ? { reason: row.reason } : {}) };
    }
  }

  private enqueueFor(to: ParticipantRow, c: ConversationRow | null, part: { messages: OutboundMessage[]; notices: OutboundNotice[]; reply_to: string | null }, messageIds: string[]): DeliveryRow {
    const now = this.clock.now();
    if (to.agent === 'grok' && c) {
      // merge into a waiting delivery (§6.5), but never beyond GROK_MERGE_MAX_MESSAGES: a long hold must not grow one delivery
      // without bound (packing degrades to stubs; past the cap a new delivery queues behind it instead)
      const target = this.store.pendingDeliveries(to.id).find((d) => d.conversation_id === c.id && d.attempts === 0 && d.hold !== 'retry' && !this.inviteDeliveries.has(d.id) && !this.pipeline.isInFlight(d.id)
        && (JSON.parse(d.item) as OutboundItem).messages.length + part.messages.length <= GROK_MERGE_MAX_MESSAGES
        && (JSON.parse(d.item) as OutboundItem).notices.length + part.notices.length <= GROK_MERGE_MAX_NOTICES);
      if (target) {
        const item = JSON.parse(target.item) as OutboundItem;
        item.messages.push(...part.messages); item.notices.push(...part.notices);
        if (part.reply_to) item.reply_to = part.reply_to;
        item.conversation = this.header(this.store.conversation(c.id)!, to.id);
        const ids = [...(JSON.parse(target.message_ids) as string[]), ...messageIds];
        this.store.updateDelivery(target.id, { item: JSON.stringify(item), message_ids: JSON.stringify(ids), updated_at: now });
        return this.store.delivery(target.id)!;
      }
    }
    return this.pipeline.enqueue({
      participant_id: to.id, conversation_id: c?.id ?? null, message_ids: messageIds,
      item: { ...(c ? { conversation: this.header(c, to.id) } : {}), ...part }, expires_at: now + this.policyOrDefault().queue.expiry_ms,
    });
  }

  /** Header turn/limit shift by refunded turns, so they match the (never reused) message turn numbers. */
  private header(c: ConversationRow, forId: string): NonNullable<OutboundItem['conversation']> {
    const peer = this.store.participant(c.initiator_id === forId ? c.invitee_id : c.initiator_id);
    const r = this.refunds(c.id);
    return { id: c.id, topic: c.topic, peer_address: peer ? address(peer) : 'unknown:unknown', turn: c.turn_count + r, turn_limit: c.turn_limit + r, state: c.state };
  }
  private maxTurn(convId: string): number {
    return this.store.db.get<{ t: number | null }>("SELECT max(turn) AS t FROM messages WHERE conversation_id = ? AND kind = 'message'", convId)?.t ?? 0;
  }
  /** Turns given back after permanently failed or expired deliveries (§6.5). */
  private refunds(convId: string): number {
    return this.store.db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND kind = 'message' AND turn IS NOT NULL AND status IN ('failed','expired')", convId)?.n ?? 0;
  }

  private extend(p: ParticipantRow, caller: Caller, conversationId: string, add: number): ToolResult {
    if (!isLocal(p)) return fail('invalid_message', { hint: 'only local participants can extend a conversation' });
    const c = this.store.conversation(conversationId);
    if (!c) return fail('unknown_conversation');
    if (c.initiator_id !== p.id && c.invitee_id !== p.id) return fail('not_participant');
    const chk = checkExtend(c, add);
    if (!chk.ok) return fail(chk.reason, { conversation_id: c.id, ...(chk.hint ? { hint: chk.hint } : {}) });
    const peer = this.store.participant(c.initiator_id === p.id ? c.invitee_id : c.initiator_id)!;
    const appr = this.approvals.issue({ kind: 'extend', participant_id: p.id, epoch: caller.epoch, peer: address(peer), topic: c.topic, turn_limit: chk.newLimit, context: { kind: 'extend', conversation_id: c.id, new_limit: chk.newLimit } });
    this.event('info', 'approval_issued', { approval_id: appr.facts.approval_id, kind: 'extend', conversation_id: c.id }, p.id, c.id);
    return {
      status: 'pending_approval', approval: appr.facts, conversation_id: c.id,
      ...(p.permission_mode === 'auto' ? { warning: AUTO_MODE_WARNING } : {}),
      ...(!canConfirm(p.permission_mode) ? { hint: N.dontAskHint(appr.facts.approval_id) } : {}),
    };
  }

  private endByParticipant(p: ParticipantRow, conversationId: string): ToolResult {
    const c = this.store.conversation(conversationId);
    if (!c) return fail('unknown_conversation');
    if (c.initiator_id !== p.id && c.invitee_id !== p.id) return fail('not_participant');
    if (c.state === 'ended') return fail('conversation_ended', { conversation_id: c.id });
    const summary = this.endConversation(c, 'ended_by_participant', p.id);
    return { status: 'delivered', conversation_id: c.id, ...(summary ? { data: { summary: summary.text } } : {}) };
  }

  private transcript(p: ParticipantRow, conversationId: string, beforeSeq?: number, limit?: number, budget?: number): ToolResult {
    const c = this.store.conversation(conversationId);
    if (!c) return fail('unknown_conversation');
    if (c.initiator_id !== p.id && c.invitee_id !== p.id) return fail('not_participant');
    return { status: 'delivered', conversation_id: c.id, data: this.transcriptPage(c, p.id, beforeSeq, limit, budget) };
  }

  /** Own conversations; with a size budget (relay), the newest that fit, with a hint when older ones were left out. */
  private listConversations(p: ParticipantRow, budget?: number): ToolResult {
    const all = this.store.conversationsOf(p.id).map((c) => this.summary(c, p.id));
    if (budget === undefined) return { status: 'delivered', data: all };
    const room = budget - RESULT_ENVELOPE_BYTES; const out: ConversationSummary[] = []; let used = 2;
    for (let i = all.length - 1; i >= 0; i--) {
      const n = Buffer.byteLength(JSON.stringify(all[i]), 'utf8') + 1;
      if (used + n > room) break;
      used += n; out.unshift(all[i]!);
    }
    return { status: 'delivered', data: out, ...(out.length < all.length ? { hint: `showing the ${out.length} most recent of ${all.length} conversations` } : {}) };
  }

  /** A transcript page, newest last, trimmed to fit `budget` bytes (default: an IPC frame); older messages via before_seq. */
  transcriptPage(c: ConversationRow, viewerId: string | null, beforeSeq?: number, limit?: number, budgetBytes?: number): { conversation: ConversationSummary | null; messages: unknown[]; next_before_seq: number | null } {
    const names = new Map(this.store.participants().map((x) => [x.id, address(x)]));
    let msgs = this.store.messages(c.id, { ...(beforeSeq !== undefined ? { beforeSeq } : {}), limit: limit ?? 50, kinds: ['message'] })
      .filter((m) => c.state !== 'pending' || viewerId === null || m.from_id === viewerId)
      // a Grok viewer never sees inbound messages it has not been sent yet (held, serialized, capped)
      .filter((m) => viewerId === null || m.to_id !== viewerId || this.store.participant(viewerId)?.agent !== 'grok' || this.postedTo(m, viewerId));
    const view = (m: MessageRow): Record<string, unknown> => ({ message_id: m.id, seq: m.seq, turn: m.turn, from: names.get(m.from_id) ?? 'unknown', body: m.body, status: m.status, ...(m.in_reply_to ? { in_reply_to: m.in_reply_to } : {}), created_at: new Date(m.created_at).toISOString() });
    const budget = (budgetBytes ?? IPC_RESULT_BYTES) - RESULT_ENVELOPE_BYTES; let used = 0; const out: Record<string, unknown>[] = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const v = view(msgs[i]!); const n = Buffer.byteLength(JSON.stringify(v), 'utf8');
      if (out.length > 0 && used + n > budget) break;
      used += n; out.unshift(v);
    }
    msgs = msgs.slice(msgs.length - out.length);
    const first = msgs[0];
    const more = first ? this.store.messages(c.id, { beforeSeq: first.seq, limit: 1, kinds: ['message'] }).length > 0 : false;
    return { conversation: viewerId ? this.summary(c, viewerId) : null, messages: out, next_before_seq: more && first ? first.seq : null };
  }

  /**
   * Grok-only `bridge_get_messages` (§12.3): full text of messages after `after_seq`; by default those of the latest
   * delivery to this bot that carried messages. Only messages the bot sent or that reached it (handed off / delivered)
   * are shown, so held (serialized) messages arrive with their own delivery. Paged by size: `next_after_seq` is set
   * when more remain.
   */
  private getMessages(p: ParticipantRow, raw: unknown, budgetBytes?: number): ToolResult {
    const parsed = zGetMessages.safeParse(raw);
    if (!parsed.success) return fail('invalid_message', { hint: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300) });
    const c = this.store.conversation(parsed.data.conversation_id);
    if (!c) return fail('unknown_conversation');
    if (c.initiator_id !== p.id && c.invitee_id !== p.id) return fail('not_participant');
    let after = parsed.data.after_seq;
    if (after === undefined) {
      // the latest delivery = the handed-off delivery to this bot carrying the newest message (seq is the total order)
      let latest: number[] | null = null;
      for (const d of this.store.deliveriesOf(c.id)) {
        if (d.participant_id !== p.id || (d.state !== 'handed_off' && d.state !== 'delivered')) continue;
        const seqs = (JSON.parse(d.message_ids) as string[]).map((id) => this.store.message(id)?.seq).filter((x): x is number => x !== undefined);
        if (seqs.length && (!latest || Math.max(...seqs) > Math.max(...latest))) latest = seqs;
      }
      if (!latest) return { status: 'delivered', conversation_id: c.id, data: { messages: [], next_after_seq: null }, hint: 'no messages have been delivered to you in this conversation yet' };
      after = Math.min(...latest) - 1;
    }
    const names = new Map(this.store.participants().map((x) => [x.id, address(x)]));
    const visible = this.store.messages(c.id, { afterSeq: after, kinds: ['message'] })
      .filter((m) => m.from_id === p.id ? !['failed', 'expired'].includes(m.status) : this.postedTo(m, p.id));
    const budget = (budgetBytes ?? IPC_RESULT_BYTES) - RESULT_ENVELOPE_BYTES;
    const out: Array<Record<string, unknown>> = []; let used = 0;
    for (const m of visible) {
      const v = { message_id: m.id, seq: m.seq, ...(m.turn !== null ? { turn: m.turn } : {}), from: names.get(m.from_id) ?? 'unknown', body: m.body, ...(m.in_reply_to ? { in_reply_to: m.in_reply_to } : {}), created_at: new Date(m.created_at).toISOString() };
      const n = Buffer.byteLength(JSON.stringify(v), 'utf8') + 1;
      if (out.length > 0 && used + n > budget) break; // always at least one (bodies are <= 32 KB)
      used += n; out.push(v);
    }
    const more = out.length < visible.length;
    return { status: 'delivered', conversation_id: c.id, data: { messages: out, next_after_seq: more ? (out.at(-1)!['seq'] as number) : null } };
  }

  /**
   * Has this message been sent to the (Grok) recipient? Handed off / delivered, or carried by a delivery that was POSTed at
   * least once (an ambiguous network error may still have started a run). Messages still held are not.
   */
  private postedTo(m: MessageRow, recipientId: string): boolean {
    if (m.to_id !== recipientId || m.status === 'failed' || m.status === 'expired') return false;
    if (m.status === 'handed_off' || m.status === 'delivered') return true;
    return this.store.deliveriesOf(m.conversation_id).some((d) => d.participant_id === recipientId && d.attempts >= 1 && (JSON.parse(d.message_ids) as string[]).includes(m.id));
  }

  summary(c: ConversationRow, forId: string): ConversationSummary {
    const peer = this.store.participant(c.initiator_id === forId ? c.invitee_id : c.initiator_id);
    return zConversationSummary.parse({
      id: c.id, peer: peer ? address(peer) : 'fake:unknown', topic: c.topic, state: c.state, ...(c.end_reason ? { end_reason: c.end_reason } : {}),
      turn_count: c.turn_count, turn_limit: c.turn_limit, origin: c.origin, initiator: c.initiator_id === forId,
      ...(c.waiting_on ? { waiting_on: c.waiting_on === forId ? 'me' : 'peer' } : {}), ...(c.queued ? { queued: true } : {}),
      created_at: new Date(c.created_at).toISOString(), updated_at: new Date(c.updated_at).toISOString(),
    });
  }

  // =====================================================================================================
  // ending, timers, notices
  // =====================================================================================================

  /** End a conversation (any reason) and send the §6.6 summary / §9.1 notices. Returns the summary sent. */
  endConversation(c0: ConversationRow, reason: EndReason, by: string | null, opts: { initiatorNotice?: OutboundNotice } = {}): OutboundNotice | null {
    const c = this.store.conversation(c0.id); if (!c) return null;
    const t = transition(c.state, { type: 'end', reason });
    if (!t.ok) return null;
    const now = this.clock.now();
    const wasPending = c.state === 'pending';
    this.store.updateConversation(c.id, { state: 'ended', end_reason: reason, ended_at: now, updated_at: now, waiting_on: null, waiting_since: null, queued: 0 });
    this.clearConvTimers(c.id); this.clearGrokAwaiting(c.id);
    for (const a of this.approvals.all()) if (a.context.kind !== 'start' && a.context.conversation_id === c.id) { this.approvals.resolve(a.facts.approval_id, 'cancelled'); this.event('info', 'approval_resolved', { approval_id: a.facts.approval_id, state: 'cancelled' }, a.participant_id); }
    this.event('info', 'conversation_ended', { reason, by }, by, c.id);
    const ended = this.store.conversation(c.id)!;
    const init = this.store.participant(c.initiator_id)!; const inv = this.store.participant(c.invitee_id)!;
    if (wasPending) {
      // pending: tell the initiator (the invitee only knew of an invite)
      const n = opts.initiatorNotice ?? (reason === 'declined' ? N.declinedNotice(address(inv), 'declined')
        : reason === 'approval_expired' || reason === 'invite_expired' ? N.inviteExpiredForInitiator(address(inv))
          : reason === 'ended_by_participant' && by === inv.id ? N.declinedNotice(address(inv), 'declined')
            : null);
      if (n && by !== init.id) this.notify(init.id, ended, n);
      if (reason === 'ended_by_participant' && by === init.id && c.invite_issued_at !== null) this.notify(inv.id, ended, N.declinedNotice(address(init), 'withdrawn'));
      if (reason === 'approval_expired') this.notify(inv.id, ended, N.approvalExpiredNotice('accept', address(init)), { popupIfClosed: true });
      return null;
    }
    const last = [init, inv].map((x) => this.store.db.get<MessageRow>("SELECT * FROM messages WHERE conversation_id = ? AND from_id = ? AND kind = 'message' AND status NOT IN ('failed','expired') ORDER BY seq DESC LIMIT 1", c.id, x.id))
      .filter((m): m is MessageRow => !!m).map((m) => ({ from: m.from_id === init.id ? address(init) : address(inv), body: m.body }));
    const summary = N.endSummaryNotice({ conversationId: c.id, a: address(init), b: address(inv), topic: c.topic, turnsUsed: ended.turn_count, turnLimit: c.turn_limit, durationMs: now - c.created_at, reason, last });
    for (const pid of [init.id, inv.id]) if (pid !== by) this.notify(pid, ended, { ...summary, id: ulid() });
    return summary;
  }

  /** For a Grok recipient the clock (25-min hint, 1 h notice, §6.5) starts at hand-off to its webhook, not at acceptance. */
  private setWaiting(c: ConversationRow, recipientId: string): void {
    const now = this.clock.now();
    const grok = this.store.participant(recipientId)?.agent === 'grok';
    this.store.updateConversation(c.id, { waiting_on: recipientId, waiting_since: grok ? null : now, waiting_notified: 0, grok_hint_sent: 0 });
    this.scheduleConvTimers(this.store.conversation(c.id)!);
  }
  private clearWaiting(c: ConversationRow): void {
    this.store.updateConversation(c.id, { waiting_on: null, waiting_since: null, waiting_notified: 0, grok_hint_sent: 0 });
    this.clearConvTimers(c.id);
  }
  private clearConvTimers(id: string): void { for (const t of this.convTimers.get(id) ?? []) this.clock.clearTimeout(t); this.convTimers.delete(id); }

  /** Inactivity notice at 1 h, plus the 25-min Grok hint (§6.5); recomputed from the DB on restart. */
  private scheduleConvTimers(c: ConversationRow): void {
    this.clearConvTimers(c.id);
    if (c.state !== 'active' || !c.waiting_on || c.waiting_since === null) return;
    const now = this.clock.now(); const timers: TimerHandle[] = [];
    const waiter = c.waiting_on === c.initiator_id ? c.invitee_id : c.initiator_id;
    const silent = this.store.participant(c.waiting_on);
    if (!silent) return;
    const notifyMs = this.policyOrDefault().limits.inactivity_notice_ms;
    if (!c.waiting_notified) {
      timers.push(this.clock.setTimeout(() => {
        const cur = this.store.conversation(c.id);
        if (!cur || cur.state !== 'active' || cur.waiting_on !== c.waiting_on || cur.waiting_notified) return;
        this.store.updateConversation(c.id, { waiting_notified: 1 });
        this.notify(waiter, cur, N.noReplyNotice(address(silent), Math.round(notifyMs / 60_000)), { popupIfClosed: true });
      }, Math.max(0, c.waiting_since + notifyMs - now)));
    }
    if (silent.agent === 'grok' && !c.grok_hint_sent) {
      timers.push(this.clock.setTimeout(() => {
        const cur = this.store.conversation(c.id);
        if (!cur || cur.state !== 'active' || cur.waiting_on !== c.waiting_on || cur.grok_hint_sent) return;
        this.store.updateConversation(c.id, { grok_hint_sent: 1 });
        this.notify(waiter, cur, N.grokWaitingHint(address(silent)));
      }, Math.max(0, c.waiting_since + LIMITS.grokNoReplyHintMs - now)));
    }
    this.convTimers.set(c.id, timers);
  }

  private clearGrokAwaiting(convId: string): void {
    const g = this.grokAwaiting.get(convId);
    if (!g) return;
    this.clock.clearTimeout(g.timer); this.grokAwaiting.delete(convId);
    const c = this.store.conversation(convId);
    if (c) { const grok = [c.initiator_id, c.invitee_id].find((id) => this.store.participant(id)?.agent === 'grok'); if (grok) void this.pipeline.kick(grok); }
  }

  private addRideAlong(convId: string, pid: string, n: OutboundNotice): void {
    const k = `${convId}|${pid}`; this.rideAlong.set(k, [...(this.rideAlong.get(k) ?? []), n]);
  }
  private takeRideAlong(convId: string, pid: string): OutboundNotice[] {
    const k = `${convId}|${pid}`; const v = this.rideAlong.get(k) ?? []; this.rideAlong.delete(k); return v;
  }

  /** A held Grok write (§13.3) that the bridge rejected: Grok learns it from a notice-only delivery. */
  heldRejected(botParticipantId: string, method: string, conversationId: string | null, reason: Reason, hint?: string): void {
    const c = conversationId ? this.store.conversation(conversationId) ?? null : null;
    this.notify(botParticipantId, c && (c.initiator_id === botParticipantId || c.invitee_id === botParticipantId) ? c : null, N.heldRejectedNotice(method, reason, hint));
  }

  /** Send a notice to a participant (Claude: ab-notice post; Grok: notice-only delivery or a field in the next one). */
  /**
   * A delivery is held because the session hasn't reported its permission mode (no prompt typed yet).
   * If it is still unknown after LIMITS.unknownModePopupMs, tell the user once per session epoch.
   */
  private armUnknownModeTimer(pid: string): void {
    if (this.unknownModeTimers.has(pid) || this.stopped) return;
    this.unknownModeTimers.set(pid, this.clock.setTimeout(() => {
      this.unknownModeTimers.delete(pid);
      const p = this.store.participant(pid);
      if (!p || p.state === 'gone' || p.permission_mode !== 'unknown') return;
      const n = N.unknownModePopup(address(p), p.title);
      void this.popupOncePer(`unknown_mode:${p.id}:${p.epoch}`, n.title, n.body);
    }, LIMITS.unknownModePopupMs));
  }
  private clearUnknownModeTimer(pid: string): void {
    const t = this.unknownModeTimers.get(pid); if (t !== undefined) { this.clock.clearTimeout(t); this.unknownModeTimers.delete(pid); }
  }

  /** Label a Claude session with Claude Code's own title (§5). Throttled; skipped when the transcript hasn't grown. */
  private refreshTitle(pid: string, transcriptPath: string): void {
    const now = this.clock.now(); const last = this.titleChecked.get(pid);
    if (last && last.path === transcriptPath && now - last.at < LIMITS.titleRefreshMs) return;
    let size = -1; try { size = statSync(transcriptPath).size; } catch { /* not written yet */ }
    this.titleChecked.set(pid, { at: now, path: transcriptPath, size });
    if (last && last.path === transcriptPath && last.size === size) return;
    const title = readSessionTitle(transcriptPath);
    const p = this.store.participant(pid);
    if (p && title && title !== p.title) this.store.updateParticipant(pid, { title });
  }

  notify(pid: string, c: ConversationRow | null, n: OutboundNotice, opts: { popupIfClosed?: boolean } = {}): void {
    const p = this.store.participant(pid);
    if (!p || p.state === 'gone') return;
    this.event(n.severity === 'error' ? 'error' : n.severity, `notice:${n.code}`, {}, pid, c?.id ?? null); // logs never carry bodies or topics
    if (opts.popupIfClosed && isLocal(p) && p.state !== 'live') void this.popup(n.code, `agentbridge: ${address(p)}`, n.text.split('\n')[0]!);
    this.enqueueFor(p, c, { messages: [], notices: [n], reply_to: null }, []);
    void this.pipeline.kick(pid);
  }

  /**
   * Desktop popup (§9.1). A rejected notify() leaves it unshown for the next CLI status. A resolved
   * notify() is not proof the user saw it (osascript exits 0 under Focus or with notifications off),
   * so must-act popups (MUST_ACT_POPUPS) are also kept unshown until a CLI status lists them.
   */
  async popup(type: string, title: string, body: string): Promise<void> {
    let shown = 0;
    try { await this.notifier.notify({ title, body }); shown = 1; } catch { shown = 0; }
    if (this.stopped) return;
    const id = this.store.insertEvent({ ts: this.clock.now(), level: 'info', type: `popup:${type}`, participant_id: null, conversation_id: null, data: JSON.stringify({ title, body }), popup: 1 });
    if (shown && !MUST_ACT_POPUPS.has(type)) this.store.markShown([id]);
  }
  private async popupOncePer(key: string, title: string, body: string): Promise<void> {
    if (this.popupOnce.has(key)) return; this.popupOnce.add(key); await this.popup(key.split(':')[0]!, title, body);
  }

  event(level: 'info' | 'warning' | 'error', type: string, data: Record<string, unknown>, participantId: string | null = null, conversationId: string | null = null): void {
    this.store.insertEvent({ ts: this.clock.now(), level, type, participant_id: participantId, conversation_id: conversationId, data: JSON.stringify(data), popup: 0 });
    this.logLine(`${new Date(this.clock.now()).toISOString()} ${level} ${type}${participantId ? ` p=${shortId(participantId)}` : ''}${conversationId ? ` c=${shortId(conversationId)}` : ''} ${JSON.stringify(data)}`);
  }

  // =====================================================================================================
  // delivery hooks
  // =====================================================================================================

  private gate(d: DeliveryRow, p: ParticipantRow): Gate {
    if (!this.policyOk()) return { hold: 'policy', scope: 'participant', reason: 'policy_tampered' };
    if (p.state === 'gone') return { fail: 'recipient_gone' };
    const pol = this.policyOrDefault();
    if (isLocal(p)) {
      if (p.inbound !== 'accept') return { hold: 'unreachable', scope: 'participant', reason: 'recipient_unreachable' };
      if (p.state !== 'live' || (isHost(p.agent) && !this.links.has(p.id))) return { hold: 'closed', scope: 'participant' };
      const m = recipientMode(p.permission_mode, pol.delivery.allow_bypass_sessions);
      if (m.hold) return { hold: 'unknown_mode', scope: 'participant' };
      if (!m.ok) return { fail: m.reason! };
      return { go: true };
    }
    if (p.agent === 'grok') {
      const now = this.clock.now();
      const item = JSON.parse(d.item) as OutboundItem;
      if (this.store.countHandedOffSince(p.id, now - 3600_000) >= LIMITS.grokDeliveriesPerHour) {
        const oldest = this.store.db.get<{ t: number }>("SELECT min(updated_at) AS t FROM deliveries WHERE participant_id = ? AND state IN ('handed_off','delivered') AND updated_at >= ?", p.id, now - 3600_000)?.t ?? now;
        return { hold: 'cap', scope: 'participant', recheckInMs: Math.max(1000, oldest + 3600_000 - now) };
      }
      const aw = d.conversation_id ? this.grokAwaiting.get(d.conversation_id) : undefined;
      if (aw && item.messages.length > 0) {
        const left = aw.since + LIMITS.grokSerializeAfterMs - now;
        if (left > 0) return { hold: 'serialized', scope: 'conversation', recheckInMs: left };
      }
      if (d.conversation_id) {
        // refresh the header (turns may have moved while it waited)
        const c = this.store.conversation(d.conversation_id);
        if (c) { item.conversation = this.header(c, p.id); this.store.updateDelivery(d.id, { item: JSON.stringify(item) }); }
      }
    }
    return { go: true };
  }

  private onSettled(d: DeliveryRow, s: Settled, _prev: DeliveryRow['state']): void {
    const ids = JSON.parse(d.message_ids) as string[];
    const msgs = ids.map((id) => this.store.message(id)).filter((m): m is MessageRow => !!m);
    const to = this.store.participant(d.participant_id);
    const conv = d.conversation_id ? this.store.conversation(d.conversation_id) : undefined;
    const approvalId = this.inviteDeliveries.get(d.id);
    const sync = this.syncWaits.has(d.id);
    if (s.state === 'handed_off' || s.state === 'delivered') {
      for (const m of msgs) this.store.updateMessage(m.id, { status: s.state });
      if (conv?.queued) this.store.updateConversation(conv.id, { queued: 0 });
      if (approvalId) { this.inviteDeliveries.delete(d.id); this.approvals.startTimer(approvalId); }
      const item = JSON.parse(d.item) as OutboundItem;
      // awaiting Grok's reply (§6.5), unless the run already replied before this settle was processed
      if (to?.agent === 'grok' && conv && item.messages.length > 0 && item.reply_to && !this.store.message(item.reply_to)?.replied_by) {
        const cur = this.store.conversation(conv.id)!;
        if (cur.state === 'active' && cur.waiting_on === to.id) { this.store.updateConversation(conv.id, { waiting_since: this.clock.now() }); this.scheduleConvTimers(this.store.conversation(conv.id)!); }
        this.clearGrokAwaitingTimerOnly(conv.id);
        const since = this.clock.now();
        this.grokAwaiting.set(conv.id, { since, timer: this.clock.setTimeout(() => this.clearGrokAwaiting(conv.id), LIMITS.grokSerializeAfterMs) });
      }
      // The message that reaches the limit is delivered, then the conversation ends (§6.5).
      if (conv && conv.state === 'active' && conv.turn_count >= conv.turn_limit && msgs.some((m) => m.turn !== null && m.turn === this.maxTurn(conv.id))) {
        this.endConversation(conv, 'turn_limit', null);
      }
      return;
    }
    if (s.state === 'queued' || s.state === 'held_by_host') {
      if (s.hold === 'unknown_mode' && to) this.armUnknownModeTimer(to.id);
      if (approvalId) {
        // invite could not be posted: withdraw the approval and re-issue when the session is live again
        this.inviteDeliveries.delete(d.id);
        const a = this.approvals.resolve(approvalId, 'cancelled');
        if (a) this.event('info', 'approval_resolved', { approval_id: approvalId, state: 'cancelled', why: 'invite_requeued' }, d.participant_id);
        this.store.db.run('DELETE FROM deliveries WHERE id = ?', d.id);
        if (conv && conv.state === 'pending') this.store.updateConversation(conv.id, { invite_issued_at: null, queued: 1 });
        return;
      }
      for (const m of msgs) if (m.status === 'accepted') this.store.updateMessage(m.id, { status: 'queued' });
      if (!to || msgs.length === 0 || !conv) return;
      const sender = msgs[0]!.from_id;
      if (s.hold === 'closed' && !conv.queued) {
        this.store.updateConversation(conv.id, { queued: 1 });
        if (!sync && isLocal(this.store.participant(sender)!)) this.notify(sender, conv, N.queuedNotice(address(to)));
        void this.popup('queued', 'agentbridge: message queued', `${address(to)} is closed. Reopen it: agentbridge open ${address(to)}`);
      } else if (s.hold === 'unreachable' && !conv.queued) {
        this.store.updateConversation(conv.id, { queued: 1 });
        if (!sync) this.notify(sender, conv, N.unreachableNotice(address(to)));
      } else if (s.hold === 'cap' && !conv.queued) {
        this.store.updateConversation(conv.id, { queued: 1 });
        this.notify(sender, conv, N.capNotice(address(to)));
      }
      return;
    }
    // failed or expired: the message does not consume a turn (§6.5)
    const fs = s as { state: 'failed'; reason: Reason; hint?: string } | { state: 'expired'; reason?: undefined; hint?: undefined };
    if (approvalId) {
      this.inviteDeliveries.delete(d.id);
      const a = this.approvals.resolve(approvalId, s.state === 'expired' ? 'expired' : 'cancelled');
      if (a) this.event('info', 'approval_resolved', { approval_id: approvalId, state: a.state }, d.participant_id);
      if (conv && conv.state === 'pending') this.endConversation(conv, 'invite_expired', null);
      return;
    }
    if (msgs.length === 0 || !conv || !to) return;
    const failedTurns = msgs.filter((m) => m.turn !== null).length;
    for (const m of msgs) {
      this.store.updateMessage(m.id, { status: s.state, reason: fs.state === 'failed' ? fs.reason : 'queue_expired' });
      // a failed reply frees its target so the sender may reply again (§6.5)
      this.store.db.run('UPDATE messages SET replied_by = NULL WHERE replied_by = ?', m.id);
    }
    const cur = this.store.conversation(conv.id)!;
    if (cur.state === 'active' && failedTurns > 0) this.store.updateConversation(cur.id, { turn_count: Math.max(0, cur.turn_count - failedTurns), queued: 0 });
    if (cur.state === 'pending' && msgs.some((m) => m.id === cur.first_message_id)) this.endConversation(cur, 'invite_expired', null);
    const senders = new Set(msgs.map((m) => m.from_id));
    for (const sender of senders) {
      if (s.state === 'expired') {
        this.notify(sender, cur, N.queueExpiredNotice(address(to), msgs.filter((m) => m.from_id === sender).length));
        void this.popup('queue_expired', 'agentbridge: queued message expired', `A message to ${address(to)} expired without being delivered.`);
      } else if (!sync) {
        const hint = fs.hint;
        this.notify(sender, cur, N.deliveryFailedNotice(address(to), fs.reason ?? 'host_refused', hint));  // hint goes in an untrusted block
        if (to.agent === 'grok') void this.popup('grok_delivery_failed', `agentbridge: delivery to ${address(to)} failed`, hint ?? fs.reason ?? 'failed');
      } else if (to.agent === 'grok') {
        void this.popup('grok_delivery_failed', `agentbridge: delivery to ${address(to)} failed`, fs.hint ?? fs.reason ?? 'failed');
      }
      if (fs.reason === 'recipient_unsafe_mode') void this.popup('unsafe', 'agentbridge refused a delivery', `${address(to)} runs in bypassPermissions mode and cannot receive messages.`);
    }
  }

  private clearGrokAwaitingTimerOnly(convId: string): void {
    const g = this.grokAwaiting.get(convId); if (g) { this.clock.clearTimeout(g.timer); this.grokAwaiting.delete(convId); }
  }

  private onApprovalExpired(a: Approval): void {
    this.event('info', 'approval_resolved', { approval_id: a.facts.approval_id, state: 'expired' }, a.participant_id);
    const ctx = a.context;
    if (ctx.kind === 'accept') {
      const c = this.store.conversation(ctx.conversation_id);
      if (c && c.state === 'pending') this.endConversation(c, 'approval_expired', null);
      return;
    }
    const c = ctx.kind === 'extend' ? this.store.conversation(ctx.conversation_id) ?? null : null;
    this.notify(a.participant_id, c, N.approvalExpiredNotice(ctx.kind, a.facts.peer), { popupIfClosed: true });
  }

  /** §7.3: approvals are never persisted. After a restart, tell requesters theirs expired and end affected invites. */
  private recoverApprovals(): void {
    const issued = new Map<string, { participant_id: string | null; data: { approval_id: string; kind: 'start' | 'accept' | 'extend'; peer?: string; conversation_id?: string } }>();
    for (const e of this.store.db.all<{ type: string; participant_id: string | null; data: string }>("SELECT type, participant_id, data FROM events WHERE type IN ('approval_issued','approval_resolved') ORDER BY id")) {
      const d = JSON.parse(e.data) as { approval_id: string; kind: 'start' | 'accept' | 'extend'; peer?: string; conversation_id?: string };
      if (e.type === 'approval_issued') issued.set(d.approval_id, { participant_id: e.participant_id, data: d }); else issued.delete(d.approval_id);
    }
    for (const [id, { participant_id, data }] of issued) {
      this.event('info', 'approval_resolved', { approval_id: id, state: 'expired', why: 'restart' }, participant_id);
      if (data.kind === 'accept' && data.conversation_id) {
        const c = this.store.conversation(data.conversation_id);
        if (!c || c.state !== 'pending') continue;
        const inviteDelivered = this.store.deliveriesOf(c.id).some((d) => d.participant_id === c.invitee_id && (d.state === 'handed_off' || d.state === 'delivered') && JSON.parse(d.message_ids).length === 0);
        if (inviteDelivered) this.endConversation(c, 'approval_expired', null);
        else {
          for (const d of this.store.deliveriesOf(c.id)) if (d.participant_id === c.invitee_id && ['accepted', 'queued', 'held_by_host'].includes(d.state)) this.store.db.run('DELETE FROM deliveries WHERE id = ?', d.id);
          this.store.updateConversation(c.id, { invite_issued_at: null });
        }
      } else if (participant_id) {
        const c = data.conversation_id ? this.store.conversation(data.conversation_id) ?? null : null;
        this.notify(participant_id, c, N.approvalExpiredNotice(data.kind, data.peer ?? 'the peer', 'restart'));
      }
    }
  }

  // =====================================================================================================
  // CLI support (§14); the IPC layer maps cli.* methods here. Privileged ones run the presence check first.
  // =====================================================================================================

  async requirePresence(reason: string): Promise<EngineError | null> {
    const r = await this.presence.check(reason);
    if (r.ok) return null;
    this.event('warning', 'presence_failed', { code: r.code, reason });
    return err('unauthenticated', `user presence check failed (${r.code}${r.detail ? `: ${r.detail}` : ''})`);
  }

  pendingApprovals(): Array<{ approval_id: string; kind: string; participant: string; peer: string; topic: string; turn_limit: number; expires_in_s: number | null }> {
    return this.approvals.all().map((a) => {
      const p = this.store.participant(a.participant_id);
      return { approval_id: a.facts.approval_id, kind: a.facts.kind, participant: p ? address(p) : '?', peer: a.facts.peer, topic: a.facts.topic, turn_limit: a.facts.turn_limit, expires_in_s: a.expires_at === null ? null : Math.max(0, Math.round((a.expires_at - this.clock.now()) / 1000)) };
    });
  }

  /** `agentbridge approve <id>` (presence checked by caller): resolve any approval as confirmed. */
  async approveById(id: string): Promise<ToolResult> {
    if (!this.policyOk()) return fail('policy_tampered');
    const a = this.approvals.get(id);
    if (!a || a.state !== 'issued') return fail('unknown_approval');
    return this.resolveApproval(a, 'confirmed');
  }
  declineById(id: string): ToolResult {
    const a = this.approvals.get(id);
    if (!a || a.state !== 'issued') return fail('unknown_approval');
    this.rejectApproval(a, 'declined');
    return { status: 'declined' };
  }

  /** `agentbridge end <id>`: manual end (pending invitations end as declined). */
  endManual(id: string): ToolResult {
    const c = this.store.conversation(id);
    if (!c) return fail('unknown_conversation');
    if (c.state === 'ended') return fail('conversation_ended');
    this.endConversation(c, c.state === 'pending' ? 'declined' : 'manual', null);
    return { status: 'delivered', conversation_id: id };
  }

  /** `agentbridge extend <id> <n>`: raise the limit directly (presence already checked). */
  extendManual(id: string, add: number): ToolResult {
    if (!this.policyOk()) return fail('policy_tampered');
    const c = this.store.conversation(id);
    if (!c) return fail('unknown_conversation');
    const chk = checkExtend(c, add);
    if (!chk.ok) return fail(chk.reason, chk.hint ? { hint: chk.hint } : {});
    this.store.updateConversation(id, { turn_limit: chk.newLimit, updated_at: this.clock.now() });
    const conv = this.store.conversation(id)!;
    for (const pid of [c.initiator_id, c.invitee_id]) this.notify(pid, conv, N.extendedNotice('the user', chk.newLimit));
    return { status: 'delivered', conversation_id: id, data: { turn_limit: chk.newLimit } };
  }

  requestStop(): void { this.onStopRequested(); }

  /** `agentbridge remove <address>`: the participant is gone; its conversations end (participant_gone). */
  removeParticipant(id: string): void {
    const p = this.store.participant(id); if (!p) return;
    this.links.get(id)?.close();
    this.store.updateParticipant(id, { state: 'gone', updated_at: this.clock.now() });
    for (const c of this.store.conversationsOf(id)) if (c.state !== 'ended') this.endConversation(c, 'participant_gone', null);
    for (const d of this.store.pendingDeliveries(id)) this.pipeline.settle(d, { state: 'failed', reason: 'recipient_gone' });
    for (const a of this.approvals.all()) if (a.participant_id === id) this.approvals.resolve(a.facts.approval_id, 'cancelled');
    this.event('info', 'participant_removed', {}, id);
  }

  /** `agentbridge purge`: delete messages of conversations that ended before `before`. */
  purgeEnded(before: number): number {
    let n = 0;
    this.store.tx(() => {
      for (const c of this.store.conversations('ended')) {
        if ((c.ended_at ?? 0) > before) continue;
        this.store.db.run('DELETE FROM deliveries WHERE conversation_id = ?', c.id);
        this.store.db.run('DELETE FROM messages WHERE conversation_id = ?', c.id);
        this.store.db.run('DELETE FROM conversations WHERE id = ?', c.id);
        n++;
      }
    });
    this.event('info', 'purged', { conversations: n });
    return n;
  }

  /** After `config verify` restores integrity: resume the queue. */
  resumeAfterVerify(): void {
    for (const c of this.store.conversations('pending')) if (c.invite_issued_at === null) this.tryIssueInvite(c);
    this.pipeline.kickAll();
  }

  liveConnections(): number { return this.links.size; }

  /** The adapter registered for an agent type (doctor, Grok setup). */
  adapterFor(agent: AgentType): Adapter | undefined { return isHost(agent) ? this.claudeAdapter : this.adapters[agent]; }
}
