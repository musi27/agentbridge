// ULIDs (Crockford base32, 48-bit ms time + 80-bit randomness, monotonic within a ms) and tag nonces.
import { randomBytes } from 'node:crypto';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRand: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  for (let i = 0; i < 10; i++) { out = B32[ms % 32] + out; ms = Math.floor(ms / 32); }
  return out;
}

/** New ULID. Monotonic: two ids in the same millisecond sort in creation order. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    // increment the 80-bit random part (16 base32 digits)
    let i = lastRand.length - 1;
    while (i >= 0 && lastRand[i] === 31) { lastRand[i] = 0; i--; }
    if (i < 0) throw new Error('ulid: random overflow within one millisecond');
    lastRand[i] = (lastRand[i] ?? 0) + 1;
  } else {
    const bytes = randomBytes(16);
    lastRand = Array.from(bytes, (b) => b % 32);
    lastTime = now;
  }
  return encodeTime(now) + lastRand.map((d) => B32[d]).join('');
}

export const isUlid = (s: unknown): s is string => typeof s === 'string' && ULID_RE.test(s);

/** Short display id: last 6 characters of a ULID (random part). */
export const shortId = (id: string): string => id.slice(-6).toLowerCase();

/** Per-session tag nonce: 8 lowercase hex characters (§8.1). */
export const newNonce = (): string => randomBytes(4).toString('hex');
export const NONCE_RE = /^[0-9a-f]{8}$/;
