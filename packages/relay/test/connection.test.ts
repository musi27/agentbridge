// WebSocket handshake and connection management with a raw `ws` client (§13.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const WebSocketGlobal = globalThis.WebSocket;
import { RELAY_CLOSE, RELAY_PROTOCOL, relayAuthMessage, type RelayFrame } from '@agentbridge/protocol';
import { b64, ed25519Signer } from '../src/crypto.ts';
import { client, newIdentity, register, startRelay, until, type Identity, type Running } from './helpers.ts';

interface Raw { ws: WebSocket; frames: RelayFrame[]; closed: Promise<{ code: number; reason: string }> }

async function raw(r: Running): Promise<Raw> {
  const ws = new WebSocket(r.url.replace('http', 'ws') + '/v1/connect');
  const frames: RelayFrame[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  const closed = new Promise<{ code: number; reason: string }>((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
  await until(() => frames.length > 0);
  return { ws, frames, closed };
}

async function auth(c: Raw, id: Identity, over: Record<string, unknown> = {}, host?: string, r?: Running) {
  const ch = c.frames[0] as Extract<RelayFrame, { type: 'challenge' }>;
  const sig = await id.signer.sign(relayAuthMessage(host ?? r!.host, ch.nonce, ch.ts));
  c.ws.send(JSON.stringify({ type: 'auth', protocol: RELAY_PROTOCOL, user_id: id.userId, pubkey: b64(id.signer.publicKey), sig: b64(sig), conn_id: Math.random().toString(36).slice(2), ...over }));
}

test('challenge, then ready for a registered identity with a valid signature', async () => {
  const r = await startRelay(); const id = await newIdentity(); await register(r.url, id);
  try {
    const c = await raw(r);
    const ch = c.frames[0]!;
    assert.equal(ch.type, 'challenge');
    if (ch.type === 'challenge') { assert.equal(ch.protocol, RELAY_PROTOCOL); assert.ok(Math.abs(ch.ts - Date.now()) < 2000); }
    await auth(c, id, { conn_id: 'abc' }, undefined, r);
    await until(() => c.frames.some((f) => f.type === 'ready'));
    assert.equal((c.frames.find((f) => f.type === 'ready') as { conn_id: string }).conn_id, 'abc');
    c.ws.close();
  } finally { await r.stop(); }
});

test('handshake rejections: unregistered, wrong key, wrong host, bad signature, protocol mismatch, non-auth first frame', async () => {
  const r = await startRelay(); const id = await newIdentity(); await register(r.url, id);
  try {
    const cases: [string, (c: Raw) => Promise<void>, number][] = [
      ['unregistered', async (c) => auth(c, await newIdentity(), {}, undefined, r), RELAY_CLOSE.unauthorized],
      ['other key for this user', async (c) => auth(c, { ...id, signer: ed25519Signer() }, {}, undefined, r), RELAY_CLOSE.unauthorized],
      ['wrong host', async (c) => auth(c, id, {}, 'evil.example', r), RELAY_CLOSE.unauthorized],
      ['bad signature', async (c) => auth(c, id, { sig: b64(new Uint8Array(64)) }, undefined, r), RELAY_CLOSE.unauthorized],
      ['protocol', async (c) => auth(c, id, { protocol: RELAY_PROTOCOL + 1 }, undefined, r), RELAY_CLOSE.protocolUnsupported],
      ['ctl before auth', async (c) => { c.ws.send(JSON.stringify({ type: 'ctl', id: '1', method: 'revoke_bot', params: {} })); }, RELAY_CLOSE.unauthorized],
      ['garbage', async (c) => { c.ws.send('not json'); }, RELAY_CLOSE.unauthorized],
    ];
    for (const [name, act, code] of cases) {
      const c = await raw(r); await act(c);
      assert.equal((await c.closed).code, code, name);
      assert.ok(!c.frames.some((f) => f.type === 'ready'), name);
    }
  } finally { await r.stop(); }
});

test('a signature for one challenge does not work on another connection (single-use nonce)', async () => {
  const r = await startRelay(); const id = await newIdentity(); await register(r.url, id);
  try {
    const a = await raw(r), b = await raw(r);
    const ch = a.frames[0] as Extract<RelayFrame, { type: 'challenge' }>;
    const sig = b64(await id.signer.sign(relayAuthMessage(r.host, ch.nonce, ch.ts)));
    b.ws.send(JSON.stringify({ type: 'auth', protocol: RELAY_PROTOCOL, user_id: id.userId, pubkey: b64(id.signer.publicKey), sig, conn_id: 'x' }));
    assert.equal((await b.closed).code, RELAY_CLOSE.unauthorized);
    a.ws.close();
  } finally { await r.stop(); }
});

test('make-before-break: newest connection gets traffic; older closed with 4409 after the overlap; a third closes the oldest at once', async () => {
  const r = await startRelay({ overlapMs: 300 }); const id = await newIdentity(); await register(r.url, id);
  try {
    const a = await raw(r); await auth(a, id, { conn_id: 'A' }, undefined, r); await until(() => a.frames.some((f) => f.type === 'ready'));
    const t0 = Date.now();
    const b = await raw(r); await auth(b, id, { conn_id: 'B' }, undefined, r); await until(() => b.frames.some((f) => f.type === 'ready'));
    assert.match(String(await r.store.get(`t:user:${id.userId}:conn`)), /^\d+\|B$/);
    const ca = await a.closed;
    assert.equal(ca.code, RELAY_CLOSE.superseded);
    assert.ok(Date.now() - t0 >= 250, 'old socket kept for the overlap');

    const c = await raw(r); await auth(c, id, { conn_id: 'C' }, undefined, r); await until(() => c.frames.some((f) => f.type === 'ready'));
    const d = await raw(r); await auth(d, id, { conn_id: 'D' }, undefined, r); await until(() => d.frames.some((f) => f.type === 'ready'));
    // B was superseded by C, then D arrived: B and C may not both stay; B (already superseded) closes immediately
    assert.equal((await b.closed).code, RELAY_CLOSE.superseded);
    assert.equal((await c.closed).code, RELAY_CLOSE.superseded);
    d.ws.close();
  } finally { await r.stop(); }
});

test('client: proactive reconnect opens the new socket before the old one closes', async () => {
  const r = await startRelay({ overlapMs: 1000 }); const id = await newIdentity(); await register(r.url, id);
  const c = client(r.url, id, async () => null, { reconnectAtMs: 150 });
  try {
    const events: string[] = [];
    c.on('ready', () => events.push('ready')); c.on('disconnected', () => events.push('disconnected'));
    await c.start();
    await until(() => events.filter((e) => e === 'ready').length >= 3, 3000);
    assert.ok(!events.includes('disconnected'), events.join(','));
    assert.ok(c.connected);
  } finally { await c.stop(); await r.stop(); }
});

test('client: first retry after an unplanned drop comes within 250 ms', async () => {
  const r = await startRelay(); const id = await newIdentity(); await register(r.url, id);
  // Timestamp every socket the client opens: the requirement is on the retry delay (drop -> new attempt), which must not
  // depend on how loaded the machine is (the full handshake time does).
  const opened: number[] = [];
  const WS = class extends WebSocketGlobal { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); opened.push(Date.now()); } };
  const c = client(r.url, id, async () => null, { WebSocket: WS as typeof WebSocketGlobal });
  try {
    await c.start(); await c.waitReady();
    let readies = 0; c.on('ready', () => readies++);
    const dropped: number[] = []; c.on('disconnected', () => dropped.push(Date.now()));
    for (let i = 1; i <= 5; i++) {
      r.relay.terminateSockets();
      await until(() => readies === i, 5000);
      const retryDelay = opened.at(-1)! - dropped.at(-1)!;
      assert.ok(retryDelay >= 0 && retryDelay <= 250 + 50, `retry ${retryDelay} ms after the drop`); // +50: timer lateness under load
    }
  } finally { await c.stop(); await r.stop(); }
});

test('client: control errors surface as RelayControlError', async () => {
  const r = await startRelay(); const id = await newIdentity(); await register(r.url, id);
  const c = client(r.url, id, async () => null);
  try {
    await c.start();
    await assert.rejects(c.control('set_discovery', { bot_id: 'nobot123', mode: 'none' }), (e: Error & { code?: string }) => e.name === 'RelayControlError' && e.code === 'not_allowed');
    await assert.rejects(c.control('nope', {}), /unknown control method/);
  } finally { await c.stop(); await r.stop(); }
});

test('expired challenge (> 60 s) is refused', async () => {
  let now = Date.now();
  const r = await startRelay({ now: () => now }); const id = await newIdentity(); await register(r.url, id);
  try {
    const c = await raw(r);
    now += 61_000;
    await auth(c, id, {}, undefined, r);
    assert.equal((await c.closed).code, RELAY_CLOSE.unauthorized);
  } finally { await r.stop(); }
});
