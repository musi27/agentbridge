// Unit tests: store, crypto, MCP handler, identity and control handlers, HTTP routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botTokenHash, relayRotateStatement, relayX25519Statement, userIdFromPubkey, LIMITS } from '@agentbridge/protocol';
import { MemoryStore, cmpStreamId } from '../src/store.ts';
import { makeCtx, putBot, putUser, ackThrough, appendEntry, heldUsage, nextStreamId } from '../src/core.ts';
import { handleMcp, MCP_PROTOCOL_VERSIONS, type McpRequest } from '../src/mcp.ts';
import { handleControl, handleIdentity } from '../src/control.ts';
import { logicalPath } from '../src/server.ts';
import { b64, ed25519Signer, ed25519SignerFromRaw, ed25519Verify, seal, unseal, x25519KeyPair } from '../src/crypto.ts';
import { identityBody, newIdentity, until } from './helpers.ts';

const U = 'a'.repeat(26), B = 'bot12345', TOKEN = 'tok-' + 'x'.repeat(40);

async function ctxWithBot(discovery: 'names' | 'none' = 'names', cfg: Partial<Parameters<typeof makeCtx>[0]> = {}) {
  const store = new MemoryStore();
  const x = makeCtx({ store, keyPrefix: 'u:', responseWaitMs: 100, ...cfg });
  const kp = await x25519KeyPair();
  await putUser(x, U, { ed25519_pub: b64(new Uint8Array(32)), x25519_pub: b64(kp.publicKey), created_at: 1 });
  await putBot(x, U, B, { token_hash: botTokenHash(TOKEN), discovery, created_at: 1 });
  return { x, store, kp };
}
const req = (body: unknown, over: Partial<McpRequest> = {}): McpRequest => ({
  method: 'POST', userId: U, botId: B, authorization: `Bearer ${TOKEN}`, protocolVersion: '2025-11-25', body: Buffer.from(JSON.stringify(body)), ...over,
});
const rpc = (method: string, params: unknown = {}, id: unknown = 1) => ({ jsonrpc: '2.0', id, method, params });
const toolData = (r: Awaited<ReturnType<typeof handleMcp>>) => {
  const res = (r.body as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { isError: res.isError === true, data: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
};

// --- store -------------------------------------------------------------------------------------------------------------

test('memory store: stream ids, ranges, xdel, counters with expiry, delIfEquals', async () => {
  let t = 1000; const s = new MemoryStore(() => t);
  const a = await s.xadd('k', { f: '1' }), b = await s.xadd('k', { f: '2' }); t++;
  const c = await s.xadd('k', { f: '3' });
  assert.deepEqual([a, b, c], ['1000-0', '1000-1', '1001-0']);
  assert.equal(cmpStreamId(b, c), -1);
  assert.deepEqual((await s.xrange('k', nextStreamId(a), '+')).map((e) => e[0]), [b, c]);
  assert.deepEqual((await s.xrange('k', '-', b)).map((e) => e[0]), [a, b]);
  assert.deepEqual((await s.xrange('k', `(${a}`, '+', 1)).map((e) => e[0]), [b]);
  assert.equal(await s.xdel('k', [a, c]), 2); assert.equal(await s.xlen('k'), 1);
  assert.equal(await s.incr('n', 1, 50), 1); assert.equal(await s.incr('n', 2, 50), 3); t += 60; assert.equal(await s.get('n'), null);
  assert.equal(await s.set('x', 'v', { nx: true }), true); assert.equal(await s.set('x', 'w', { nx: true }), false);
  assert.equal(await s.delIfEquals('x', 'w'), false); assert.equal(await s.delIfEquals('x', 'v'), true);
});

test('memory store: blpop wakes on push, times out to null, releases its connection', async () => {
  const s = new MemoryStore();
  const p = s.blpop('r', 1000);
  assert.equal(s.openConnections, 1);
  await s.pushExpire('r', 'hello', 1000);
  assert.equal(await p, 'hello');
  assert.equal(await s.blpop('r', 20), null);
  assert.equal(s.openConnections, 0);
  const got: string[] = []; const unsub = await s.subscribe('c', (m) => got.push(m));
  await s.publish('c', 'w'); await until(() => got.length === 1); await unsub(); await s.publish('c', 'w');
  await new Promise((r) => setTimeout(r, 5)); assert.equal(got.length, 1); assert.equal(s.openConnections, 0);
});

test('ack deletes entries through the cursor and keeps held bytes accurate', async () => {
  const { x } = await ctxWithBot();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await appendEntry(x, U, { reqId: `r${i}`, method: 'bridge_send', deadline: 0, sealed: 'x'.repeat(10) }));
  assert.deepEqual(await heldUsage(x, U), { entries: 3, bytes: 30 });
  assert.equal(await ackThrough(x, U, ids[1]!), 2);
  assert.deepEqual(await heldUsage(x, U), { entries: 1, bytes: 10 });
});

// --- crypto ------------------------------------------------------------------------------------------------------------

test('sealed boxes open only with the matching X25519 key', async () => {
  const a = await x25519KeyPair(), b = await x25519KeyPair();
  const s = await seal('secret', a.publicKey);
  assert.equal(Buffer.from((await unseal(s, a))!).toString(), 'secret');
  assert.equal(await unseal(s, b), null);
  assert.equal(await unseal('!!notbase64', a), null);
});

test('ed25519 signer and verify; raw seed signer is deterministic', async () => {
  const s = ed25519Signer(); const m = Buffer.from('m');
  assert.ok(ed25519Verify(s.publicKey, m, await s.sign(m)));
  assert.ok(!ed25519Verify(s.publicKey, Buffer.from('n'), await s.sign(m)));
  const seed = new Uint8Array(32).fill(7);
  assert.deepEqual(ed25519SignerFromRaw(seed).publicKey, ed25519SignerFromRaw(seed).publicKey);
});

// --- MCP handler -------------------------------------------------------------------------------------------------------

test('mcp: GET -> 405, unsupported protocol header -> 400, oversize -> 413, batch -> 400', async () => {
  const { x } = await ctxWithBot();
  assert.equal((await handleMcp(x, req({}, { method: 'GET' }))).status, 405);
  assert.equal((await handleMcp(x, req(rpc('ping'), { protocolVersion: '1999-01-01' }))).status, 400);
  assert.equal((await handleMcp(x, req(rpc('ping'), { protocolVersion: undefined }))).status, 200);
  assert.equal((await handleMcp(x, req({}, { body: null }))).status, 413);
  assert.equal((await handleMcp(x, req([rpc('ping')]))).status, 400);
});

test('mcp: token checked first (401 for missing, wrong, unknown bot)', async () => {
  const { x } = await ctxWithBot();
  for (const over of [{ authorization: undefined }, { authorization: 'Bearer nope' }, { botId: 'otherbot1' }, { authorization: TOKEN }]) {
    const r = await handleMcp(x, req(rpc('tools/list'), over));
    assert.equal(r.status, 401);
    assert.deepEqual((r.body as { error: unknown }).error, { code: -32001, message: 'Invalid or revoked agentbridge token.' });
  }
});

test('mcp: initialize negotiates the version; no session id; notifications -> 202', async () => {
  const { x } = await ctxWithBot();
  for (const v of MCP_PROTOCOL_VERSIONS) {
    const r = await handleMcp(x, req(rpc('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'c', version: '1' } })));
    assert.equal((r.body as { result: { protocolVersion: string } }).result.protocolVersion, v);
    assert.equal(r.headers?.['mcp-session-id'], undefined);
  }
  const r = await handleMcp(x, req(rpc('initialize', { protocolVersion: '2030-01-01' })));
  assert.equal((r.body as { result: { protocolVersion: string } }).result.protocolVersion, '2025-11-25');
  assert.equal((await handleMcp(x, req({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202);
  assert.equal((await handleMcp(x, req(rpc('nope')))).status, 200);
});

test('mcp: tools/list follows the bot discovery mode', async () => {
  const names = async (d: 'names' | 'none') => {
    const { x } = await ctxWithBot(d);
    return ((await handleMcp(x, req(rpc('tools/list')))).body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  };
  assert.ok((await names('names')).includes('bridge_list_agents'));
  assert.ok(!(await names('none')).includes('bridge_list_agents'));
  assert.equal((await names('none')).length, 6);
});

test('mcp tools/call: unknown/hidden tool, bad args, too large body', async () => {
  const { x } = await ctxWithBot('none');
  assert.equal(toolData(await handleMcp(x, req(rpc('tools/call', { name: 'bridge_list_agents' })))).data.reason, 'invalid_message');
  assert.equal(toolData(await handleMcp(x, req(rpc('tools/call', { name: 'bridge_send', arguments: [1] })))).data.reason, 'invalid_message');
  const big = toolData(await handleMcp(x, req(rpc('tools/call', { name: 'bridge_send', arguments: { conversation_id: 'c', body: 'x'.repeat(LIMITS.bodyBytes + 1) } }))));
  assert.deepEqual([big.isError, big.data.reason], [true, 'too_large']);
});

test('mcp tools/call offline: read fails fast without touching the stream; send is sealed and held', async () => {
  const { x, store, kp } = await ctxWithBot();
  const t0 = Date.now();
  const read = toolData(await handleMcp(x, req(rpc('tools/call', { name: 'bridge_list_conversations', arguments: {} }))));
  assert.equal(read.data.reason, 'bridge_offline'); assert.ok(Date.now() - t0 < 80);
  assert.equal(await store.xlen(x.k.inbox(U)), 0);
  const send = toolData(await handleMcp(x, req(rpc('tools/call', { name: 'bridge_send', arguments: { conversation_id: '01JD0000000000000000000000', body: 'hi' } }))));
  assert.deepEqual(send.data.status, 'held_relay');
  const [[, f]] = (await store.xrange(x.k.inbox(U), '-', '+')) as [[string, Record<string, string>]];
  assert.equal(f.m, 'bridge_send'); assert.equal(f.c, '01JD0000000000000000000000'); assert.equal(f.v, '1');
  const call = JSON.parse(Buffer.from((await unseal(f.s!, kp))!).toString());
  assert.deepEqual([call.method, call.caller, call.token, call.params.body], ['bridge_send', B, TOKEN, 'hi']);
});

test('mcp tools/call online: waits for res; deadline -> held (holdable) or bridge_offline (read, entry removed)', async () => {
  const { x, store } = await ctxWithBot();
  await store.set(x.k.conn(U), 'c1');
  // answer the next request like a bridge would
  const answer = async () => {
    await until(async () => (await store.xlen(x.k.inbox(U))) > 0);
    const [[, f]] = (await store.xrange(x.k.inbox(U), '-', '+')) as [[string, Record<string, string>]];
    await store.pushExpire(x.k.res(U, f.r!), JSON.stringify({ v: 1, result: { status: 'delivered' } }), 1000);
  };
  const [r] = await Promise.all([handleMcp(x, req(rpc('tools/call', { name: 'bridge_send', arguments: { conversation_id: 'c', body: 'b' } }))), answer()]);
  assert.deepEqual(toolData(r).data, { status: 'delivered' });
  await store.del(x.k.inbox(U));
  assert.equal(toolData(await handleMcp(x, req(rpc('tools/call', { name: 'bridge_end_conversation', arguments: { conversation_id: '01JD0000000000000000000000' } })))).data.status, 'held_relay');
  await store.del(x.k.inbox(U));
  assert.equal(toolData(await handleMcp(x, req(rpc('tools/call', { name: 'bridge_get_messages', arguments: { conversation_id: 'c' } })))).data.reason, 'bridge_offline');
  assert.equal(await store.xlen(x.k.inbox(U)), 0);
});

test('mcp tools/call: held queue limits (entries)', async () => {
  const { x } = await ctxWithBot();
  for (let i = 0; i < LIMITS.relayHeldEntries; i++) await x.store.xadd(x.k.inbox(U), { v: '1', n: '0' });
  const r = toolData(await handleMcp(x, req(rpc('tools/call', { name: 'bridge_send', arguments: { conversation_id: 'c', body: 'b' } }))));
  assert.deepEqual([r.data.reason, r.data.message], ['rate_limited', "The user's relay queue is full. Try again later."]);
});

test('mcp tools/call: held queue limits (bytes)', async () => {
  const { x } = await ctxWithBot();
  await x.store.incr(x.k.heldBytes(U), LIMITS.relayHeldBytes);
  assert.equal(toolData(await handleMcp(x, req(rpc('tools/call', { name: 'bridge_send', arguments: { conversation_id: 'c', body: 'b' } })))).data.reason, 'rate_limited');
});

test('mcp error texts are short and contain no internals', async () => {
  const { TEXT } = await import('../src/mcp.ts');
  for (const t of Object.values(TEXT)) { assert.ok(t.length <= 100, t); assert.doesNotMatch(t, /redis|stack|vercel|upstash|error:/i); }
});

// --- identity and control ------------------------------------------------------------------------------------------------

async function identityCtx() { return makeCtx({ store: new MemoryStore(), keyPrefix: 'i:' }); }

test('identity: create 201, repeat 200, other keys 409, bad signature 401, malformed 400', async () => {
  const x = await identityCtx(); const id = await newIdentity(); const body = await identityBody(id);
  const post = (b: unknown, ip = '1.1.1.1') => handleIdentity(x, 'POST', Buffer.from(JSON.stringify(b)), ip);
  const r = await post(body);
  assert.equal(r.status, 201); assert.equal((r.body as { user_id: string }).user_id, id.userId);
  assert.equal((await post(body)).status, 200);
  const other = await x25519KeyPair(); const xo = b64(other.publicKey);
  assert.equal((await post({ ...body, x25519_pub: xo, sig: b64(await id.signer.sign(relayX25519Statement(id.userId, xo))) })).status, 409);
  assert.equal((await post({ ...body, sig: b64(new Uint8Array(64)) })).status, 401);
  assert.equal((await post({ ed25519_pub: 'x' })).status, 400);
  assert.equal((await handleIdentity(x, 'GET', Buffer.alloc(0), 'ip')).status, 405);
  assert.equal((await handleIdentity(x, 'POST', null, 'ip')).status, 413);
});

test('identity: at most 5 creations per IP per day', async () => {
  const x = await identityCtx();
  for (let i = 0; i < LIMITS.relayIdentityPerIpPerDay; i++) assert.equal((await handleIdentity(x, 'POST', Buffer.from(JSON.stringify(await identityBody(await newIdentity()))), '9.9.9.9')).status, 201);
  const r = await handleIdentity(x, 'POST', Buffer.from(JSON.stringify(await identityBody(await newIdentity()))), '9.9.9.9');
  assert.equal(r.status, 429);
  assert.equal((await handleIdentity(x, 'POST', Buffer.from(JSON.stringify(await identityBody(await newIdentity()))), '8.8.8.8')).status, 201);
  assert.ok(!(x.store as MemoryStore).dump().includes('9.9.9.9'), 'IPs are stored hashed');
});

async function controlCtx() {
  const x = await identityCtx(); const id = await newIdentity();
  await handleIdentity(x, 'POST', Buffer.from(JSON.stringify(await identityBody(id))), 'ip');
  return { x, id };
}

test('control: register_bot / set_discovery / revoke_bot', async () => {
  const { x, id } = await controlCtx(); const u = id.userId;
  assert.deepEqual(await handleControl(x, u, 'register_bot', { bot_id: B, token_hash: botTokenHash('t'), discovery: 'names' }), { result: { ok: true, bot_id: B } });
  assert.ok('error' in await handleControl(x, u, 'register_bot', { bot_id: B, token_hash: 'short', discovery: 'names' }));
  assert.ok('error' in await handleControl(x, u, 'register_bot', { bot_id: 'BAD!', token_hash: botTokenHash('t'), discovery: 'names' }));
  assert.deepEqual(await handleControl(x, u, 'set_discovery', { bot_id: B, mode: 'none' }), { result: { ok: true } });
  assert.equal(JSON.parse((await x.store.get(x.k.bot(u, B)))!).discovery, 'none');
  assert.ok('error' in await handleControl(x, u, 'set_discovery', { bot_id: 'nobot123', mode: 'none' }));
  assert.deepEqual(await handleControl(x, u, 'revoke_bot', { bot_id: B }), { result: { ok: true } });
  assert.equal(await x.store.get(x.k.bot(u, B)), null);
  assert.ok('error' in await handleControl(x, u, 'bogus', {}));
  assert.ok('error' in await handleControl(x, 'b'.repeat(26), 'revoke_bot', { bot_id: B }), 'unknown user');
});

test('control: bots per user are capped', async () => {
  const { x, id } = await controlCtx();
  for (let i = 0; i < LIMITS.relayBotsPerUser; i++) assert.ok('result' in await handleControl(x, id.userId, 'register_bot', { bot_id: `bot${String(i).padStart(5, '0')}`, token_hash: botTokenHash('t'), discovery: 'names' }));
  assert.ok('error' in await handleControl(x, id.userId, 'register_bot', { bot_id: 'onemore12', token_hash: botTokenHash('t'), discovery: 'names' }));
  assert.ok('result' in await handleControl(x, id.userId, 'register_bot', { bot_id: 'bot00000', token_hash: botTokenHash('t2'), discovery: 'none' }), 're-register is not a new bot');
});

test('control: register_x25519 and rotate_identity need a signature by the current key; user_id stays fixed', async () => {
  const { x, id } = await controlCtx(); const u = id.userId;
  const nx = b64((await x25519KeyPair()).publicKey);
  assert.ok('error' in await handleControl(x, u, 'register_x25519', { pub: nx, sig: b64(await ed25519Signer().sign(relayX25519Statement(u, nx))) }));
  assert.ok('result' in await handleControl(x, u, 'register_x25519', { pub: nx, sig: b64(await id.signer.sign(relayX25519Statement(u, nx))) }));
  assert.equal(JSON.parse((await x.store.get(x.k.user(u)))!).x25519_pub, nx);

  const ne = ed25519Signer(); const ne64 = b64(ne.publicKey);
  assert.ok('error' in await handleControl(x, u, 'rotate_identity', { new_ed25519_pub: ne64, new_x25519_pub: nx, sig_by_old: b64(await ne.sign(relayRotateStatement(u, ne64, nx))) }));
  assert.deepEqual(await handleControl(x, u, 'rotate_identity', { new_ed25519_pub: ne64, new_x25519_pub: nx, sig_by_old: b64(await id.signer.sign(relayRotateStatement(u, ne64, nx))) }), { result: { ok: true, user_id: u } });
  const rec = JSON.parse((await x.store.get(x.k.user(u)))!);
  assert.equal(rec.ed25519_pub, ne64);
  assert.notEqual(userIdFromPubkey(ne.publicKey), u);
});

// --- routing -----------------------------------------------------------------------------------------------------------

test('logical path: direct and Vercel-rewritten forms', () => {
  assert.equal(logicalPath('/v1/connect'), '/v1/connect');
  assert.equal(logicalPath('/api/relay?__p=/v1/u/x/b/y/mcp'), '/v1/u/x/b/y/mcp');
  assert.equal(logicalPath('/api/relay?__p=v1/identity'), '/v1/identity');
  assert.equal(logicalPath('/v1/identity?__p=/v1/connect'), '/v1/identity');
});

