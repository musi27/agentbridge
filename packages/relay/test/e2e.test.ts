// End to end: local relay (in-memory Redis) + the real bridge-side client, Grok-style MCP calls over HTTP (§13, §19.3, §19.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUlid, LIMITS } from '@agentbridge/protocol';
import { MemoryStore } from '../src/store.ts';
import { unseal } from '../src/crypto.ts';
import { callTool, client, mcp, newBot, newIdentity, register, registerBot, setup, sleep, startRelay, until } from './helpers.ts';

const CONV = '01JD0000000000000000000000';

test('round trip: Grok tools/call -> bridge client -> res -> HTTP response', async () => {
  const s = await setup();
  try {
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: 'hello' });
    assert.equal(r.status, 200);
    assert.equal(r.isError, false);
    assert.deepEqual(r.data, { status: 'ok', echo: { conversation_id: CONV, body: 'hello' } });
    assert.equal(s.calls.length, 1);
    const c = s.calls[0]!;
    assert.equal(c.call.method, 'bridge_send');
    assert.equal(c.call.caller, s.bot.botId);
    assert.equal(c.call.token, s.bot.token, 'bridge receives the token to re-verify');
    assert.equal(c.held, false);
    await until(async () => (await s.r.store.xlen(`t:user:${s.id.userId}:inbox`)) === 0); // acked -> XDEL
  } finally { await s.stop(); }
});

test('bridge error answers reach Grok as short tool errors', async () => {
  const s = await setup({ onCall: async () => ({ error: { code: 'not_participant', message: 'Not your conversation.' } }) });
  try {
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_get_transcript', { conversation_id: CONV });
    assert.equal(r.isError, true);
    assert.deepEqual(r.data, { status: 'failed', reason: 'not_participant', message: 'Not your conversation.' });
  } finally { await s.stop(); }
});

test('start: relay allocates conversation_id and the bridge receives it', async () => {
  const s = await setup();
  try {
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_start_conversation', { peer: 'claude:x', topic: 't', first_message: 'hi', conversation_id: 'ignored' });
    const echoed = (r.data.echo as Record<string, unknown>).conversation_id;
    assert.ok(isUlid(echoed));
    assert.equal(s.calls[0]!.call.params.conversation_id, echoed);
  } finally { await s.stop(); }
});

test('offline: holdable calls -> held_relay, delivered on connect; reads -> bridge_offline', async () => {
  const r = await startRelay();
  const id = await newIdentity();
  assert.equal((await register(r.url, id)).status, 201);
  const seen: string[] = [];
  const c = client(r.url, id, async (call) => { seen.push(`${call.call.method}:${call.held}`); return { result: { status: 'queued' } }; });
  try {
    await c.start(); await c.waitReady();
    const bot = newBot(); await registerBot(c, bot.botId, bot.token);
    await c.stop();
    await until(async () => (await r.store.get(`t:user:${id.userId}:conn`)) === null);

    const start = await callTool(r.url, id.userId, bot.botId, bot.token, 'bridge_start_conversation', { peer: 'claude:x', topic: 't', first_message: 'hi' });
    assert.equal(start.data.status, 'held_relay');
    assert.ok(isUlid(start.data.conversation_id));
    const send = await callTool(r.url, id.userId, bot.botId, bot.token, 'bridge_send', { conversation_id: CONV, body: 'b' });
    assert.deepEqual([send.data.status, send.data.conversation_id], ['held_relay', CONV]);
    const read = await callTool(r.url, id.userId, bot.botId, bot.token, 'bridge_list_conversations', {});
    assert.equal(read.isError, true);
    assert.equal(read.data.reason, 'bridge_offline');
    // initialize and tools/list work while the bridge is offline
    assert.equal((await mcp(r.url, id.userId, bot.botId, bot.token, 'tools/list')).body.result.tools.length, 7);

    const c2 = client(r.url, id, async (call) => { seen.push(`${call.call.method}:${call.held}`); return { result: { status: 'queued' } }; });
    await c2.start();
    await until(() => seen.length === 2);
    assert.deepEqual(seen, ['bridge_start_conversation:true', 'bridge_send:true']);
    await until(async () => (await r.store.xlen(`t:user:${id.userId}:inbox`)) === 0);
    await c2.stop();
  } finally { await c.stop(); await r.stop(); }
});

