// Regression tests for the integrator review of PR #3 (payload caps, clock skew, races, heartbeat, fail-closed, atomicity).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { LIMITS, RELAY_PROTOCOL, relayAuthMessage, type RelayFrame } from '@agentbridge/protocol';
import { MemoryStore } from '../src/store.ts';
import { makeCtx, appendEntry, ackThrough, heldUsage } from '../src/core.ts';
import { handleIdentity } from '../src/control.ts';
import { relayFromEnv } from '../src/env.ts';
import { b64 } from '../src/crypto.ts';
import { callTool, client, identityBody, newBot, newIdentity, register, registerBot, setup, sleep, startRelay, until, type Identity, type Running } from './helpers.ts';

const CONV = '01JD0000000000000000000000';

// --- 1. response size ----------------------------------------------------------------------------------------------------

test('a 100 KB result round-trips over the bridge socket', async () => {
  const blob = 'x'.repeat(100 * 1024);
  const s = await setup({ onCall: async () => ({ result: { blob } }) });
  try {
    let drops = 0; s.c.on('disconnected', () => drops++);
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_get_transcript', { conversation_id: CONV });
    assert.equal(r.isError, false);
    assert.equal((r.data.blob as string).length, blob.length);
    assert.equal(drops, 0);
  } finally { await s.stop(); }
});

test('a result over 1 MB yields a short too_large error, not a disconnect', async () => {
  const s = await setup({ onCall: async () => ({ result: { blob: 'y'.repeat(LIMITS.relayResponseBytes + 10) } }) });
  try {
    let drops = 0; s.c.on('disconnected', () => drops++);
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_get_transcript', { conversation_id: CONV });
    assert.equal(r.isError, true);
    assert.equal(r.data.reason, 'too_large');
    assert.ok(String(r.data.message).length < 200);
    await sleep(100);
    assert.equal(drops, 0); assert.ok(s.c.connected);
  } finally { await s.stop(); }
});

// --- 2. request size ---------------------------------------------------------------------------------------------------

test('a valid <= 32 KB body that JSON-escapes to ~2x is accepted; the 32 KB body check stays the limit', async () => {
  const s = await setup();
  try {
    const body = '"\n'.repeat(15_000); // 30,000 bytes -> ~60,000 bytes escaped
    const ok = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body });
    assert.equal(ok.status, 200); assert.equal(ok.data.status, 'ok');
    const big = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: 'z'.repeat(LIMITS.bodyBytes + 1) });
    assert.equal(big.data.reason, 'too_large');
  } finally { await s.stop(); }
});

function rawPost(url: string, path: string, chunks: Buffer[], headers: Record<string, string>) {
  return new Promise<{ status: number; closed: boolean }>((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path, method: 'POST', headers }, (res) => {
      res.resume();
      res.on('end', () => setTimeout(() => resolve({ status: res.statusCode ?? 0, closed: req.socket?.destroyed ?? true }), 50));
    });
    req.on('error', (e) => (e as NodeJS.ErrnoException).code === 'ECONNRESET' || (e as NodeJS.ErrnoException).code === 'EPIPE' ? resolve({ status: 413, closed: true }) : reject(e));
    (async () => { for (const c of chunks) { if (req.destroyed) return; req.write(c); await sleep(5); } req.end(); })().catch(() => {});
  });
}

test('oversized request bodies get 413 and the connection is closed (declared and chunked)', async () => {
  const r = await startRelay();
  try {
    const path = `/v1/u/${'a'.repeat(26)}/b/bot12345/mcp`;
    const declared = await rawPost(r.url, path, [Buffer.alloc(100)], { 'content-length': String(LIMITS.relayRequestBytes + 1), 'content-type': 'application/json' });
    assert.equal(declared.status, 413); assert.equal(declared.closed, true);
    const chunked = await rawPost(r.url, path, Array.from({ length: 20 }, () => Buffer.alloc(16 * 1024, 32)), { 'transfer-encoding': 'chunked' });
    assert.equal(chunked.status, 413); assert.equal(chunked.closed, true);
  } finally { await r.stop(); }
});

