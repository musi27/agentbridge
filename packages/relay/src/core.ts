// Relay state shared by the HTTP and WebSocket sides: config, keys, records, stream ingest/ack/trim (§13.3–13.5).
import { createHash, timingSafeEqual } from 'node:crypto';
import { LIMITS, RELAY_STREAM_FORMAT } from '@agentbridge/protocol';
import type { Store, StreamEntry } from './store.ts';
import { WakeHub } from './wake-hub.ts';

export interface RelayConfig {
  store: Store;
  /** Host the bridge signs in the handshake (`relayAuthMessage`). Defaults to the request's Host header (dev only). */
  host?: string;
  /** Prefix for every Redis key, e.g. `relaydev:`. */
  keyPrefix?: string;
  responseWaitMs?: number;
  pollMs?: number;
  overlapMs?: number;
  /** Held-entry age limit (default and max 7 d, §13.4). */
  queueExpiryMs?: number;
  /** Seconds a res key lives (default 30 s). */
  resTtlMs?: number;
  /** ws ping + `wake` frame interval; a socket missing two pongs is terminated (default LIMITS.relayHeartbeatMs). */
  heartbeatMs?: number;
  now?: () => number;
  /** Test only: simulate the platform's socket cutoff (Hobby ≈ 315 s), going deaf `deafBeforeCutoffMs` earlier (M0 V10). */
  cutoffMs?: number;
  deafBeforeCutoffMs?: number;
  /** Optional metadata-only log sink (never content). */
  log?: (event: string, meta: Record<string, string | number | boolean | undefined>) => void;
}

export interface Ctx {
  store: Store; host: string | undefined; responseWaitMs: number; pollMs: number; overlapMs: number; queueExpiryMs: number;
  resTtlMs: number; heartbeatMs: number; now: () => number; cutoffMs: number | undefined; deafBeforeCutoffMs: number;
  log: NonNullable<RelayConfig['log']>; k: ReturnType<typeof keys>; hub: WakeHub; pubkeys: Map<string, { pub: string; at: number }>;
}

export function makeCtx(c: RelayConfig): Ctx {
  return {
    store: c.store, host: c.host, responseWaitMs: c.responseWaitMs ?? LIMITS.relayResponseWaitMs, pollMs: c.pollMs ?? LIMITS.relayPollMs,
    overlapMs: c.overlapMs ?? LIMITS.relayOverlapMs, queueExpiryMs: Math.min(c.queueExpiryMs ?? LIMITS.queueExpiryMs, LIMITS.queueExpiryMs),
    resTtlMs: c.resTtlMs ?? 30_000, heartbeatMs: c.heartbeatMs ?? LIMITS.relayHeartbeatMs, now: c.now ?? Date.now, cutoffMs: c.cutoffMs, deafBeforeCutoffMs: c.deafBeforeCutoffMs ?? 0,
    log: c.log ?? (() => {}), k: keys(c.keyPrefix ?? ''), hub: new WakeHub(c.store, c.keyPrefix ?? ''), pubkeys: new Map(),
  };
}

export function keys(p: string) {
  return {
    user: (u: string) => `${p}user:${u}`,
    bot: (u: string, b: string) => `${p}user:${u}:bot:${b}`,
    botCount: (u: string) => `${p}user:${u}:botcount`,
    inbox: (u: string) => `${p}user:${u}:inbox`,
    heldBytes: (u: string) => `${p}user:${u}:held_bytes`,
    expired: (u: string) => `${p}user:${u}:expired`,
    wake: (u: string) => `${p}user:${u}:wake`,
    conn: (u: string) => `${p}user:${u}:conn`,
    res: (u: string, reqId: string) => `${p}res:${u}:${reqId}`,
    nonce: (n: string) => `${p}nonce:${n}`,
    rate: (u: string, minute: number) => `${p}rl:${u}:${minute}`,
    pendingRate: (u: string, minute: number) => `${p}rlp:${u}:${minute}`,
    ipCreations: (ipHash: string, day: number) => `${p}ipc:${ipHash}:${day}`,
  };
}

export interface UserRecord { ed25519_pub: string; x25519_pub: string; created_at: number; rotated_at?: number }
export interface BotRecord { token_hash: string; discovery: 'names' | 'none'; created_at: number }