test('deadline missed while connected -> held_relay, then handled once', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const s = await setup({ cfg: { responseWaitMs: 150 }, onCall: async () => { await gate; return { result: { status: 'delivered' } }; } });
  try {
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: 'slow' });
    assert.equal(r.data.status, 'held_relay');
    release();
    await until(async () => (await s.r.store.xlen(`t:user:${s.id.userId}:inbox`)) === 0);
    assert.equal(s.calls.length, 1);
  } finally { await s.stop(); }
});

test('read past deadline: bridge_offline and never delivered later', async () => {
  const s = await setup({ cfg: { responseWaitMs: 100 }, onCall: async () => { await sleep(300); return { result: {} }; } });
  try {
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_list_conversations', {});
    assert.equal(r.data.reason, 'bridge_offline');
    await until(async () => (await s.r.store.xlen(`t:user:${s.id.userId}:inbox`)) === 0);
  } finally { await s.stop(); }
});

test('forced reconnects (simulated 300 s cutoff, deaf window) with make-before-break: zero loss, no duplicates', async () => {
  // Scaled: platform drops sockets at 600 ms and goes deaf 80 ms earlier; the client reconnects at 400 ms.
  const s = await setup({ cfg: { cutoffMs: 600, deafBeforeCutoffMs: 80, overlapMs: 150, responseWaitMs: 1500, pollMs: 100 }, client: { reconnectAtMs: 400 } });
  try {
    let readies = 0; s.c.on('ready', () => readies++);
    const N = 60; const results: string[] = [];
    for (let i = 0; i < N; i++) {
      const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: `m${i}` });
      results.push(String(r.data.status));
      await sleep(25);
    }
    await until(() => s.calls.length >= N, 5000);
    await sleep(300);
    const bodies = s.calls.map((c) => c.call.params.body);
    assert.equal(new Set(bodies).size, N, 'every message handled');
    assert.equal(bodies.length, N, 'no duplicates');
    assert.ok(readies >= 2, `reconnected ${readies} times`);
    assert.ok(results.filter((x) => x === 'ok').length >= N - 2, `answered live: ${results.filter((x) => x === 'ok').length}/${N}`);
    await until(async () => (await s.r.store.xlen(`t:user:${s.id.userId}:inbox`)) === 0);
  } finally { await s.stop(); }
});

test('unplanned drop: client reconnects quickly and resumes from the ack cursor', async () => {
  let saved: string | undefined;
  const s = await setup({ client: { saveCursor: (c) => { saved = c; } } });
  try {
    await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: 'one' });
    await until(() => saved !== undefined);
    const t0 = Date.now();
    let readies = 0; s.c.on('ready', () => readies++);
    s.r.relay.terminateSockets(); // abrupt, code 1006 at the client
    await until(() => readies === 1, 3000);
    assert.ok(Date.now() - t0 < 1500);
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: 'two' });
    assert.equal(r.data.status, 'ok');
    assert.deepEqual(s.calls.map((c) => c.call.params.body), ['one', 'two']);
  } finally { await s.stop(); }
});

test('§19.3 #10: invalid bot token is rejected at the relay (401), before the stream', async () => {
  const s = await setup();
  try {
    for (const tok of [null, 'wrong', s.bot.token + 'x']) {
      const r = await mcp(s.r.url, s.id.userId, s.bot.botId, tok, 'tools/call', { name: 'bridge_send', arguments: { conversation_id: CONV, body: 'x' } });
      assert.equal(r.status, 401);
      assert.equal(r.body.error.message, 'Invalid or revoked agentbridge token.');
    }
    await s.c.control('revoke_bot', { bot_id: s.bot.botId });
    assert.equal((await mcp(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'tools/list')).status, 401);
    assert.equal(s.calls.length, 0);
    assert.equal(await s.r.store.xlen(`t:user:${s.id.userId}:inbox`), 0);
  } finally { await s.stop(); }
});