// --- 3. clock skew -----------------------------------------------------------------------------------------------------

for (const skew of [-60_000, 60_000]) {
  test(`a bridge clock ${skew / 1000} s off still answers reads live (relative deadline)`, async () => {
    const s = await setup({ client: { now: () => Date.now() + skew } });
    try {
      const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_list_conversations', {});
      assert.equal(r.isError, false, JSON.stringify(r.data));
      assert.equal(s.calls[0]!.held, false);
      assert.ok(Math.abs(s.calls[0]!.deadlineMs - (Date.now() + skew + LIMITS.relayResponseWaitMs)) < 2000);
    } finally { await s.stop(); }
  });
}

test('items held while offline arrive with held = true and deadline_in_ms = 0, whatever the bridge clock', async () => {
  const r = await startRelay(); const id = await newIdentity(); await register(r.url, id);
  const c = client(r.url, id, async () => null); await c.start(); await c.waitReady();
  const bot = newBot(); await registerBot(c, bot.botId, bot.token); await c.stop();
  await until(async () => (await r.store.get(`t:user:${id.userId}:conn`)) === null);
  await callTool(r.url, id.userId, bot.botId, bot.token, 'bridge_send', { conversation_id: CONV, body: 'h' });
  const held: boolean[] = [];
  const c2 = client(r.url, id, async (call) => { held.push(call.held); return null; }, { now: () => Date.now() - 3_600_000 });
  try { await c2.start(); await until(() => held.length === 1); assert.deepEqual(held, [true]); } finally { await c2.stop(); await r.stop(); }
});

// --- 4. presence and supersede races -------------------------------------------------------------------------------------

test('presence claim is atomic and rank-ordered', async () => {
  let t = 0; const s = new MemoryStore(() => t);
  assert.equal(await s.claimNewest('p', '10|a', 10, 100), null);
  assert.equal(await s.claimNewest('p', '10|a', 10, 100), null, 'refresh by the holder');
  assert.equal(await s.claimNewest('p', '5|old', 5, 100), '10|a', 'an older connection cannot take it');
  assert.equal(await s.claimNewest('p', '20|b', 20, 100), null, 'a newer one can');
  assert.equal(await s.claimNewest('p', '10|a', 10, 100), '20|b');
  t += 200;
  assert.equal(await s.claimNewest('p', '10|a', 10, 100), null, 'expired: free to claim');
});

