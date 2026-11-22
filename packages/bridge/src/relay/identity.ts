// Bridge identity (§13.2, §15.5): an Ed25519 signing key and an X25519 encryption key, kept in the SecretStore
// (keychain). user_id = userIdFromPubkey(ed25519 public key) never changes across rotations.
// Also the small HTTP calls `init` and `doctor` make to the relay: identity registration, health, signed pending check.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { RELAY_PATHS, RELAY_PENDING_HEADERS, SECRET_NAMES, relayPendingMessage, relayX25519Statement, userIdFromPubkey, type SecretStore } from '@agentbridge/protocol';

export interface Identity {
  userId: string;
  ed25519: { seed: Buffer; publicKey: Buffer };
  x25519: { publicKey: Buffer; privateKey: Buffer };
}

/** Mirrors `Ed25519Signer` / `X25519KeyPair` in @agentbridge/relay/client. */
export interface Signer { publicKey: Uint8Array; sign(message: Uint8Array): Uint8Array }

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');

function raw32(s: unknown): Buffer | null {
  if (typeof s !== 'string') return null;
  const b = Buffer.from(s, 'base64');
  return b.length === 32 ? b : null;
}

function edFromSeed(seed: Buffer): { seed: Buffer; publicKey: Buffer } {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  return { seed, publicKey: Buffer.from(createPublicKey(priv).export({ format: 'jwk' }).x!, 'base64url') };
}

export function signerFor(id: Identity): Signer {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, id.ed25519.seed]), format: 'der', type: 'pkcs8' });
  return { publicKey: id.ed25519.publicKey, sign: (m) => edSign(null, m, priv) };
}

export class IdentityCorruptError extends Error {}

/** Read the identity from the SecretStore; null if none was created yet. Throws if only part of it exists. */
export async function loadIdentity(secrets: SecretStore): Promise<Identity | null> {
  const ed = await secrets.get(SECRET_NAMES.ed25519); const x = await secrets.get(SECRET_NAMES.x25519);
  if (ed === null && x === null) return null;
  if (ed === null || x === null) throw new IdentityCorruptError('only one of the identity keys is in the keychain; run agentbridge identity rotate');
  let edj: { seed?: unknown }; let xj: { pub?: unknown; priv?: unknown };
  try { edj = JSON.parse(ed) as typeof edj; xj = JSON.parse(x) as typeof xj; } catch { throw new IdentityCorruptError('identity keys in the keychain are not readable'); }
  const seed = raw32(edj.seed); const xpub = raw32(xj.pub); const xpriv = raw32(xj.priv);
  if (!seed || !xpub || !xpriv) throw new IdentityCorruptError('identity keys in the keychain are malformed');
  const edk = edFromSeed(seed);
  return { userId: userIdFromPubkey(edk.publicKey), ed25519: edk, x25519: { publicKey: xpub, privateKey: xpriv } };
}

/** Load the identity, or create and store a new one (init step 2). Idempotent. */
export async function ensureIdentity(secrets: SecretStore): Promise<{ identity: Identity; created: boolean }> {
  const existing = await loadIdentity(secrets);
  if (existing) return { identity: existing, created: false };
  const edPriv = generateKeyPairSync('ed25519').privateKey;
  const seed = Buffer.from(edPriv.export({ format: 'jwk' }).d!, 'base64url');
  const xk = generateKeyPairSync('x25519');
  const xjwk = xk.privateKey.export({ format: 'jwk' });
  const xpub = Buffer.from(xjwk.x!, 'base64url'); const xpriv = Buffer.from(xjwk.d!, 'base64url');
  // write the encryption key first: a crash between the two writes leaves no half identity that loadIdentity accepts
  await secrets.set(SECRET_NAMES.x25519, JSON.stringify({ v: 1, pub: b64(xpub), priv: b64(xpriv) }));
  await secrets.set(SECRET_NAMES.ed25519, JSON.stringify({ v: 1, seed: b64(seed) }));
  const identity = await loadIdentity(secrets);
  if (!identity) throw new IdentityCorruptError('identity was not stored');
  return { identity, created: true };
}

export const x25519Statement = relayX25519Statement;
export const pendingMessage = relayPendingMessage;
export const RELAY_HTTP = { identity: RELAY_PATHS.identity, pending: RELAY_PATHS.pending, health: '/v1/health' } as const;
const PENDING_HEADERS = RELAY_PENDING_HEADERS;

export class RelayHttpError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const httpBase = (url: string): URL => { const u = new URL(url); if (u.protocol === 'wss:') u.protocol = 'https:'; if (u.protocol === 'ws:') u.protocol = 'http:'; return u; };

async function readError(r: Response): Promise<RelayHttpError> {
  let code = `http_${r.status}`; let message = `relay answered ${r.status}`;
  try { const j = (await r.json()) as { error?: { code?: string; message?: string }; code?: string; message?: string }; code = j.error?.code ?? j.code ?? code; message = j.error?.message ?? j.message ?? message; } catch { /* not JSON */ }
  return new RelayHttpError(r.status, code, message);
}

/** POST /v1/identity (§13.2). 201 created, 200 already registered with the same keys; 409 = other keys exist. */
export async function registerIdentity(relayUrl: string, id: Identity, f: typeof fetch = fetch): Promise<{ user_id: string; created: boolean }> {
  const xpub = b64(id.x25519.publicKey);
  const sig = b64(signerFor(id).sign(x25519Statement(id.userId, xpub)));
  const r = await f(new URL(RELAY_HTTP.identity, httpBase(relayUrl)), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ed25519_pub: b64(id.ed25519.publicKey), x25519_pub: xpub, sig }), signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 200 && r.status !== 201) throw await readError(r);
  const j = (await r.json()) as { user_id?: string; created?: boolean; data?: { user_id?: string; created?: boolean } };
  const body = j.data ?? j;
  if (body.user_id !== id.userId) throw new RelayHttpError(r.status, 'invalid_message', `relay returned user id ${String(body.user_id)}, expected ${id.userId}`);
  return { user_id: id.userId, created: body.created === true };
}

/** GET /v1/health. */
export async function relayHealth(relayUrl: string, f: typeof fetch = fetch): Promise<{ ok: boolean; status: number; ms: number }> {
  const t0 = Date.now();
  const r = await f(new URL(RELAY_HTTP.health, httpBase(relayUrl)), { signal: AbortSignal.timeout(10_000) });
  return { ok: r.ok, status: r.status, ms: Date.now() - t0 };
}

/** Signed POST /v1/pending: proves the relay knows this identity and reports waiting entries. */
export async function relayPending(relayUrl: string, id: Identity, f: typeof fetch = fetch, now: number = Date.now()): Promise<{ pending: number; oldest_ms: number | null }> {
  const u = httpBase(relayUrl);
  const sig = b64(signerFor(id).sign(pendingMessage(u.host, now)));
  const r = await f(new URL(RELAY_HTTP.pending, u), {
    method: 'POST', headers: { [PENDING_HEADERS.userId]: id.userId, [PENDING_HEADERS.ts]: String(now), [PENDING_HEADERS.sig]: sig }, signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw await readError(r);
  const j = (await r.json()) as { pending?: number; oldest_ms?: number | null; data?: { pending?: number; oldest_ms?: number | null } };
  const body = j.data ?? j;
  return { pending: Number(body.pending ?? 0), oldest_ms: body.oldest_ms ?? null };
}