test('§19.3 #11: cross-user stream and bot access refused', async () => {
  const store = new MemoryStore();
  const a = await setup({ store });
  const r = a.r;
  const idB = await newIdentity();
  assert.equal((await register(r.url, idB)).status, 201);
  const callsB: string[] = [];
  const cB = client(r.url, idB, async (c) => { callsB.push(String(c.call.params.body)); return { result: { who: 'B' } }; });
  try {
    await cB.start(); await cB.waitReady();
    const botB = newBot(); await registerBot(cB, botB.botId, botB.token);
    // A's token on B's path, and B's bot id under A's user: both 401
    assert.equal((await mcp(r.url, idB.userId, botB.botId, a.bot.token, 'tools/list')).status, 401);
    assert.equal((await mcp(r.url, a.id.userId, botB.botId, botB.token, 'tools/list')).status, 401);
    assert.equal((await mcp(r.url, idB.userId, a.bot.botId, a.bot.token, 'tools/list')).status, 401);
    // Each user's calls reach only their own bridge
    const ra = await callTool(r.url, a.id.userId, a.bot.botId, a.bot.token, 'bridge_send', { conversation_id: CONV, body: 'for-A' });
    const rb = await callTool(r.url, idB.userId, botB.botId, botB.token, 'bridge_send', { conversation_id: CONV, body: 'for-B' });
    assert.equal((ra.data.echo as Record<string, unknown>).body, 'for-A');
    assert.deepEqual(rb.data, { who: 'B' });
    assert.deepEqual(a.calls.map((c) => c.call.params.body), ['for-A']);
    assert.deepEqual(callsB, ['for-B']);
    // B's bridge cannot manage A's bots: control acts on its own user only
    await cB.control('revoke_bot', { bot_id: a.bot.botId });
    assert.equal((await mcp(r.url, a.id.userId, a.bot.botId, a.bot.token, 'tools/list')).status, 200);
    // A connection cannot claim another user's id
    const impostor = client(r.url, { ...idB, userId: a.id.userId }, async () => null, { backoffBaseMs: 5000 });
    const errs: Error[] = []; impostor.on('error', (e) => errs.push(e));
    await impostor.start();
    await until(() => errs.length > 0);
    assert.match(errs[0]!.message, /unauthorized/);
    await impostor.stop();
  } finally { await cB.stop(); await a.stop(); }
});

test('§19.3 #12: a Redis dump without the bridge key is unreadable', async () => {
  const r = await startRelay();
  const id = await newIdentity();
  await register(r.url, id);
  const c = client(r.url, id, async () => ({ result: {} }));
  try {
    await c.start(); await c.waitReady();
    const bot = newBot(); await registerBot(c, bot.botId, bot.token);
    await c.stop();
    await until(async () => (await r.store.get(`t:user:${id.userId}:conn`)) === null);
    const secret = 'TOP-SECRET-PAYLOAD-' + 'z'.repeat(20);
    await callTool(r.url, id.userId, bot.botId, bot.token, 'bridge_send', { conversation_id: CONV, body: secret });
    const dump = r.store.dump();
    assert.ok(dump.includes(`t:user:${id.userId}:inbox`), 'entry is held');
    assert.ok(!dump.includes(secret), 'body not in clear');
    assert.ok(!dump.includes(bot.token), 'token not in clear');
    assert.ok(!dump.includes(Buffer.from(secret).toString('base64').slice(0, 20)), 'not merely base64');
    // The bridge key opens it; another key does not.
    const [[, f]] = await r.store.xrange(`t:user:${id.userId}:inbox`, '-', '+') as [[string, Record<string, string>]];
    const other = await newIdentity();
    assert.equal(await unseal(f.s!, other.x25519), null);
    const plain = JSON.parse(Buffer.from((await unseal(f.s!, id.x25519))!).toString());
    assert.equal(plain.params.body, secret);
  } finally { await c.stop(); await r.stop(); }
});

test('§19.4 lost wake: the periodic poll still delivers', async () => {
  const store = new MemoryStore();
  const s = await setup({ store, cfg: { pollMs: 150, responseWaitMs: 3000 } });
  try {
    store.dropPublishes = true;
    const t0 = Date.now();
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: 'x' });
    assert.equal(r.data.status, 'ok');
    assert.ok(Date.now() - t0 >= 50, 'came via poll, not wake');
  } finally { store.dropPublishes = false; await s.stop(); }
});

test('§19.4 cross-instance: HTTP on one relay instance, WebSocket on another (shared Redis)', async () => {
  const store = new MemoryStore();
  const s = await setup({ store });
  const other = await startRelay({}, store);
  try {
    const r = await callTool(other.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: 'via-B' });
    assert.equal(r.data.status, 'ok');
    assert.equal(s.calls[0]!.call.params.body, 'via-B');
  } finally { await other.stop(); await s.stop(); }
});