async function rawAuthed(r: Running, id: Identity, connId: string) {
  const ws = new WebSocket(r.url.replace('http', 'ws') + '/v1/connect');
  const frames: RelayFrame[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
  await until(() => frames.length > 0);
  const ch = frames[0] as Extract<RelayFrame, { type: 'challenge' }>;
  ws.send(JSON.stringify({ type: 'auth', protocol: RELAY_PROTOCOL, user_id: id.userId, pubkey: b64(id.signer.publicKey), sig: b64(await id.signer.sign(relayAuthMessage(r.host, ch.nonce, ch.ts))), conn_id: connId }));
  return { ws, frames, closed };
}

test('a supersede message from an earlier-authenticated connection is ignored', async () => {
  const r = await startRelay({ overlapMs: 50 }); const id = await newIdentity(); await register(r.url, id);
  try {
    const a = await rawAuthed(r, id, 'A');
    await until(() => a.frames.some((f) => f.type === 'ready'));
    await r.store.publish(`t:user:${id.userId}:wake`, `s:${Date.now() - 60_000}|stale`);
    await sleep(200);
    assert.equal(a.ws.readyState, WebSocket.OPEN);
    assert.match(String(await r.store.get(`t:user:${id.userId}:conn`)), /\|A$/);
    a.ws.close();
  } finally { await r.stop(); }
});

// The relay subscribes through the per-instance shared pattern subscription (WakeHub -> psubscribe): slow that down.
class SlowSubscribeStore extends MemoryStore {
  override async psubscribe(pattern: string, fn: (c: string, m: string) => void) { await sleep(150); return super.psubscribe(pattern, fn); }
}

test('a socket closed mid-auth leaves no subscription, presence key or poll timer behind', async () => {
  const store = new SlowSubscribeStore();
  const r = await startRelay({ pollMs: 20 }, store); const id = await newIdentity(); await register(r.url, id);
  try {
    const a = await rawAuthed(r, id, 'A');
    await sleep(30);
    a.ws.terminate();
    await sleep(400);
    assert.equal(store.openConnections, 0, 'subscription released');
    assert.equal(await store.get(`t:user:${id.userId}:conn`), null, 'no presence for a closed socket');
  } finally { await r.stop(); }
});

// --- 5. heartbeat and client timeouts ------------------------------------------------------------------------------------

test('relay terminates a socket that stops answering pings (two missed pongs)', async () => {
  const r = await startRelay({ heartbeatMs: 40 }); const id = await newIdentity(); await register(r.url, id);
  try {
    const ws = new WebSocket(r.url.replace('http', 'ws') + '/v1/connect', { autoPong: false });
    const t0 = Date.now();
    const code = await new Promise<number>((res) => ws.on('close', (c) => res(c)));
    assert.equal(code, 1006);
    assert.ok(Date.now() - t0 < 1000);
  } finally { await r.stop(); }
});

test('relay heartbeat keeps a healthy client connected (wake frames)', async () => {
  const s = await setup({ cfg: { heartbeatMs: 30 }, client: { silenceTimeoutMs: 120 } });
  try {
    let drops = 0; s.c.on('disconnected', () => drops++);
    await sleep(500);
    assert.equal(drops, 0);
  } finally { await s.stop(); }
});

test('client drops a silent connection and reconnects', async () => {
  const s = await setup({ cfg: { heartbeatMs: 60_000 }, client: { silenceTimeoutMs: 150 } });
  try {
    const reasons: string[] = []; s.c.on('disconnected', (e: { reason: string }) => reasons.push(e.reason));
    let readies = 0; s.c.on('ready', () => readies++);
    await until(() => readies >= 1, 2000);
    assert.ok(reasons.includes('relay silent'));
  } finally { await s.stop(); }
});

test('client gives up on a connect stuck before ready and retries', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  let conns = 0; wss.on('connection', () => { conns++; }); // never sends a challenge
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const port = (server.address() as AddressInfo).port;
  const c = client(`http://127.0.0.1:${port}`, await newIdentity(), async () => null, { handshakeTimeoutMs: 100, backoffBaseMs: 20 });
  try {
    await c.start();
    await until(() => conns >= 3, 3000);
  } finally {
    await c.stop();
    for (const w of wss.clients) w.terminate();
    await new Promise<void>((res) => wss.close(() => res()));
    server.closeAllConnections(); await new Promise<void>((res) => server.close(() => res()));
  }
});

// --- 6. production fails closed --------------------------------------------------------------------------------------------

test('production refuses to start without REDIS_URL, RELAY_HOST and RELAY_KEY_PREFIX', async () => {
  for (const prod of [{ VERCEL: '1' }, { NODE_ENV: 'production' }]) {
    assert.throws(() => relayFromEnv({ ...prod }), /REDIS_URL, RELAY_HOST, RELAY_KEY_PREFIX/);
    assert.throws(() => relayFromEnv({ ...prod, REDIS_URL: 'redis://x', RELAY_HOST: 'h' }), /RELAY_KEY_PREFIX/);
    assert.throws(() => relayFromEnv({ ...prod, REDIS_URL: 'redis://x', RELAY_KEY_PREFIX: 'p:' }), /RELAY_HOST/);
    assert.throws(() => relayFromEnv({ ...prod, RELAY_HOST: 'h', RELAY_KEY_PREFIX: 'p:' }), /REDIS_URL/);
  }
  const dev = relayFromEnv({}); // local: in-memory store is fine
  await dev.close();
});

// --- smaller fixes -----------------------------------------------------------------------------------------------------

