// Ed25519 (node:crypto) and X25519 sealed boxes (libsodium crypto_box_seal, §13.4/§13.6).
import { createPublicKey, createPrivateKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import sodium from 'libsodium-wrappers';

let readyP: Promise<void> | undefined;
export const sodiumReady = (): Promise<void> => (readyP ??= sodium.ready);

export const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
/** Decode base64 (standard or url-safe); null if malformed or not `len` bytes. */
export function fromB64(s: unknown, len?: number): Buffer | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  return len !== undefined && b.length !== len ? null : b;
}

export function ed25519PublicKey(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
}

export function ed25519Verify(rawPub: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean {
  if (rawPub.length !== 32 || sig.length !== 64) return false;
  try { return edVerify(null, message, ed25519PublicKey(rawPub), sig); } catch { return false; }
}

/** An Ed25519 identity the caller owns. The relay client only needs `publicKey` and `sign`. */
export interface Ed25519Signer { publicKey: Uint8Array; sign(message: Uint8Array): Uint8Array | Promise<Uint8Array> }

/** Convenience for tests and the CLI: a signer from a fresh or given node KeyObject. */
export function ed25519Signer(privateKey?: KeyObject): Ed25519Signer {
  const priv = privateKey ?? generateKeyPairSync('ed25519').privateKey;
  const jwk = createPublicKey(priv).export({ format: 'jwk' });
  const publicKey = Buffer.from(jwk.x!, 'base64url');
  return { publicKey, sign: (m) => edSign(null, m, priv) };
}

export function ed25519SignerFromRaw(seed32: Uint8Array): Ed25519Signer {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed32)]);
  return ed25519Signer(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
}

export interface X25519KeyPair { publicKey: Uint8Array; privateKey: Uint8Array }

export async function x25519KeyPair(): Promise<X25519KeyPair> {
  await sodiumReady();
  const k = sodium.crypto_box_keypair();
  return { publicKey: k.publicKey, privateKey: k.privateKey };
}

export async function seal(plaintext: string | Uint8Array, x25519Pub: Uint8Array): Promise<string> {
  await sodiumReady();
  return b64(sodium.crypto_box_seal(plaintext, x25519Pub));
}

/** Opens a sealed box; null if it was not sealed to this key or is corrupt. */
export async function unseal(sealedB64: string, keys: X25519KeyPair): Promise<Uint8Array | null> {
  await sodiumReady();
  const c = fromB64(sealedB64); if (!c) return null;
  try { return sodium.crypto_box_seal_open(c, keys.publicKey, keys.privateKey); } catch { return null; }
}
