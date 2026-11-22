// In-memory adapter for tests. Records every OutboundItem per participant; outcomes are scriptable per participant
// or per call. It can pose as any agent type (e.g. 'grok' to exercise Grok-side bridge rules without a webhook).
import type { Adapter, AdapterCapabilities, AgentType, DeliverOutcome, DoctorCheck, OutboundItem, ParticipantRef } from '@agentbridge/protocol';

export type OutcomeFn = (item: OutboundItem, to: ParticipantRef) => DeliverOutcome | Promise<DeliverOutcome>;

export interface FakeAdapterOptions {
  agent?: AgentType;
  name?: string;
  capabilities?: Partial<AdapterCapabilities>;
  /** Default outcome for every delivery (default: delivered). */
  outcome?: OutcomeFn;
}

export interface Received { item: OutboundItem; to: ParticipantRef; outcome: DeliverOutcome; at: number }

export class FakeAdapter implements Adapter {
  readonly agent: AgentType;
  readonly name: string;
  private readonly caps: AdapterCapabilities;
  private defaultOutcome: OutcomeFn;
  private readonly perParticipant = new Map<string, OutcomeFn>();
  private readonly once: OutcomeFn[] = [];
  /** Every delivery attempt, in order (including failed ones). */
  readonly log: Received[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(opts: FakeAdapterOptions = {}) {
    this.agent = opts.agent ?? 'fake';
    this.name = opts.name ?? `fake-${this.agent}`;
    this.caps = { receive: 'memory', native_confirm: this.agent !== 'grok', delivery_confirmable: true, ...opts.capabilities };
    this.defaultOutcome = opts.outcome ?? (() => ({ status: 'delivered' }));
  }

  describe(): { name: string; version: string; agent: AgentType } { return { name: this.name, version: '0.1.0', agent: this.agent }; }
  capabilities(): AdapterCapabilities { return { ...this.caps }; }
  async doctor(): Promise<DoctorCheck[]> { return [{ id: 'fake', ok: true, detail: 'in-memory adapter' }]; }

  /** Script outcomes: for everyone, for one participant, or for the next call only. */
  setOutcome(fn: OutcomeFn): void { this.defaultOutcome = fn; }
  setParticipantOutcome(participantId: string, fn: OutcomeFn | null): void { if (fn) this.perParticipant.set(participantId, fn); else this.perParticipant.delete(participantId); }
  nextOutcome(fn: OutcomeFn): void { this.once.push(fn); }

  async deliver(item: OutboundItem, to: ParticipantRef): Promise<DeliverOutcome> {
    const fn = this.once.shift() ?? this.perParticipant.get(to.participant_id) ?? this.defaultOutcome;
    const outcome = await fn(structuredClone(item), to);
    this.log.push({ item: structuredClone(item), to, outcome, at: Date.now() });
    for (const l of this.listeners) l();
    return outcome;
  }

  /** Items that reached a participant (delivered or handed off). */
  inbox(participantId: string): OutboundItem[] {
    return this.log.filter((r) => r.to.participant_id === participantId && (r.outcome.status === 'delivered' || r.outcome.status === 'handed_off')).map((r) => r.item);
  }
  /** All notice codes a participant received, in order. */
  noticeCodes(participantId: string): string[] { return this.inbox(participantId).flatMap((i) => i.notices.map((n) => n.code)); }
  /** All message bodies a participant received, in order. */
  bodies(participantId: string): string[] { return this.inbox(participantId).flatMap((i) => i.messages.map((m) => m.body)); }
  clear(): void { this.log.length = 0; }

  /** Resolve when `pred` holds (checked after each delivery), or reject after `timeoutMs`. */
  waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> { // event-driven: resolves as soon as pred holds
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.listeners.delete(check); reject(new Error('FakeAdapter.waitFor timed out')); }, timeoutMs);
      const check = (): void => { if (pred()) { clearTimeout(t); this.listeners.delete(check); resolve(); } };
      this.listeners.add(check);
    });
  }
}
