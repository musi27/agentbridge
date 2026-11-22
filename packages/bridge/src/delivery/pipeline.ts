// Delivery pipeline (§6.3, §6.5, §12.4): durable queue in `deliveries`, per-participant ordering, adapter calls,
// retries for retryable failures, queue expiry. Policy decisions (holds) come from the engine via `gate`.
import { ulid, type Adapter, type DeliverOutcome, type OutboundItem, type ParticipantRef, type Reason } from '@agentbridge/protocol';
import type { Clock, TimerHandle } from '../clock.ts';
import type { DeliveryRow, Hold, ParticipantRow, Store } from '../db/store.ts';

export const RETRY_BACKOFF_MS = [2_000, 10_000, 30_000] as const;
/** When an adapter answers queued/rate_limited (its own cap), look again after this long. */
export const ADAPTER_CAP_RECHECK_MS = 60_000;

/** `participant` holds stop this participant's queue (ordering); `conversation` holds skip only that conversation. */
export type Gate =
  | { go: true }
  | { hold: Exclude<Hold, null>; scope: 'participant' | 'conversation'; reason?: Reason; recheckInMs?: number }
  | { fail: Reason; hint?: string };

export type Settled =
  | { state: 'handed_off' | 'delivered'; run_uuid?: string }
  | { state: 'queued' | 'held_by_host'; hold: Hold; reason?: Reason; hint?: string }
  | { state: 'failed'; reason: Reason; hint?: string }
  | { state: 'expired' };

export interface PipelineHooks {
  gate(d: DeliveryRow, p: ParticipantRow): Gate;
  adapterFor(p: ParticipantRow): Adapter | undefined;
  refFor(p: ParticipantRow): ParticipantRef;
  /** Optional last-moment rewrite (e.g. merging serialized Grok deliveries). Must return the row to send. */
  prepare?(d: DeliveryRow, p: ParticipantRow): DeliveryRow;
  onSettled(d: DeliveryRow, s: Settled, prev: DeliveryRow['state']): void;
  /** A hook threw; the pipeline keeps going (one bad item must not stop the service). */
  onError?(where: string, e: unknown): void;
}

export interface EnqueueInput {
  participant_id: string; conversation_id: string | null; item: Omit<OutboundItem, 'item_id'>; message_ids?: string[]; expires_at: number;
}

export class Pipeline {
  private readonly store: Store; private readonly clock: Clock; private readonly hooks: PipelineHooks;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly waiters = new Map<string, Array<(d: DeliveryRow) => void>>();
  private readonly recheck = new Map<string, TimerHandle>();
  private stopped = false;
  private readonly inFlight = new Set<string>();

  /** Is this delivery currently with the adapter? (Its payload must not change, e.g. by merging.) */
  isInFlight(id: string): boolean { return this.inFlight.has(id); }

  constructor(opts: { store: Store; clock: Clock; hooks: PipelineHooks }) {
    this.store = opts.store; this.clock = opts.clock; this.hooks = opts.hooks;
  }

  enqueue(e: EnqueueInput): DeliveryRow {
    const now = this.clock.now(); const id = ulid(now);
    const row: DeliveryRow = {
      id, participant_id: e.participant_id, conversation_id: e.conversation_id, item: JSON.stringify({ item_id: id, ...e.item }),
      message_ids: JSON.stringify(e.message_ids ?? []), state: 'accepted', hold: null, reason: null, hint: null, attempts: 0, run_uuid: null,
      created_at: now, updated_at: now, expires_at: e.expires_at,
    };
    this.store.insertDelivery(row);
    return row;
  }

  /** Enqueue, pump, and wait until this delivery settles (or `timeoutMs`). */
  async enqueueAndWait(e: EnqueueInput, timeoutMs = 15_000): Promise<DeliveryRow> {
    const row = this.enqueue(e);
    const p = this.waitFor(row.id, timeoutMs);
    this.kick(e.participant_id);
    return p;
  }

