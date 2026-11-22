// Pure conversation rules (§5, §6.2, §6.5, §8.3, §8.4). No I/O; the engine feeds them rows and applies the verdicts.
import { LIMITS, UNSAFE_MODES, NO_CONFIRM_MODES, shortId, parseAddress, type ConversationState, type EndReason, type PermissionMode, type Reason, type AgentType } from '@agentbridge/protocol';
import { basename } from 'node:path';

// ---------- §6.2 state machine ----------
export const PENDING_END_REASONS: ReadonlySet<EndReason> = new Set(['declined', 'approval_expired', 'invite_expired', 'participant_gone', 'ended_by_participant']);
export const ACTIVE_END_REASONS: ReadonlySet<EndReason> = new Set(['ended_by_participant', 'turn_limit', 'participant_gone', 'manual']);

export type ConvEvent = { type: 'accept' } | { type: 'end'; reason: EndReason };
export type Transition = { ok: true; state: ConversationState; end_reason?: EndReason } | { ok: false; reason: Reason };

export function transition(state: ConversationState, ev: ConvEvent): Transition {
  if (state === 'ended') return { ok: false, reason: 'conversation_ended' };
  if (ev.type === 'accept') return state === 'pending' ? { ok: true, state: 'active' } : { ok: false, reason: 'invalid_message' };
  const allowed = state === 'pending' ? PENDING_END_REASONS : ACTIVE_END_REASONS;
  return allowed.has(ev.reason) ? { ok: true, state: 'ended', end_reason: ev.reason } : { ok: false, reason: 'invalid_message' };
}

// ---------- §6.5 turns ----------
export function resolveTurnLimit(requested: number | undefined, policyDefault: number): number | null {
  const v = requested ?? policyDefault;
  return Number.isInteger(v) && v >= 1 && v <= LIMITS.turnLimitMax ? v : null;
}

/** Can a participant send a `message` now? */
export function canSend(c: { state: ConversationState; turn_count: number; turn_limit: number }): { ok: true } | { ok: false; reason: Reason } {
  if (c.state === 'ended') return { ok: false, reason: 'conversation_ended' };
  if (c.state === 'pending') return { ok: false, reason: 'invalid_message' };
  if (c.turn_count >= c.turn_limit) return { ok: false, reason: 'turn_limit' };
  return { ok: true };
}

/** Accepting one message: its turn number and whether it is the one that reaches the limit (and is still delivered). */
export function nextTurn(c: { turn_count: number; turn_limit: number }): { turn: number; reachesLimit: boolean } {
  const turn = c.turn_count + 1;
  return { turn, reachesLimit: turn >= c.turn_limit };
}

export const turnsLeft = (c: { turn_count: number; turn_limit: number }): number => Math.max(0, c.turn_limit - c.turn_count);
/** Header warning ("2 turns left") once turns_left <= LIMITS.turnWarningAt after this message. */
export const turnWarning = (turn: number, limit: number): boolean => limit - turn <= LIMITS.turnWarningAt;

/** Extension must be confirmed before the limit; new limit capped at 200. */
export function checkExtend(c: { state: ConversationState; turn_count: number; turn_limit: number }, add: number): { ok: true; newLimit: number } | { ok: false; reason: Reason; hint?: string } {
  if (c.state === 'ended') return { ok: false, reason: 'conversation_ended' };
  if (c.state !== 'active') return { ok: false, reason: 'invalid_message', hint: 'only active conversations can be extended' };
  if (c.turn_count >= c.turn_limit) return { ok: false, reason: 'turn_limit' };
  const newLimit = c.turn_limit + add;
  if (!Number.isInteger(add) || add < 1 || newLimit > LIMITS.turnLimitMax) return { ok: false, reason: 'invalid_message', hint: `the turn limit cannot exceed ${LIMITS.turnLimitMax}` };
  return { ok: true, newLimit };
}

// ---------- §8.4 permission modes ----------
export interface ModeVerdict { ok: boolean; reason?: Reason; hold?: boolean; warning?: boolean }

