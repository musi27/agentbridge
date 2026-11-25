// On-demand connection (§13.2): idle pending checks, activity window, daily cap, CLI ensureConnected, /v1/pending auth,
// and the shared per-instance wake subscriber (§13.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, RELAY_PENDING_HEADERS, relayPendingMessage } from '@agentbridge/protocol';
import { MemoryStore } from '../src/store.ts';
import { b64, ed25519Signer } from '../src/crypto.ts';
import type { RelayClient, RelayClientOptions } from '../src/client.ts';
import { callTool, client, newBot, newIdentity, register, registerBot, sleep, startRelay, until, type Identity, type Running } from './helpers.ts';

const CONV = '01JD0000000000000000000000';
const fast: Partial<RelayClientOptions> = { mode: 'on_demand', pendingPollMs: 80, activeWindowMs: 300, ensureGraceMs: 60 };

async function onDemandSetup(extra: Partial<RelayClientOptions> = {}, store?: MemoryStore) {
  const r = await startRelay({}, store);
  const id = await newIdentity(); await register(r.url, id);
  const calls: string[] = [];
  const c = client(r.url, id, async (call) => { calls.push(String(call.call.params.body ?? call.call.method)); return { result: { status: 'ok' } }; }, { ...fast, ...extra });
  const events: string[] = [];
  for (const e of ['ready', 'idle', 'disconnected', 'cap_reached']) c.on(e, () => events.push(e));
  c.on('error', () => {});
  await c.start();
  const bot = newBot();
  await registerBot(c, bot.botId, bot.token); // CLI-style control: connects just for the call
  await until(() => !c.connected, 2000); // grace over -> idle again
  return { r, id, c, bot, calls, events, async stop() { await c.stop(); await r.stop(); } };
}
const conn = (r: Running, id: Identity) => r.store.get(`t:user:${id.userId}:conn`);

test('on_demand: starts idle; a control call connects only for the call plus a short grace', async () => {
  const s = await onDemandSetup();
  try {
    assert.ok(s.events.includes('ready'));
    assert.equal(s.c.connected, false);
    await until(async () => (await conn(s.r, s.id)) === null);
  } finally { await s.stop(); }
});

test('on_demand: an idle client picks up a held write within about one pending interval, then idles again', async () => {
  const s = await onDemandSetup();
  try {
    await until(async () => (await conn(s.r, s.id)) === null);
    const t0 = Date.now();
    const w = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: 'while-idle' });
    assert.equal(w.data.status, 'held_relay');
    await until(() => s.calls.includes('while-idle'), 3000);
    // Only the pending check (every 80 ms here) can pick it up while idle; the bound leaves room for a loaded runner.
    assert.ok(Date.now() - t0 < 80 + 1000, `picked up after ${Date.now() - t0} ms`);
    // a call from Grok is activity: connected for activeWindowMs, then idle
    await until(() => !s.c.connected, 2000);
    assert.equal(await s.r.store.xlen(`t:user:${s.id.userId}:inbox`), 0);
  } finally { await s.stop(); }
});

test('on_demand: reads while idle return bridge_offline', async () => {
  const s = await onDemandSetup();
  try {
    await until(async () => (await conn(s.r, s.id)) === null);
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_list_conversations', {});
    assert.equal(r.data.reason, 'bridge_offline');
  } finally { await s.stop(); }
});

test('on_demand: markActive connects and holds the connection; without activity it drops', async () => {
  // Window 600 ms, renewed every 150 ms for 750 ms (longer than one window): a stall under ~450 ms can't drop it.
  const s = await onDemandSetup({ activeWindowMs: 600 });
  try {
    s.c.markActive();
    await until(() => s.c.connected, 2000);
    const drops0 = s.events.filter((e) => e === 'disconnected').length;
    for (let i = 0; i < 5; i++) { await sleep(150); s.c.markActive(); }
    assert.equal(s.events.filter((e) => e === 'disconnected').length, drops0, 'held while active');
    assert.ok(s.c.connected);
    // live read works while active
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_list_conversations', {});
    assert.equal(r.data.status, 'ok');
    await until(() => !s.c.connected, 4000);
    assert.ok(s.events.at(-1) === 'idle' || s.events.includes('idle'));
  } finally { await s.stop(); }
});