  waitFor(id: string, timeoutMs: number): Promise<DeliveryRow> {
    return new Promise((resolve) => {
      const cur = this.store.delivery(id);
      if (cur && cur.state !== 'accepted') { resolve(cur); return; }
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(this.store.delivery(id)!); } }, timeoutMs);
      t.unref?.();
      const list = this.waiters.get(id) ?? [];
      list.push((d) => { if (!done) { done = true; clearTimeout(t); resolve(d); } });
      this.waiters.set(id, list);
    });
  }

  /** Schedule a pump for one participant (coalesced; serial per participant). */
  kick(participantId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.chains.has(participantId)) { this.again.add(participantId); return this.chains.get(participantId)!; }
    const run = (async () => {
      try {
        do { this.again.delete(participantId); await this.pump(participantId); } while (this.again.has(participantId) && !this.stopped);
      } finally { this.chains.delete(participantId); }
    })();
    this.chains.set(participantId, run);
    return run;
  }

  kickAll(): void { for (const pid of new Set(this.store.pendingDeliveries().map((d) => d.participant_id))) void this.kick(pid); }

  /** Wait for all running pumps (tests, shutdown). */
  async idle(): Promise<void> { while (this.chains.size) await Promise.all([...this.chains.values()]); }

  stop(): void { this.stopped = true; for (const t of this.recheck.values()) this.clock.clearTimeout(t); this.recheck.clear(); }

  private update(d: DeliveryRow, patch: Partial<DeliveryRow>): DeliveryRow {
    const next = { ...d, ...patch, updated_at: this.clock.now() };
    this.store.updateDelivery(d.id, { ...patch, updated_at: next.updated_at });
    if (next.state !== 'accepted') { const ws = this.waiters.get(d.id); if (ws) { this.waiters.delete(d.id); for (const w of ws) w(next); } }
    return next;
  }

  /** Apply a settle from outside the pump (expiry, engine-driven failure). */
  settle(d: DeliveryRow, s: Settled): void {
    const prev = d.state;
    const patch: Partial<DeliveryRow> = s.state === 'queued' || s.state === 'held_by_host' ? { state: s.state, hold: s.hold, reason: s.reason ?? null, hint: s.hint ?? null }
      : s.state === 'failed' ? { state: 'failed', hold: null, reason: s.reason, hint: s.hint ?? null }
        : s.state === 'expired' ? { state: 'expired', hold: null, reason: 'queue_expired' }
          : { state: s.state, hold: null, reason: null, run_uuid: (s as { run_uuid?: string }).run_uuid ?? null };
    const next = this.update(d, patch);
    try { this.hooks.onSettled(next, s, prev); } catch (e) { this.reportError('onSettled', e); }
  }

  private reportError(where: string, e: unknown): void { try { this.hooks.onError?.(where, e); } catch { /* logging failed */ } }

  private scheduleRecheck(participantId: string, ms: number): void {
    this.clock.clearTimeout(this.recheck.get(participantId));
    this.recheck.set(participantId, this.clock.setTimeout(() => { this.recheck.delete(participantId); void this.kick(participantId); }, ms));
  }

  private async pump(participantId: string): Promise<void> {
    const p = this.store.participant(participantId);
    if (!p) return;
    const skipConv = new Set<string>();
    for (const row0 of this.store.pendingDeliveries(participantId)) {
      if (this.stopped) return;
      let row = this.store.delivery(row0.id);
      if (!row || !['accepted', 'queued', 'held_by_host'].includes(row.state)) continue;
      if (row.conversation_id && skipConv.has(row.conversation_id)) { if (row.state === 'accepted') this.settle(row, { state: 'queued', hold: 'serialized' }); continue; }
      if (row.hold === 'retry' && row.updated_at + (RETRY_BACKOFF_MS[row.attempts - 1] ?? 0) > this.clock.now()) {
        this.holdRest(participantId, row, 'retry'); return;
      }
      let g: Gate;
      try { g = this.hooks.gate(row, p); }
      catch (e) { this.reportError('gate', e); g = { hold: 'retry', scope: 'participant', recheckInMs: 30_000 }; }
      if ('fail' in g) { this.settle(row, { state: 'failed', reason: g.fail, ...(g.hint ? { hint: g.hint } : {}) }); continue; }
      if ('hold' in g) {
        if (g.recheckInMs !== undefined) this.scheduleRecheck(participantId, g.recheckInMs);
        if (row.state !== 'queued' || row.hold !== g.hold) this.settle(row, { state: 'queued', hold: g.hold, ...(g.reason ? { reason: g.reason } : {}) });
        if (g.scope === 'conversation' && row.conversation_id) { skipConv.add(row.conversation_id); continue; }
        this.holdRest(participantId, row, g.hold, g.reason); return;
      }
      const adapter = this.hooks.adapterFor(p);
      if (!adapter) { this.settle(row, { state: 'queued', hold: 'closed' }); this.holdRest(participantId, row, 'closed'); return; }
      if (this.hooks.prepare) { try { row = this.hooks.prepare(row, p); } catch (e) { this.reportError('prepare', e); } }
      let out: DeliverOutcome;
      this.inFlight.add(row.id);
      try { out = await adapter.deliver(JSON.parse(row.item) as OutboundItem, this.hooks.refFor(p)); }
      catch (e) { out = { status: 'failed', reason: 'host_refused', hint: (e as Error).message, retryable: true }; }
      finally { this.inFlight.delete(row.id); }
      if (this.stopped) return; // shut down while the adapter was working; the row is retried on next start
      row = this.store.delivery(row.id)!;
      const attempts = row.attempts + 1;
      this.store.updateDelivery(row.id, { attempts }); row = { ...row, attempts };
      if (out.status === 'delivered' || out.status === 'handed_off') { this.settle(row, { state: out.status, ...(out.run_uuid ? { run_uuid: out.run_uuid } : {}) }); continue; }
      if (out.status === 'queued' && out.reason === 'rate_limited') {
        // the adapter's own cap (Grok backstop, §6.5): hold as 'cap' and look again later; never dropped
        this.settle(row, { state: 'queued', hold: 'cap', reason: 'rate_limited', ...(out.hint ? { hint: out.hint } : {}) });
        this.scheduleRecheck(participantId, ADAPTER_CAP_RECHECK_MS);
        this.holdRest(participantId, row, 'cap'); return;
      }
      if (out.status === 'queued' || out.status === 'held_by_host') {
        this.settle(row, { state: out.status, hold: 'closed', ...(out.reason ? { reason: out.reason } : {}), ...(out.hint ? { hint: out.hint } : {}) });
        this.holdRest(participantId, row, 'closed'); return;
      }
      const f = out as Extract<DeliverOutcome, { status: 'failed' }>;
      if (f.retryable && attempts <= RETRY_BACKOFF_MS.length) {
        const wait = RETRY_BACKOFF_MS[attempts - 1]!;
        this.settle(row, { state: 'queued', hold: 'retry', reason: f.reason, ...(f.hint ? { hint: f.hint } : {}) });
        this.scheduleRecheck(participantId, wait);
        this.holdRest(participantId, row, 'retry'); return;
      }
      this.settle(row, { state: 'failed', reason: f.reason, ...(f.hint ? { hint: f.hint } : {}) });
    }
  }

  /** Keep later deliveries behind a participant-scope hold (ordering) and release their waiters. */
  private holdRest(participantId: string, blocker: DeliveryRow, hold: Exclude<Hold, null>, reason?: Reason): void {
    for (const r of this.store.pendingDeliveries(participantId)) {
      if (r.id === blocker.id || r.state !== 'accepted') continue;
      this.settle(r, { state: 'queued', hold, ...(reason ? { reason } : {}) });
    }
  }

  /** Expire queued deliveries past `expires_at` (§6.5 queue expiry). */
  sweep(): DeliveryRow[] {
    const now = this.clock.now(); const out: DeliveryRow[] = [];
    // never expire a delivery that is with the adapter right now; its outcome settles it
    for (const d of this.store.pendingDeliveries()) if (d.expires_at <= now && !this.inFlight.has(d.id)) { this.settle(d, { state: 'expired' }); out.push(d); }
    return out;
  }
}
