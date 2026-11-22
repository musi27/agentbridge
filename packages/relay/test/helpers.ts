// Test fixtures: a local relay on an ephemeral port with an in-memory store, identities, bots and Grok-style MCP calls.
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { botTokenHash, relayX25519Statement, userIdFromPubkey, grokMcpPath } from '@agentbridge/protocol';
import { createRelay, type Relay } from '../src/server.ts';
import { MemoryStore } from '../src/store.ts';
import type { RelayConfig } from '../src/core.ts';
import { b64, ed25519Signer, x25519KeyPair, type Ed25519Signer, type X25519KeyPair } from '../src/crypto.ts';
import { RelayClient, type RelayClientOptions } from '../src/client.ts';

export interface Running { relay: Relay; url: string; host: string; store: MemoryStore; stop(): Promise<void> }

export async function startRelay(cfg: Partial<RelayConfig> = {}, store = new MemoryStore()): Promise<Running> {
  const relay = createRelay({ store, keyPrefix: 't:', pollMs: 200, ...cfg });
  await new Promise<void>((r) => relay.server.listen(0, '127.0.0.1', () => r()));
  const port = (relay.server.address() as AddressInfo).port;
  return { relay, url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, store, stop: () => relay.close() };
}

export interface Identity { userId: string; signer: Ed25519Signer; x25519: X25519KeyPair }

export async function newIdentity(): Promise<Identity> {
  const signer = ed25519Signer();
  return { userId: userIdFromPubkey(signer.publicKey), signer, x25519: await x25519KeyPair() };
}

export async function identityBody(id: Identity) {
  const x = b64(id.x25519.publicKey);
  return { ed25519_pub: b64(id.signer.publicKey), x25519_pub: x, sig: b64(await id.signer.sign(relayX25519Statement(id.userId, x))) };
}

export async function register(url: string, id: Identity, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/v1/identity`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(await identityBody(id)) });
}

export const newBot = () => ({ botId: randomBytes(6).toString('hex'), token: randomBytes(32).toString('base64url') });

export function client(url: string, id: Identity, onCall: RelayClientOptions['onCall'], extra: Partial<RelayClientOptions> = {}): RelayClient {
  return new RelayClient({ url, userId: id.userId, signer: id.signer, x25519: id.x25519, onCall, mode: 'always', ...extra });
}

export async function registerBot(c: RelayClient, botId: string, token: string, discovery: 'names' | 'none' = 'names') {
  return c.control('register_bot', { bot_id: botId, token_hash: botTokenHash(token), discovery });
}

let rpcId = 0;
export async function mcp(url: string, userId: string, botId: string, token: string | null, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  const res = await fetch(url + grokMcpPath(userId, botId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', 'user-agent': 'Cursor/1.0.0', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** tools/call and decode the text content. */
export async function callTool(url: string, userId: string, botId: string, token: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(url, userId, botId, token, 'tools/call', { name, arguments: args });
  const result = r.body?.result;
  const text = result?.content?.[0]?.text as string | undefined;
  let data: unknown = text; try { data = text ? JSON.parse(text) : undefined; } catch { /* plain text */ }
  return { status: r.status, isError: result?.isError === true, data: data as Record<string, unknown>, raw: r.body };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) { if (Date.now() > end) throw new Error('until: timed out'); await sleep(stepMs); }
}

/** Relay + registered identity + connected client + bot, ready for calls. */
export async function setup(opts: { cfg?: Partial<RelayConfig>; client?: Partial<RelayClientOptions>; onCall?: RelayClientOptions['onCall']; store?: MemoryStore } = {}) {
  const r = await startRelay(opts.cfg, opts.store);
  const id = await newIdentity();
  const reg = await register(r.url, id);
  if (reg.status !== 201) throw new Error(`register ${reg.status}`);
  const calls: Parameters<RelayClientOptions['onCall']>[0][] = [];
  const onCall = opts.onCall ?? (async (c) => { calls.push(c); return { result: { status: 'ok', echo: c.call.params } }; });
  const c = client(r.url, id, async (call) => { if (opts.onCall) calls.push(call); return onCall(call); }, opts.client);
  await c.start(); await c.waitReady();
  const bot = newBot();
  await registerBot(c, bot.botId, bot.token);
  return { r, id, c, bot, calls, async stop() { await c.stop(); await r.stop(); } };
}