/** Can a local session in `mode` start or accept? (auto allowed with warning; bypass refused unless overridden.) */
export function requesterMode(mode: PermissionMode, allowBypass: boolean): ModeVerdict {
  if (UNSAFE_MODES.has(mode) && !allowBypass) return { ok: false, reason: 'requester_unsafe_mode' };
  return { ok: true, warning: mode === 'auto' };
}

/** Can a local session in `mode` receive a delivery or invite now? Unknown → hold, never fail. */
export function recipientMode(mode: PermissionMode, allowBypass: boolean): ModeVerdict {
  if (mode === 'unknown') return { ok: false, hold: true };
  if (UNSAFE_MODES.has(mode) && !allowBypass) return { ok: false, reason: 'recipient_unsafe_mode' };
  return { ok: true, warning: mode === 'auto' };
}

/** Can a session in `mode` answer bridge_confirm? (dontAsk denies the prompt; the bridge maps it from the mode.) */
export const canConfirm = (mode: PermissionMode): boolean => !NO_CONFIRM_MODES.has(mode);

// ---------- §8.3 invite limits ----------
export interface InviteCounts { pendingByRequester: number; pendingForTarget: number; lastPairRefusalAt: number | null }
export interface InviteLimits { max_pending_per_remote: number; max_pending_per_target: number; cooldown_ms: number }

export function checkInviteLimits(c: InviteCounts, l: InviteLimits, now: number): { ok: true } | { ok: false; reason: 'rate_limited'; hint: string } {
  if (c.pendingByRequester >= l.max_pending_per_remote) return { ok: false, reason: 'rate_limited', hint: `at most ${l.max_pending_per_remote} pending invites per requester` };
  if (c.pendingForTarget >= l.max_pending_per_target) return { ok: false, reason: 'rate_limited', hint: `at most ${l.max_pending_per_target} pending invites per target` };
  if (c.lastPairRefusalAt !== null && now - c.lastPairRefusalAt < l.cooldown_ms) {
    const mins = Math.ceil((l.cooldown_ms - (now - c.lastPairRefusalAt)) / 60_000);
    return { ok: false, reason: 'rate_limited', hint: `cooldown after a decline or expiry; try again in ${mins} min` };
  }
  return { ok: true };
}
export const COOLDOWN_END_REASONS: readonly EndReason[] = ['declined', 'approval_expired', 'invite_expired'];

// ---------- §5 addressing ----------
export interface AddressCandidate { id: string; agent: AgentType; name: string; state: string; cwd: string | null }
export type Resolution =
  | { ok: true; id: string }
  | { ok: false; reason: 'recipient_gone' | 'recipient_ambiguous' | 'invalid_message'; candidates?: Array<{ address: string; short_id: string; folder?: string }> };

/**
 * Resolve `<agent>:<name>` among known participants. Gone participants are ignored.
 * A label that matches several → recipient_ambiguous with candidates; callers may then use `<agent>:<short_id>`.
 * Local callers see folder basenames; relay callers don't.
 */
export function resolveAddress(all: readonly AddressCandidate[], address: string, opts: { local: boolean; excludeId?: string }): Resolution {
  const a = parseAddress(address);
  if (!a) return { ok: false, reason: 'invalid_message' };
  const pool = all.filter((p) => p.agent === a.agent && p.state !== 'gone' && p.id !== opts.excludeId);
  let hits = pool.filter((p) => p.name === a.name);
  if (hits.length === 0) hits = pool.filter((p) => shortId(p.id) === a.name.toLowerCase());
  if (hits.length === 1) return { ok: true, id: hits[0]!.id };
  if (hits.length === 0) return { ok: false, reason: 'recipient_gone' };
  return {
    ok: false, reason: 'recipient_ambiguous',
    candidates: hits.map((p) => ({ address: `${p.agent}:${p.name}`, short_id: shortId(p.id), ...(opts.local && p.cwd ? { folder: basename(p.cwd) } : {}) })),
  };
}

/** Pick a unique name: `base`, `base-2`, `base-3`, … among non-gone participants of this agent. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`; const n = `${base.slice(0, LIMITS.nameChars - suffix.length)}${suffix}`;
    if (!taken.has(n)) return n;
  }
}
