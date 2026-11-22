// POST /v1/pending: the bridge's on-demand idle check (§13.2). Signed, read-only, rate-limited; with a warm key cache it
// costs 3 Redis commands (INCR rate, XLEN, XRANGE COUNT 1) and has no other side effects.
import { LIMITS, RELAY_PENDING_HEADERS, relayPendingMessage, zUserId } from '@agentbridge/protocol';
import { getUser, type Ctx } from './core.ts';
import { ed25519Verify, fromB64 } from './crypto.ts';
import type { HttpReply } from './mcp.ts';

const TS_WINDOW_MS = 60_000;
const KEY_CACHE_MS = 60_000; // a rotated key stops working here within this, on other instances (metadata-only endpoint)

const fail = (status: number, code: string, message: string): HttpReply => ({ status, body: { error: { code, message } } });

async function registeredKey(x: Ctx, u: string): Promise<Buffer | null> {
  const hit = x.pubkeys.get(u);
  if (hit && x.now() - hit.at < KEY_CACHE_MS) return fromB64(hit.pub, 32);
  const user = await getUser(x, u);
  if (!user) return null;
  if (x.pubkeys.size > 10_000) x.pubkeys.clear();
  x.pubkeys.set(u, { pub: user.ed25519_pub, at: x.now() });
  return fromB64(user.ed25519_pub, 32);
}

export async function handlePending(x: Ctx, method: string, headers: Record<string, string | string[] | undefined>, requestHost: string | undefined): Promise<HttpReply> {
  if (method !== 'POST') return { status: 405, headers: { allow: 'POST' } };
  const h = (n: string) => { const v = headers[n]; return Array.isArray(v) ? v[0] : v; };
  const u = h(RELAY_PENDING_HEADERS.userId), tsRaw = h(RELAY_PENDING_HEADERS.ts), sig = fromB64(h(RELAY_PENDING_HEADERS.sig), 64);
  const ts = Number(tsRaw);
  if (!u || !zUserId.safeParse(u).success || !tsRaw || !/^\d{1,16}$/.test(tsRaw) || !sig) return fail(400, 'invalid_message', 'Missing or malformed signature headers.');
  if (Math.abs(x.now() - ts) > TS_WINDOW_MS) return fail(401, 'unauthorized', 'Timestamp outside ±60 s; check the clock.');
  const pub = await registeredKey(x, u);
  if (!pub || !ed25519Verify(pub, relayPendingMessage(x.host ?? requestHost ?? '', ts), sig)) return fail(401, 'unauthorized', 'Bad signature.');
  if ((await x.store.incr(x.k.pendingRate(u, Math.floor(x.now() / 60_000)), 1, 120_000)) > LIMITS.relayPendingPerMinute) {
    return fail(429, 'rate_limited', `At most ${LIMITS.relayPendingPerMinute} pending checks per minute.`);
  }
  const [count, first] = await Promise.all([x.store.xlen(x.k.inbox(u)), x.store.xrange(x.k.inbox(u), '-', '+', 1)]);
  const oldestMs = first[0] ? Math.max(0, x.now() - Number(first[0][0].split('-')[0])) : null;
  return { status: 200, body: { pending: count, oldest_ms: count ? oldestMs : null } };
}
