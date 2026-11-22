// Bot identity material (§12.5, §12.3): bot_id in the zBotId format and a 256-bit bearer token.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { botTokenHash, zBotId } from '@agentbridge/protocol';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 16 lowercase base32 characters (80 random bits); matches zBotId (/^[a-z0-9]{8,32}$/). */
export function mintBotId(): string {
  const bytes = randomBytes(10); let bits = 0, val = 0, out = '';
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  const id = out.slice(0, 16);
  if (!zBotId.safeParse(id).success) throw new Error('minted bot id does not match zBotId');
  return id;
}

/** 256-bit token, base64url (43 characters, no padding; safe to paste into a header value). */
export const mintBotToken = (): string => randomBytes(32).toString('base64url');

/** `register_bot.token_hash` (lowercase hex sha256 of the token's UTF-8 bytes): the protocol's definition. */
export { botTokenHash };

/** Constant-time check of a presented token against a stored hash. */
export function tokenMatchesHash(token: string, hashHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) return false;
  return timingSafeEqual(Buffer.from(botTokenHash(token), 'hex'), Buffer.from(hashHex, 'hex'));
}
