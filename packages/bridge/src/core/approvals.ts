// In-memory approvals (§7.3, §7.6). Never persisted. Bound to (participant, registration epoch); a confirm must
// come from that binding with facts that match exactly (`sameFacts`). Expiry runs on the injected clock.
import { sameFacts, ulid, DIRECTION_FOR_KIND, type ApprovalFacts, type ApprovalKind, type ApprovalState } from '@agentbridge/protocol';
import type { Clock, TimerHandle } from '../clock.ts';

export interface StartContext {
  kind: 'start'; recipient_id: string; topic: string; first_message: string; turn_limit: number; continues: string | null;
  idempotency?: { epoch: number; key: string };
}
export interface AcceptContext { kind: 'accept'; conversation_id: string }
export interface ExtendContext { kind: 'extend'; conversation_id: string; new_limit: number }
export type ApprovalContext = StartContext | AcceptContext | ExtendContext;

export interface Approval {
  facts: ApprovalFacts;
  participant_id: string;
  epoch: number;
  state: ApprovalState;
  issued_at: number;
  /** null until the timer starts (accept: when the invite is handed off, §7.4 B3). */
  expires_at: number | null;
  context: ApprovalContext;
}

export type ConfirmCheck =
  | { ok: true; approval: Approval }
  | { ok: false; reason: 'unknown_approval' | 'approval_mismatch' };

export class ApprovalStore {
  private readonly clock: Clock;
  private readonly timeoutMs: () => number;
  private readonly onExpire: (a: Approval) => void;
  private readonly live = new Map<string, Approval>();
  private readonly timers = new Map<string, TimerHandle>();

  constructor(opts: { clock: Clock; timeoutMs: () => number; onExpire: (a: Approval) => void }) {
    this.clock = opts.clock; this.timeoutMs = opts.timeoutMs; this.onExpire = opts.onExpire;
  }

  issue(p: { kind: ApprovalKind; participant_id: string; epoch: number; peer: string; topic: string; turn_limit: number; context: ApprovalContext; startTimer?: boolean }): Approval {
    const facts: ApprovalFacts = { approval_id: ulid(this.clock.now()), kind: p.kind, peer: p.peer, direction: DIRECTION_FOR_KIND[p.kind], topic: p.topic, turn_limit: p.turn_limit };
    const a: Approval = { facts, participant_id: p.participant_id, epoch: p.epoch, state: 'issued', issued_at: this.clock.now(), expires_at: null, context: p.context };
    this.live.set(facts.approval_id, a);
    if (p.startTimer !== false) this.startTimer(facts.approval_id);
    return a;
  }

  /** Start (or restart) the expiry timer. */
  startTimer(id: string): void {
    const a = this.live.get(id); if (!a || a.state !== 'issued') return;
    this.clock.clearTimeout(this.timers.get(id));
    const ms = this.timeoutMs();
    a.expires_at = this.clock.now() + ms;
    this.timers.set(id, this.clock.setTimeout(() => this.expire(id), ms));
  }

  get(id: string): Approval | undefined { return this.live.get(id); }
  all(): Approval[] { return [...this.live.values()]; }
  find(pred: (a: Approval) => boolean): Approval | undefined { for (const a of this.live.values()) if (pred(a)) return a; return undefined; }

  /** §7.3: the caller must be the bound participant on the same epoch, and every fact must match exactly. */
  check(caller: { participant_id: string; epoch: number }, facts: ApprovalFacts): ConfirmCheck {
    const a = this.live.get(facts.approval_id);
    if (!a || a.state !== 'issued') return { ok: false, reason: 'unknown_approval' };
    if (a.participant_id !== caller.participant_id || a.epoch !== caller.epoch || !sameFacts(a.facts, facts)) return { ok: false, reason: 'approval_mismatch' };
    return { ok: true, approval: a };
  }

  /** Resolve and forget. Returns the approval if it was still issued. */
  resolve(id: string, state: Exclude<ApprovalState, 'issued'>): Approval | undefined {
    const a = this.live.get(id);
    if (!a || a.state !== 'issued') return undefined;
    a.state = state;
    this.live.delete(id);
    this.clock.clearTimeout(this.timers.get(id)); this.timers.delete(id);
    return a;
  }

  private expire(id: string): void {
    this.timers.delete(id);
    const a = this.resolve(id, 'expired');
    if (a) this.onExpire(a);
  }

  /** Shutdown: drop everything without callbacks (restart handling notifies from the event log). */
  clear(): void {
    for (const t of this.timers.values()) this.clock.clearTimeout(t);
    this.timers.clear(); this.live.clear();
  }
}
