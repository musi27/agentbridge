// Live smoke test against a deployed relay (small traffic): node scripts/smoke.ts https://<your-relay-host>
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { botTokenHash, grokMcpPath, relayX25519Statement, userIdFromPubkey } from '@agentbridge/protocol';
import { RelayClient, ed25519SignerFromRaw, type X25519KeyPair } from '../src/client.ts';
import { x25519KeyPair } from '../src/crypto.ts';
import { b64 } from '../src/crypto.ts';

const base = process.argv[2];
if (!base) { console.error('usage: node scripts/smoke.ts https://<your-relay-host>'); process.exit(2); }
// Reuse one identity across runs (SMOKE_IDENTITY=<file>, kept outside the repo) so runs don't spend the
// relay's 5-new-identities-per-IP-per-day allowance. Without it, each run creates a fresh identity.
const idFile = process.env.SMOKE_IDENTITY;
let seed: Buffer, x: X25519KeyPair;
if (idFile && existsSync(idFile)) {
  const j = JSON.parse(readFileSync(idFile, 'utf8'));
  seed = Buffer.from(j.seed, 'base64'); x = { publicKey: Buffer.from(j.xpub, 'base64'), privateKey: Buffer.from(j.xpriv, 'base64') };
} else {
  seed = randomBytes(32); x = await x25519KeyPair();
  if (idFile) writeFileSync(idFile, JSON.stringify({ seed: seed.toString('base64'), xpub: b64(x.publicKey), xpriv: b64(x.privateKey) }), { mode: 0o600 });
}
const signer = ed25519SignerFromRaw(seed); const userId = userIdFromPubkey(signer.publicKey);
const step = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) process.exitCode = 1; };

const xp = b64(x.publicKey);
const reg = await fetch(`${base}/v1/identity`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ed25519_pub: b64(signer.publicKey), x25519_pub: xp, sig: b64(await signer.sign(relayX25519Statement(userId, xp))) }) });
step('identity', reg.status === 201 || reg.status === 200, String(reg.status));

const got: string[] = [];
// on_demand (the default) with a short pending interval so the idle pickup is quick to observe
const mk = () => new RelayClient({ url: base, userId, signer, x25519: x, mode: 'on_demand', pendingPollMs: 4000, activeWindowMs: 60_000, ensureGraceMs: 2000, onCall: async (c) => {
  got.push(String(c.call.params.body));
  if (c.call.method === 'bridge_get_transcript') return { result: { blob: 'x'.repeat(Number(c.call.params.limit) * 1024) } };
  return { result: { status: 'delivered', held: c.held } };
} });
let c = mk(); await c.start();
step('on_demand starts idle', !c.connected);
const botId = randomBytes(6).toString('hex'), token = randomBytes(32).toString('base64url');
await c.control('register_bot', { bot_id: botId, token_hash: botTokenHash(token), discovery: 'names' }); step('register_bot (ensureConnected, signed wss challenge)', true);
c.markActive(); await c.waitReady(15_000); step('markActive holds a connection', c.connected);

const url = base + grokMcpPath(userId, botId);
let n = 0;
const rpc = async (method: string, params: unknown, tok = token) => {
  const t0 = performance.now();
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any, ms: Math.round(performance.now() - t0) };
};
const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
step('initialize', init.body?.result?.protocolVersion === '2025-11-25');
step('tools/list', (await rpc('tools/list', {})).body?.result?.tools?.length === 7);
step('wrong token -> 401', (await rpc('tools/list', {}, 'nope')).status === 401);
const times: number[] = [];
for (let i = 0; i < 5; i++) {
  const r = await rpc('tools/call', { name: 'bridge_send', arguments: { conversation_id: '01JD0000000000000000000000', body: `live-${i}` } });
  times.push(r.ms);
  step(`round trip ${i}`, JSON.parse(r.body?.result?.content?.[0]?.text ?? '{}').status === 'delivered', `${r.ms} ms`);
}
let drops = 0; c.on('disconnected', () => drops++);
const big = await rpc('tools/call', { name: 'bridge_get_transcript', arguments: { conversation_id: '01JD0000000000000000000000', limit: 100 } });
step('100 KB result round-trips', JSON.parse(big.body?.result?.content?.[0]?.text ?? '{}').blob?.length === 100 * 1024, `${big.ms} ms`);
const huge = await rpc('tools/call', { name: 'bridge_get_transcript', arguments: { conversation_id: '01JD0000000000000000000000', limit: 1100 } });
step('>1 MB result -> too_large, socket kept', JSON.parse(huge.body?.result?.content?.[0]?.text ?? '{}').reason === 'too_large' && drops === 0 && c.connected);
await c.stop();
// a fresh on_demand client with no activity: it idles and only polls /v1/pending
c = mk(); let pendingChecks = 0; c.on('pending', () => pendingChecks++); await c.start();
const w0 = Date.now(); while (pendingChecks < 1 && Date.now() - w0 < 10_000) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 1500)); // presence key of the stopped client expires/clears
step('idle: pending check answered, not connected', pendingChecks >= 1 && !c.connected);
const read = await rpc('tools/call', { name: 'bridge_list_conversations', arguments: {} });
step('idle: read -> bridge_offline', JSON.parse(read.body?.result?.content?.[0]?.text ?? '{}').reason === 'bridge_offline', `${read.ms} ms`);
const held = await rpc('tools/call', { name: 'bridge_send', arguments: { conversation_id: '01JD0000000000000000000000', body: 'while-idle' } });
step('idle: write -> held_relay', JSON.parse(held.body?.result?.content?.[0]?.text ?? '{}').status === 'held_relay', `${held.ms} ms`);
const t0 = Date.now(); while (!got.includes('while-idle') && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 100));
step('idle: held write picked up via /v1/pending', got.includes('while-idle'), `${Date.now() - t0} ms (poll 4 s)`);
await c.control('revoke_bot', { bot_id: botId });
step('revoked -> 401', (await rpc('tools/list', {})).status === 401);
await c.stop();
console.log(`user ${userId.slice(0, 6)}… round trips ms: ${times.join(', ')}`);