test('on_demand: daily cap disconnects, emits cap_reached, and keeps the client idle; ensureConnected still works', async () => {
  // The setup's own control call is connected time too; on a loaded runner it can reach the cap before this test
  // subscribes, so count cap_reached from the setup's event log (attached before start) rather than a late listener.
  const s = await onDemandSetup({ maxConnectedMsPerDay: 500, activeWindowMs: 10_000 });
  const caps = () => s.events.filter((e) => e === 'cap_reached').length;
  try {
    s.c.markActive();
    await until(() => caps() === 1, 3000);
    await until(() => !s.c.connected, 3000);
    assert.ok(s.c.capReached);
    s.c.markActive(); await sleep(200);
    assert.equal(s.c.connected, false, 'stays idle after the cap');
    // held writes wait (no pending-triggered connect under the cap)
    await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: 'after-cap' });
    await sleep(300);
    assert.ok(!s.calls.includes('after-cap'));
    assert.equal(caps(), 1, 'popup once per day');
    // explicit CLI requests are not subject to the cap
    await s.c.control('set_discovery', { bot_id: s.bot.botId, mode: 'none' });
  } finally { await s.stop(); }
});

test('on_demand: persisted usage for today counts toward the cap; another day does not', async () => {
  const r = await startRelay(); const id = await newIdentity(); await register(r.url, id);
  const today = new Date(); const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const a = client(r.url, id, async () => null, { ...fast, maxConnectedMsPerDay: 1000, usage: { day, ms: 1000 } });
  const b = client(r.url, id, async () => null, { ...fast, maxConnectedMsPerDay: 1000, usage: { day: '2000-01-01', ms: 1000 } });
  try {
    assert.equal(a.capReached, true);
    assert.equal(b.capReached, false);
  } finally { await a.stop(); await b.stop(); await r.stop(); }
});

test('always mode connects at start and stays connected', async () => {
  const r = await startRelay(); const id = await newIdentity(); await register(r.url, id);
  const c = client(r.url, id, async () => null, { mode: 'always', activeWindowMs: 50 });
  try { await c.start(); await c.waitReady(); await sleep(300); assert.ok(c.connected); } finally { await c.stop(); await r.stop(); }
});

// --- POST /v1/pending ------------------------------------------------------------------------------------------------------

