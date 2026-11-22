// Production Store: ioredis over TCP (Upstash). One shared command connection per instance; BLPOP and SUBSCRIBE get
// their own short-lived connections, closed as soon as they finish (1,024 FDs per Vercel instance, §13.4).
import { Redis } from 'ioredis';
import type { Store, StreamEntry } from './store.ts';

const DEL_IF_EQUALS = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const INCR_PX = "local v = redis.call('incrby', KEYS[1], ARGV[1]); if v == tonumber(ARGV[1]) and tonumber(ARGV[2]) > 0 then redis.call('pexpire', KEYS[1], ARGV[2]) end; return v";

const XADD_COUNTED = "local id = redis.call('xadd', KEYS[1], '*', unpack(ARGV, 2)); redis.call('incrby', KEYS[2], ARGV[1]); return id";
const XDEL_COUNTED = "local removed, bytes = 0, 0; for i = 1, #ARGV, 2 do if redis.call('xdel', KEYS[1], ARGV[i]) == 1 then removed = removed + 1; bytes = bytes + tonumber(ARGV[i + 1]) end end; if bytes > 0 then redis.call('decrby', KEYS[2], bytes) end; return removed";
const CLAIM_NEWEST = "local cur = redis.call('get', KEYS[1]); local r = cur and tonumber(string.match(cur, '^(%d+)|')) or nil; if (not cur) or cur == ARGV[1] or r == nil or r < tonumber(ARGV[2]) then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[3]); return false end; return cur";

const toFields = (arr: string[]): Record<string, string> => {
  const o: Record<string, string> = {};
  for (let i = 0; i + 1 < arr.length; i += 2) o[arr[i]!] = arr[i + 1]!;
  return o;
};

export class RedisStore implements Store {
  private cmd: Redis;
  private url: string;
  private name: string;
  constructor(url: string, name = 'relay') {
    this.url = url; this.name = name;
    this.cmd = this.open('cmd');
  }
  private open(role: string): Redis {
    return new Redis(this.url, { maxRetriesPerRequest: 2, connectionName: `${this.name}-${role}`, enableReadyCheck: true });
  }
  async get(key: string) { return this.cmd.get(key); }
  async set(key: string, value: string, opts: { pxMs?: number; nx?: boolean } = {}) {
    const r = opts.pxMs !== undefined
      ? (opts.nx ? await this.cmd.set(key, value, 'PX', opts.pxMs, 'NX') : await this.cmd.set(key, value, 'PX', opts.pxMs))
      : (opts.nx ? await this.cmd.set(key, value, 'NX') : await this.cmd.set(key, value));
    return r === 'OK';
  }
  async del(key: string) { return this.cmd.del(key); }
  async delIfEquals(key: string, value: string) { return (await this.cmd.eval(DEL_IF_EQUALS, 1, key, value)) === 1; }
  async incr(key: string, by = 1, pxMs = 0) { return Number(await this.cmd.eval(INCR_PX, 1, key, String(by), String(pxMs))); }
  async xadd(key: string, fields: Record<string, string>) {
    const id = await this.cmd.xadd(key, '*', ...Object.entries(fields).flat());
    if (!id) throw new Error('xadd failed');
    return id;
  }
  async xaddCounted(key: string, fields: Record<string, string>, counterKey: string, n: number) {
    return String(await this.cmd.eval(XADD_COUNTED, 2, key, counterKey, String(n), ...Object.entries(fields).flat()));
  }
  async xdelCounted(key: string, entries: { id: string; n: number }[], counterKey: string) {
    if (!entries.length) return 0;
    return Number(await this.cmd.eval(XDEL_COUNTED, 2, key, counterKey, ...entries.flatMap((e) => [e.id, String(e.n)])));
  }
  async claimNewest(key: string, value: string, rank: number, pxMs: number) {
    const r = await this.cmd.eval(CLAIM_NEWEST, 1, key, value, String(rank), String(pxMs));
    return typeof r === 'string' ? r : null;
  }
  async xrange(key: string, start: string, end: string, count?: number): Promise<StreamEntry[]> {
    const r = count !== undefined ? await this.cmd.xrange(key, start, end, 'COUNT', count) : await this.cmd.xrange(key, start, end);
    return r.map(([id, f]) => [id, toFields(f)]);
  }
  async xdel(key: string, ids: string[]) { return ids.length ? this.cmd.xdel(key, ...ids) : 0; }
  async xlen(key: string) { return this.cmd.xlen(key); }
  async pushExpire(key: string, value: string, ttlMs: number) { await this.cmd.multi().lpush(key, value).pexpire(key, ttlMs).exec(); }
  async blpop(key: string, timeoutMs: number) {
    const c = this.open('blpop');
    try {
      const r = await c.blpop(key, Math.max(0.1, timeoutMs / 1000));
      return r?.[1] ?? null;
    } finally { c.disconnect(); }
  }
  async publish(channel: string, message: string) { await this.cmd.publish(channel, message); }
  async subscribe(channel: string, onMessage: (m: string) => void) {
    const c = this.open('sub');
    c.on('message', (ch: string, m: string) => { if (ch === channel) onMessage(m); });
    c.on('error', () => {}); // reconnects on its own; errors surface via the 10 s poll on the command connection
    try { await c.subscribe(channel); } catch (e) { c.disconnect(); throw e; }
    let closed = false;
    return async () => { if (closed) return; closed = true; c.disconnect(); };
  }
  async psubscribe(pattern: string, onMessage: (c: string, m: string) => void) {
    const c = this.open('psub');
    c.on('pmessage', (_p: string, ch: string, m: string) => onMessage(ch, m));
    c.on('error', () => {});
    try { await c.psubscribe(pattern); } catch (e) { c.disconnect(); throw e; }
    let closed = false;
    return async () => { if (closed) return; closed = true; c.disconnect(); };
  }
  async close() { this.cmd.disconnect(); }
}
