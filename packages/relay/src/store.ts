// The Redis surface the relay uses (§13.4), behind a small interface: MemoryStore for tests and local runs,
// RedisStore (ioredis over TCP) for production. Keys are passed fully qualified; the caller adds the prefix.

export type StreamEntry = [id: string, fields: Record<string, string>];

export interface Store {
  get(key: string): Promise<string | null>;
  /** SET with optional PX and NX. Returns false only when NX blocked the write. */
  set(key: string, value: string, opts?: { pxMs?: number; nx?: boolean }): Promise<boolean>;
  del(key: string): Promise<number>;
  /** Delete only if the current value equals `value` (atomic). */
  delIfEquals(key: string, value: string): Promise<boolean>;
  /** INCRBY; sets PX on the first increment (when the result equals `by`). */
  incr(key: string, by?: number, pxMs?: number): Promise<number>;
  xadd(key: string, fields: Record<string, string>): Promise<string>;
  /** XADD and INCRBY counterKey n, atomically. */
  xaddCounted(key: string, fields: Record<string, string>, counterKey: string, n: number): Promise<string>;
  /** XDEL each id; DECRBY counterKey by the n of the ids actually removed, atomically. Returns how many were removed. */
  xdelCounted(key: string, entries: { id: string; n: number }[], counterKey: string): Promise<number>;
  /**
   * Presence claim (atomic): store `value` = "<rank>|<id>" with PX unless the key holds a value with a higher-or-equal
   * rank from someone else. Returns null when the caller holds the key afterwards, else the current holder's value.
   */
  claimNewest(key: string, value: string, rank: number, pxMs: number): Promise<string | null>;
  /** XRANGE with inclusive bounds ('-', '+', or ids; prefix '(' for exclusive start). */
  xrange(key: string, start: string, end: string, count?: number): Promise<StreamEntry[]>;
  xdel(key: string, ids: string[]): Promise<number>;
  xlen(key: string): Promise<number>;
  /** LPUSH then PEXPIRE. */
  pushExpire(key: string, value: string, ttlMs: number): Promise<void>;
  /** BLPOP on a dedicated short-lived connection; null on timeout. */
  blpop(key: string, timeoutMs: number): Promise<string | null>;
  publish(channel: string, message: string): Promise<void>;
  /** SUBSCRIBE on a dedicated connection; resolves once subscribed. Call the returned function to unsubscribe and close it. */
  subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>>;
  /** PSUBSCRIBE (glob `*`) on one dedicated connection; resolves once subscribed. The returned function closes it. */
  psubscribe(pattern: string, onMessage: (channel: string, message: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** Compare stream ids "ms-seq". */
export function cmpStreamId(a: string, b: string): number {
  const [am = 0, as = 0] = a.split('-').map(Number), [bm = 0, bs = 0] = b.split('-').map(Number);
  return am !== bm ? Math.sign(am - bm) : Math.sign(as - bs);
}

/** Rank part of a presence value "<rank>|<id>" (-1 if malformed). */
export function presenceRank(v: string): number { const m = /^(\d+)\|/.exec(v); return m ? Number(m[1]) : -1; }

const STREAM_ID_RE = /^\d+-\d+$/;
export const isStreamId = (s: unknown): s is string => typeof s === 'string' && STREAM_ID_RE.test(s);

interface Val { v: string; exp?: number }

/** In-process store with Redis semantics for the subset above. Shared by several relay instances in tests. */
export class MemoryStore implements Store {
  private kv = new Map<string, Val>();
  private lists = new Map<string, { items: string[]; exp?: number }>();
  private streams = new Map<string, { last: [number, number]; entries: StreamEntry[] }>();
  private subs = new Map<string, Set<(m: string) => void>>();
  private psubs = new Set<{ re: RegExp; fn: (c: string, m: string) => void }>();
  /** Test hook: number of commands executed (approximate Redis cost). */
  commands = 0;
  private waiters = new Map<string, Set<(v: string) => void>>();
  /** Test hook: drop publishes (simulates a lost wake). */
  dropPublishes = false;
  /** Test hook: count of open dedicated connections (blpop + subscribe). */
  openConnections = 0;
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  private live(key: string): Val | undefined {
    const e = this.kv.get(key);
    if (e && e.exp !== undefined && e.exp <= this.now()) { this.kv.delete(key); return undefined; }
    return e;
  }
  private list(key: string) {
    const l = this.lists.get(key);
    if (l && l.exp !== undefined && l.exp <= this.now()) { this.lists.delete(key); return undefined; }
    return l;
  }
  async get(key: string) { return this.live(key)?.v ?? null; }
  async set(key: string, value: string, opts: { pxMs?: number; nx?: boolean } = {}) {
    if (opts.nx && this.live(key)) return false;
    this.kv.set(key, opts.pxMs !== undefined ? { v: value, exp: this.now() + opts.pxMs } : { v: value });
    return true;
  }
  async del(key: string) {
    const had = (this.live(key) ? 1 : 0) + (this.list(key) ? 1 : 0) + (this.streams.has(key) ? 1 : 0);
    this.kv.delete(key); this.lists.delete(key); this.streams.delete(key);
    return had;
  }
  async delIfEquals(key: string, value: string) {
    if (this.live(key)?.v !== value) return false;
    this.kv.delete(key); return true;
  }
  async incr(key: string, by = 1, pxMs?: number) {
    const cur = Number(this.live(key)?.v ?? 0) + by;
    const prev = this.live(key);
    const exp = prev?.exp ?? (pxMs !== undefined && cur === by ? this.now() + pxMs : undefined);
    this.kv.set(key, exp !== undefined ? { v: String(cur), exp } : { v: String(cur) });
    return cur;
  }
  async xadd(key: string, fields: Record<string, string>) {
    let s = this.streams.get(key);
    if (!s) { s = { last: [0, 0], entries: [] }; this.streams.set(key, s); }
    const ms = this.now();
    const id: [number, number] = ms > s.last[0] ? [ms, 0] : [s.last[0], s.last[1] + 1];
    s.last = id;
    const sid = `${id[0]}-${id[1]}`;
    s.entries.push([sid, { ...fields }]);
    return sid;
  }
  async xaddCounted(key: string, fields: Record<string, string>, counterKey: string, n: number) {
    const id = await this.xadd(key, fields); await this.incr(counterKey, n); return id;
  }
  async xdelCounted(key: string, entries: { id: string; n: number }[], counterKey: string) {
    let removed = 0, bytes = 0;
    for (const e of entries) if ((await this.xdel(key, [e.id])) === 1) { removed++; bytes += e.n; }
    if (bytes) await this.incr(counterKey, -bytes);
    return removed;
  }
  async claimNewest(key: string, value: string, rank: number, pxMs: number) {
    const cur = this.live(key)?.v;
    if (cur === undefined || cur === value || presenceRank(cur) < rank) { this.kv.set(key, { v: value, exp: this.now() + pxMs }); return null; }
    return cur;
  }
  async xrange(key: string, start: string, end: string, count?: number) {
    const s = this.streams.get(key); if (!s) return [];
    const excl = start.startsWith('('); const st = excl ? start.slice(1) : start;
    const out: StreamEntry[] = [];
    for (const e of s.entries) {
      if (st !== '-') { const c = cmpStreamId(e[0], st); if (c < 0 || (excl && c === 0)) continue; }
      if (end !== '+' && cmpStreamId(e[0], end) > 0) break;
      out.push([e[0], { ...e[1] }]);
      if (count !== undefined && out.length >= count) break;
    }
    return out;
  }
  async xdel(key: string, ids: string[]) {
    const s = this.streams.get(key); if (!s) return 0;
    const set = new Set(ids); const before = s.entries.length;
    s.entries = s.entries.filter((e) => !set.has(e[0]));
    return before - s.entries.length;
  }
  async xlen(key: string) { return this.streams.get(key)?.entries.length ?? 0; }
  async pushExpire(key: string, value: string, ttlMs: number) {
    const w = this.waiters.get(key);
    if (w && w.size) { const [first] = w; w.delete(first!); first!(value); return; }
    const l = this.list(key) ?? { items: [] };
    l.items.unshift(value); l.exp = this.now() + ttlMs; this.lists.set(key, l);
  }
  async blpop(key: string, timeoutMs: number) {
    const l = this.list(key);
    if (l && l.items.length) { const v = l.items.shift()!; if (!l.items.length) this.lists.delete(key); return v; }
    this.openConnections++;
    try {
      return await new Promise<string | null>((resolve) => {
        let set = this.waiters.get(key); if (!set) { set = new Set(); this.waiters.set(key, set); }
        const fn = (v: string) => { clearTimeout(t); resolve(v); };
        const t = setTimeout(() => { set!.delete(fn); resolve(null); }, timeoutMs);
        set.add(fn);
      });
    } finally { this.openConnections--; }
  }
  async publish(channel: string, message: string) {
    if (this.dropPublishes) return;
    for (const fn of [...(this.subs.get(channel) ?? [])]) queueMicrotask(() => fn(message));
    for (const p of [...this.psubs]) if (p.re.test(channel)) queueMicrotask(() => p.fn(channel, message));
  }
  async psubscribe(pattern: string, onMessage: (c: string, m: string) => void) {
    const re = new RegExp('^' + pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    const entry = { re, fn: onMessage }; this.psubs.add(entry); this.openConnections++;
    let closed = false;
    return async () => { if (closed) return; closed = true; this.psubs.delete(entry); this.openConnections--; };
  }
  async subscribe(channel: string, onMessage: (m: string) => void) {
    let set = this.subs.get(channel); if (!set) { set = new Set(); this.subs.set(channel, set); }
    set.add(onMessage); this.openConnections++;
    let closed = false;
    return async () => { if (closed) return; closed = true; set!.delete(onMessage); this.openConnections--; };
  }
  async close() {}

  /** Test hook: everything stored, as one string (a "Redis dump"). */
  dump(): string {
    const parts: string[] = [];
    for (const [k, v] of this.kv) parts.push(`${k}=${v.v}`);
    for (const [k, l] of this.lists) parts.push(`${k}=${l.items.join(',')}`);
    for (const [k, s] of this.streams) for (const [id, f] of s.entries) parts.push(`${k} ${id} ${JSON.stringify(f)}`);
    return parts.join('\n');
  }
}
