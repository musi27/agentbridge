// One pattern SUBSCRIBE (`<prefix>user:*:wake`) per relay instance, shared by all its sockets (§13.4): halves the Redis
// connections per bridge socket and dispatches each wake to the sockets of that user only.
import type { Store } from './store.ts';

type Handler = (message: string) => void;

export class WakeHub {
  private handlers = new Map<string, Set<Handler>>();
  private unsub: Promise<() => Promise<void>> | null = null;
  private count = 0;
  private store: Store;
  private prefix: string;
  private re: RegExp;
  constructor(store: Store, prefix: string) {
    this.store = store; this.prefix = prefix;
    this.re = /^user:([a-z2-7]{26}):wake$/;
  }
  private glob(): string { return `${this.prefix.replace(/[*?[\]\\]/g, '\\$&')}user:*:wake`; }

  private dispatch(channel: string, message: string): void {
    if (!channel.startsWith(this.prefix)) return;
    const m = this.re.exec(channel.slice(this.prefix.length));
    if (!m) return;
    for (const fn of [...(this.handlers.get(m[1]!) ?? [])]) { try { fn(message); } catch { /* one socket's error stays its own */ } }
  }

  /** Register a handler for one user's wakes; resolves once the shared subscription is active. Call the result to remove it. */
  async add(userId: string, fn: Handler): Promise<() => Promise<void>> {
    let set = this.handlers.get(userId);
    if (!set) { set = new Set(); this.handlers.set(userId, set); }
    set.add(fn); this.count++;
    if (!this.unsub) {
      const p = this.store.psubscribe(this.glob(), (c, m) => this.dispatch(c, m));
      this.unsub = p;
      p.catch(() => { if (this.unsub === p) this.unsub = null; });
    }
    try { await this.unsub; } catch (e) { await this.remove(userId, fn); throw e; }
    let removed = false;
    return async () => { if (removed) return; removed = true; await this.remove(userId, fn); };
  }

  private async remove(userId: string, fn: Handler): Promise<void> {
    const set = this.handlers.get(userId);
    if (!set?.delete(fn)) return;
    this.count--;
    if (!set.size) this.handlers.delete(userId);
    if (this.count === 0 && this.unsub) { // no sockets left on this instance: release the Redis connection
      const p = this.unsub; this.unsub = null;
      try { await (await p)(); } catch { /* already gone */ }
    }
  }

  get sockets(): number { return this.count; }
}