test('§19.4 backlog: 100 held entries are delivered in order on connect', async () => {
  const r = await startRelay();
  const id = await newIdentity(); await register(r.url, id);
  const c = client(r.url, id, async () => null);
  await c.start(); await c.waitReady();
  const bot = newBot(); await registerBot(c, bot.botId, bot.token);
  await c.stop();
  await until(async () => (await r.store.get(`t:user:${id.userId}:conn`)) === null);
  const N = 100; // below the per-user rpm limit
  for (let i = 0; i < N; i++) await callTool(r.url, id.userId, bot.botId, bot.token, 'bridge_send', { conversation_id: CONV, body: `b${i}` });
  const got: string[] = [];
  const c2 = client(r.url, id, async (call) => { got.push(String(call.call.params.body)); return null; });
  try {
    await c2.start();
    await until(() => got.length === N, 10_000);
    assert.deepEqual(got, Array.from({ length: N }, (_, i) => `b${i}`));
    await until(async () => (await r.store.xlen(`t:user:${id.userId}:inbox`)) === 0);
    assert.equal(await r.store.get(`t:user:${id.userId}:held_bytes`), '0');
  } finally { await c2.stop(); await r.stop(); }
});

test('§19.4 trim expiry: entries older than queue.expiry become expiry records on reconnect', async () => {
  let now = Date.now();
  const clock = () => now;
  const store = new MemoryStore(clock);
  const r = await startRelay({ now: clock, queueExpiryMs: 60_000 }, store);
  const id = await newIdentity(); await register(r.url, id);
  const c = client(r.url, id, async () => null);
  await c.start(); await c.waitReady();
  const bot = newBot(); await registerBot(c, bot.botId, bot.token);
  await c.stop();
  await until(async () => (await store.get(`t:user:${id.userId}:conn`)) === null);
  const start = await callTool(r.url, id.userId, bot.botId, bot.token, 'bridge_start_conversation', { peer: 'claude:x', topic: 't', first_message: 'old' });
  now += 61_000;
  await callTool(r.url, id.userId, bot.botId, bot.token, 'bridge_send', { conversation_id: CONV, body: 'fresh' }); // ingest trims the old one
  const expiries: unknown[] = []; const got: string[] = [];
  const c2 = client(r.url, id, async (call) => { got.push(String(call.call.params.body ?? call.call.params.first_message)); return null; }, { onExpiry: (e) => { expiries.push(...e); } });
  try {
    await c2.start();
    await until(() => expiries.length === 1 && got.length === 1);
    const e = expiries[0] as { req_id: string; method: string; conversation_id?: string };
    assert.equal(e.method, 'bridge_start_conversation');
    assert.equal(e.conversation_id, start.data.conversation_id);
    assert.deepEqual(got, ['fresh']);
    // records are deleted when the relay gets the client's expiry_ack, which follows onExpiry asynchronously
    await until(async () => (await store.xlen(`t:user:${id.userId}:expired`)) === 0);
    await sleep(50);
    assert.equal(expiries.length, 1, 'reported once');
  } finally { await c2.stop(); await r.stop(); }
});

test('§19.4 rate limits: per-user requests per minute', async () => {
  const s = await setup();
  try {
    const key = `t:rl:${s.id.userId}:${Math.floor(Date.now() / 60_000)}`;
    await s.r.store.set(key, String(LIMITS.relayUserRpm));
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: 'x' });
    assert.equal(r.data.reason, 'rate_limited');
    assert.equal(s.calls.length, 0);
  } finally { await s.stop(); }
});

test('duplicate delivery of one entry (resent after reconnect) is handled once', async () => {
  const s = await setup({ cfg: { responseWaitMs: 2000 } });
  try {
    let n = 0;
    const r = await callTool(s.r.url, s.id.userId, s.bot.botId, s.bot.token, 'bridge_send', { conversation_id: CONV, body: 'once' });
    assert.equal(r.data.status, 'ok'); n = s.calls.length;
    let readies = 0; s.c.on('ready', () => readies++);
    s.r.relay.terminateSockets();
    await until(() => readies === 1);
    await sleep(200);
    assert.equal(s.calls.length, n);
  } finally { await s.stop(); }
});
