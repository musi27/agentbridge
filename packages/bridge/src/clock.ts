// Injectable time source so every timer rule (§6.5, §7.6, §8.3) is testable without waiting.
export interface TimerHandle { readonly id: number }
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle | null | undefined): void;
}

export const systemClock: Clock = (() => {
  let next = 1; const live = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = next++;
      const t = setTimeout(() => { live.delete(id); fn(); }, Math.min(ms, 2 ** 31 - 1));
      t.unref?.(); live.set(id, t); return { id };
    },
    clearTimeout(h) { if (!h) return; const t = live.get(h.id); if (t) { clearTimeout(t); live.delete(h.id); } },
  };
})();

/** Manual clock for tests: `advance(ms)` fires due timers in time order. */
export class FakeClock implements Clock {
  private t: number; private next = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  constructor(start = Date.UTC(2026, 10, 22, 12, 0, 0)) { this.t = start; }
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): TimerHandle { const id = this.next++; this.timers.set(id, { at: this.t + Math.max(0, ms), fn }); return { id }; }
  clearTimeout(h: TimerHandle | null | undefined): void { if (h) this.timers.delete(h.id); }
  pending(): number { return this.timers.size; }
  /** Advance time, firing timers (and letting their async work settle) in order. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let best: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) if (e[1].at <= end && (!best || e[1].at < best[1].at || (e[1].at === best[1].at && e[0] < best[0]))) best = e;
      if (!best) break;
      this.timers.delete(best[0]); this.t = Math.max(this.t, best[1].at); best[1].fn();
      await settle();
    }
    this.t = end; await settle();
  }
}

/** Let queued promise callbacks and immediates run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}