test('ack never deletes entries of another stream format', async () => {
  const x = makeCtx({ store: new MemoryStore(), keyPrefix: 'f:' });
  const u = 'a'.repeat(26);
  const mine1 = await appendEntry(x, u, { reqId: 'r1', method: 'bridge_send', deadline: 0, sealed: 'aa' });
  const foreign = await x.store.xadd(x.k.inbox(u), { v: '2', r: 'r2', s: 'zz', n: '0' });
  const mine2 = await appendEntry(x, u, { reqId: 'r3', method: 'bridge_send', deadline: 0, sealed: 'bb' });
  assert.equal(await ackThrough(x, u, mine2), 2);
  assert.deepEqual((await x.store.xrange(x.k.inbox(u), '-', '+')).map((e) => e[0]), [foreign]);
  void mine1;
});

test('concurrent acks keep held_bytes exact', async () => {
  const x = makeCtx({ store: new MemoryStore(), keyPrefix: 'b:' });
  const u = 'a'.repeat(26);
  let last = '';
  for (let i = 0; i < 20; i++) last = await appendEntry(x, u, { reqId: `r${i}`, method: 'bridge_send', deadline: 0, sealed: 'x'.repeat(100) });
  await Promise.all([ackThrough(x, u, last), ackThrough(x, u, last), ackThrough(x, u, last)]);
  assert.deepEqual(await heldUsage(x, u), { entries: 0, bytes: 0 });
  assert.equal(await x.store.get(x.k.heldBytes(u)), '0');
});

test('identity-per-IP limit holds under parallel creations', async () => {
  const x = makeCtx({ store: new MemoryStore(), keyPrefix: 'i:' });
  const bodies = await Promise.all(Array.from({ length: 12 }, async () => Buffer.from(JSON.stringify(await identityBody(await newIdentity())))));
  const res = await Promise.all(bodies.map((b) => handleIdentity(x, 'POST', b, '7.7.7.7')));
  assert.equal(res.filter((r) => r.status === 201).length, LIMITS.relayIdentityPerIpPerDay);
  assert.equal(res.filter((r) => r.status === 429).length, 12 - LIMITS.relayIdentityPerIpPerDay);
});

test('expiry records stay until the bridge sends expiry_ack', async () => {
  let now = Date.now();
  const clock = () => now;
  const store = new MemoryStore(clock);
  const r = await startRelay({ now: clock, queueExpiryMs: 60_000 }, store);
  const id = await newIdentity(); await register(r.url, id);
  const c = client(r.url, id, async () => null); await c.start(); await c.waitReady();
  const bot = newBot(); await registerBot(c, bot.botId, bot.token); await c.stop();
  await until(async () => (await store.get(`t:user:${id.userId}:conn`)) === null);
  await callTool(r.url, id.userId, bot.botId, bot.token, 'bridge_end_conversation', { conversation_id: CONV });
  now += 61_000;
  const key = `t:user:${id.userId}:expired`;
  try {
    // A raw connection that receives the expiry frame but never acks it: the records remain.
    const a = await rawAuthed(r, id, 'A');
    await until(() => a.frames.some((f) => f.type === 'expiry'));
    const exp = a.frames.find((f) => f.type === 'expiry') as Extract<RelayFrame, { type: 'expiry' }>;
    assert.equal(exp.entries[0]!.conversation_id, CONV);
    await sleep(50);
    assert.equal(await store.xlen(key), 1);
    a.ws.send(JSON.stringify({ type: 'expiry_ack', cursor: exp.cursor }));
    await until(async () => (await store.xlen(key)) === 0);
    a.ws.close();
    // The real client acks after onExpiry resolves (and not when it throws).
    now += 61_000;
    await callTool(r.url, id.userId, bot.botId, bot.token, 'bridge_end_conversation', { conversation_id: CONV });
    now += 61_000;
    const failing = client(r.url, id, async () => null, { onExpiry: () => { throw new Error('disk full'); } });
    failing.on('call_error', () => {});
    await failing.start(); await failing.waitReady(); await until(async () => (await store.xlen(key)) === 1); await sleep(50);
    assert.equal(await store.xlen(key), 1); await failing.stop();
    const seen: unknown[] = [];
    const ok = client(r.url, id, async () => null, { onExpiry: (e) => { seen.push(...e); } });
    await ok.start(); await until(() => seen.length === 1); await until(async () => (await store.xlen(key)) === 0); await ok.stop();
  } finally { await r.stop(); }
});