async function pending(r: Running, userId: string, signer: Identity['signer'], over: { ts?: number; host?: string; sig?: string; method?: string } = {}) {
  const ts = over.ts ?? Date.now();
  const sig = over.sig ?? b64(await signer.sign(relayPendingMessage(over.host ?? r.host, ts)));
  const res = await fetch(`${r.url}/v1/pending`, { method: over.method ?? 'POST', headers: { [RELAY_PENDING_HEADERS.userId]: userId, [RELAY_PENDING_HEADERS.ts]: String(ts), [RELAY_PENDING_HEADERS.sig]: sig } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

test('/v1/pending: answers count and oldest age for a valid signature', async () => {
  const r = await startRelay(); const id = await newIdentity(); await register(r.url, id);
  try {
    assert.deepEqual((await pending(r, id.userId, id.signer)).body, { pending: 0, oldest_ms: null });
    await r.store.xadd(`t:user:${id.userId}:inbox`, { v: '1', n: '0' }); await sleep(20);
    await r.store.xadd(`t:user:${id.userId}:inbox`, { v: '1', n: '0' });
    const p = await pending(r, id.userId, id.signer);
    assert.equal(p.status, 200); assert.equal(p.body.pending, 2); assert.ok(p.body.oldest_ms >= 15);
  } finally { await r.stop(); }
});

test('/v1/pending: bad signature, clock skew, wrong user, unregistered, wrong host, malformed, GET', async () => {
  const r = await startRelay(); const a = await newIdentity(), b = await newIdentity(); await register(r.url, a); await register(r.url, b);
  try {
    assert.equal((await pending(r, a.userId, a.signer, { sig: b64(new Uint8Array(64)) })).status, 401);
    assert.equal((await pending(r, a.userId, a.signer, { ts: Date.now() - 61_000 })).status, 401);
    assert.equal((await pending(r, a.userId, a.signer, { ts: Date.now() + 61_000 })).status, 401);
    assert.equal((await pending(r, b.userId, a.signer)).status, 401, "A's signature for B's user id");
    const stranger = ed25519Signer();
    assert.equal((await pending(r, (await newIdentity()).userId, stranger)).status, 401, 'unregistered');
    assert.equal((await pending(r, a.userId, a.signer, { host: 'evil.example' })).status, 401);
    assert.equal((await pending(r, 'nope', a.signer)).status, 400);
    assert.equal((await pending(r, a.userId, a.signer, { method: 'GET' })).status, 405);
    assert.equal((await pending(r, a.userId, a.signer, { ts: Date.now() - 30_000 })).status, 200, 'within ±60 s');
  } finally { await r.stop(); }
});

test('/v1/pending: rate-limited per user', async () => {
  const r = await startRelay(); const a = await newIdentity(), b = await newIdentity(); await register(r.url, a); await register(r.url, b);
  try {
    const codes = [];
    for (let i = 0; i < LIMITS.relayPendingPerMinute + 1; i++) codes.push((await pending(r, a.userId, a.signer)).status);
    assert.equal(codes.filter((c) => c === 200).length, LIMITS.relayPendingPerMinute);
    assert.equal(codes.at(-1), 429);
    assert.equal((await pending(r, b.userId, b.signer)).status, 200, 'other users unaffected');
  } finally { await r.stop(); }
});

class CountingStore extends MemoryStore {
  calls: string[] = [];
}
function counting(): CountingStore {
  const s = new CountingStore();
  for (const m of ['get', 'set', 'del', 'incr', 'xadd', 'xrange', 'xdel', 'xlen', 'publish', 'claimNewest', 'xaddCounted', 'xdelCounted', 'pushExpire', 'blpop'] as const) {
    const orig = (s as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!.bind(s);
    (s as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => { s.calls.push(m); return orig(...a); };
  }
  return s;
}

test('/v1/pending: at most 3 Redis commands with a warm key cache, and no writes besides the rate counter', async () => {
  const store = counting();
  const r = await startRelay({}, store); const a = await newIdentity(); await register(r.url, a);
  try {
    await pending(r, a.userId, a.signer); // warms the key cache
    store.calls = [];
    assert.equal((await pending(r, a.userId, a.signer)).status, 200);
    assert.deepEqual([...store.calls].sort(), ['incr', 'xlen', 'xrange']);
  } finally { await r.stop(); }
});

test('client pending check signs correctly against the relay', async () => {
  const r = await startRelay(); const id = await newIdentity(); await register(r.url, id);
  const c = client(r.url, id, async () => null, { mode: 'on_demand', pendingPollMs: 60_000 });
  try {
    await r.store.xadd(`t:user:${id.userId}:inbox`, { v: '9', n: '0' }); // a foreign-format entry: counted, not delivered
    const seen: unknown[] = []; c.on('pending', (p) => seen.push(p));
    await c.start();
    await until(() => seen.length === 1);
    assert.equal((seen[0] as { pending: number }).pending, 1);
  } finally { await c.stop(); await r.stop(); }
});

// --- shared wake subscriber ------------------------------------------------------------------------------------------------

test('one shared pattern subscription per instance delivers wakes to the right sockets across users', async () => {
  const store = new MemoryStore();
  const r = await startRelay({ pollMs: 60_000 }, store); // no poll: wakes must do the work
  const users = await Promise.all([newIdentity(), newIdentity()]);
  const got: Record<string, string[]> = {};
  const clients: RelayClient[] = [];
  try {
    const bots = [];
    for (const id of users) {
      await register(r.url, id);
      got[id.userId] = [];
      const c = client(r.url, id, async (call) => { got[id.userId]!.push(String(call.call.params.body)); return { result: { ok: true } }; });
      clients.push(c); await c.start(); await c.waitReady();
      const bot = newBot(); await registerBot(c, bot.botId, bot.token); bots.push(bot);
    }
    assert.equal(store.openConnections, 1, 'one psubscribe for two sockets');
    assert.equal(r.relay.ctx.hub.sockets, 2);
    for (let i = 0; i < 2; i++) {
      const id = users[i]!, bot = bots[i]!;
      const res = await callTool(r.url, id.userId, bot.botId, bot.token, 'bridge_send', { conversation_id: CONV, body: `for-${i}` });
      assert.equal(res.data.ok, true);
    }
    assert.deepEqual(got[users[0]!.userId], ['for-0']);
    assert.deepEqual(got[users[1]!.userId], ['for-1']);
    for (const c of clients) await c.stop();
    await until(() => store.openConnections === 0, 2000);
  } finally { for (const c of clients) await c.stop(); await r.stop(); }
});