const parse = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };
export const getUser = async (x: Ctx, u: string) => parse<UserRecord>(await x.store.get(x.k.user(u)));
export const putUser = (x: Ctx, u: string, r: UserRecord, nx = false) => x.store.set(x.k.user(u), JSON.stringify(r), { nx });
export const getBot = async (x: Ctx, u: string, b: string) => parse<BotRecord>(await x.store.get(x.k.bot(u, b)));
export const putBot = (x: Ctx, u: string, b: string, r: BotRecord) => x.store.set(x.k.bot(u, b), JSON.stringify(r));

export function tokenMatches(token: string, tokenHashHex: string): boolean {
  const a = createHash('sha256').update(token, 'utf8').digest();
  const b = Buffer.from(tokenHashHex, 'hex');
  return b.length === a.length && timingSafeEqual(a, b);
}

/** Stream fields. `s` is the sealed call; `m`/`c` are metadata kept in clear so trims can produce expiry records. */
export interface EntryMeta { reqId: string; method: string; conversationId?: string | undefined; deadline: number; sealed: string }

const MAX_SEQ = Number.MAX_SAFE_INTEGER;
export const nextStreamId = (id: string): string => { const [ms = '0', seq = '0'] = id.split('-'); return `${ms}-${Number(seq) + 1}`; };

export async function appendEntry(x: Ctx, u: string, e: EntryMeta): Promise<string> {
  const n = Buffer.byteLength(e.sealed);
  return x.store.xaddCounted(x.k.inbox(u), {
    v: String(RELAY_STREAM_FORMAT), r: e.reqId, m: e.method, c: e.conversationId ?? '', d: String(e.deadline), s: e.sealed, n: String(n),
  }, x.k.heldBytes(u), n);
}

const removeEntries = (x: Ctx, u: string, entries: StreamEntry[]): Promise<number> =>
  entries.length ? x.store.xdelCounted(x.k.inbox(u), entries.map(([id, f]) => ({ id, n: Number(f.n ?? 0) })), x.k.heldBytes(u)) : Promise.resolve(0);

const ownFormat = (f: Record<string, string>) => f.v === undefined || Number(f.v) === RELAY_STREAM_FORMAT;

/** Delete every entry of this stream format <= cursor (bridge ack, §13.4). Other formats are left for their deployment. */
export async function ackThrough(x: Ctx, u: string, cursor: string): Promise<number> {
  let total = 0, start = '-';
  for (;;) {
    const batch = await x.store.xrange(x.k.inbox(u), start, cursor, 500);
    if (!batch.length) return total;
    total += await removeEntries(x, u, batch.filter(([, f]) => ownFormat(f)));
    if (batch.length < 500) return total;
    start = nextStreamId(batch[batch.length - 1]![0]);
  }
}

export async function removeEntry(x: Ctx, u: string, id: string): Promise<void> {
  await removeEntries(x, u, await x.store.xrange(x.k.inbox(u), id, id, 1));
}

/** Delete expiry records <= cursor once the bridge has acked them (`expiry_ack`). */
export async function ackExpiry(x: Ctx, u: string, cursor: string): Promise<number> {
  const recs = await x.store.xrange(x.k.expired(u), '-', cursor, 1000);
  return recs.length ? x.store.xdel(x.k.expired(u), recs.map((r) => r[0])) : 0;
}

/** Trim entries older than queueExpiryMs; each becomes an expiry record for the bridge (§13.4). */
export async function trimExpired(x: Ctx, u: string): Promise<number> {
  const cutoff = x.now() - x.queueExpiryMs;
  if (cutoff <= 0) return 0;
  let total = 0;
  for (;;) {
    const old = await x.store.xrange(x.k.inbox(u), '-', `${cutoff - 1}-${MAX_SEQ}`, 200);
    if (!old.length) return total;
    for (const [, f] of old) await x.store.xadd(x.k.expired(u), { r: f.r ?? '', m: f.m ?? '', c: f.c ?? '' });
    total += await removeEntries(x, u, old);
    if (old.length < 200) return total;
  }
}

export async function heldUsage(x: Ctx, u: string): Promise<{ entries: number; bytes: number }> {
  const [entries, bytes] = await Promise.all([x.store.xlen(x.k.inbox(u)), x.store.get(x.k.heldBytes(u))]);
  return { entries, bytes: Math.max(0, Number(bytes ?? 0)) };
}
