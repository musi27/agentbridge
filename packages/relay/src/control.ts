// Identity creation (POST /v1/identity) and bridge -> relay control methods over the authenticated socket (§13.2–13.3, §13.5).
import { createHash } from 'node:crypto';
import { LIMITS, RELAY_CONTROL, relayRotateStatement, relayX25519Statement, userIdFromPubkey, zRelayIdentityRequest } from '@agentbridge/protocol';
import { getBot, getUser, putBot, putUser, type Ctx } from './core.ts';
import { ed25519Verify, fromB64 } from './crypto.ts';
import type { HttpReply } from './mcp.ts';

const fail = (status: number, code: string, message: string): HttpReply => ({ status, body: { error: { code, message } } });
const ipHash = (ip: string) => createHash('sha256').update(`agentbridge-ip\n${ip}`).digest('hex').slice(0, 32);

export async function handleIdentity(x: Ctx, method: string, body: Buffer | null, ip: string): Promise<HttpReply> {
  if (method !== 'POST') return { status: 405, headers: { allow: 'POST' } };
  if (body === null) return fail(413, 'too_large', 'Request too large.');
  let json: unknown; try { json = JSON.parse(body.toString('utf8')); } catch { return fail(400, 'invalid_message', 'Body must be JSON.'); }
  const p = zRelayIdentityRequest.safeParse(json);
  if (!p.success) return fail(400, 'invalid_message', 'Expected { ed25519_pub, x25519_pub, sig }.');
  const ed = fromB64(p.data.ed25519_pub, 32), xp = fromB64(p.data.x25519_pub, 32), sig = fromB64(p.data.sig, 64);
  if (!ed || !xp || !sig) return fail(400, 'invalid_message', 'Keys must be base64 of 32 raw bytes; sig 64 bytes.');
  const userId = userIdFromPubkey(ed);
  if (!ed25519Verify(ed, relayX25519Statement(userId, p.data.x25519_pub), sig)) return fail(401, 'invalid_message', 'Bad signature.');

  const existing = await getUser(x, userId);
  if (existing) {
    const same = Buffer.from(existing.ed25519_pub, 'base64').equals(ed) && Buffer.from(existing.x25519_pub, 'base64').equals(xp);
    return same ? { status: 200, body: { user_id: userId, created: false } } : fail(409, 'conflict', 'Identity exists with other keys; use rotate_identity.');
  }
  // Count first, atomically (INCR), so parallel creations from one address cannot pass the limit together.
  const day = Math.floor(x.now() / 86_400_000);
  const ipKey = x.k.ipCreations(ipHash(ip), day);
  if ((await x.store.incr(ipKey, 1, 86_400_000 * 2)) > LIMITS.relayIdentityPerIpPerDay) {
    await x.store.incr(ipKey, -1);
    return fail(429, 'rate_limited', `At most ${LIMITS.relayIdentityPerIpPerDay} new identities per day from one address.`);
  }
  const created = await putUser(x, userId, { ed25519_pub: Buffer.from(ed).toString('base64'), x25519_pub: Buffer.from(xp).toString('base64'), created_at: x.now() }, true);
  if (!created) { await x.store.incr(ipKey, -1); return fail(409, 'conflict', 'Identity was just created; retry.'); }
  x.log('identity_created', { user: userId });
  return { status: 201, body: { user_id: userId, created: true } };
}

export type CtlResult = { result: unknown } | { error: { code: string; message: string } };
const err = (code: string, message: string): CtlResult => ({ error: { code, message } });

/** Run one control method for an authenticated user. */
export async function handleControl(x: Ctx, u: string, method: string, params: unknown): Promise<CtlResult> {
  if (!Object.hasOwn(RELAY_CONTROL, method)) return err('invalid_message', `unknown control method ${method}`);
  const schema = RELAY_CONTROL[method as keyof typeof RELAY_CONTROL];
  const p = schema.safeParse(params);
  if (!p.success) return err('invalid_message', 'invalid params');
  const user = await getUser(x, u);
  if (!user) return err('not_allowed', 'unknown user');

  switch (method) {
    case 'register_bot': {
      const d = p.data as { bot_id: string; token_hash: string; discovery: 'names' | 'none' };
      if (!/^[0-9a-f]{64}$/.test(d.token_hash)) return err('invalid_message', 'token_hash must be hex sha256');
      const existing = await getBot(x, u, d.bot_id);
      if (!existing && (await x.store.incr(x.k.botCount(u), 1)) > LIMITS.relayBotsPerUser) {
        await x.store.incr(x.k.botCount(u), -1);
        return err('rate_limited', `at most ${LIMITS.relayBotsPerUser} bots`);
      }
      await putBot(x, u, d.bot_id, { token_hash: d.token_hash, discovery: d.discovery, created_at: existing?.created_at ?? x.now() });
      return { result: { ok: true, bot_id: d.bot_id } };
    }
    case 'revoke_bot': {
      const d = p.data as { bot_id: string };
      if (await x.store.del(x.k.bot(u, d.bot_id))) await x.store.incr(x.k.botCount(u), -1);
      return { result: { ok: true } };
    }
    case 'set_discovery': {
      const d = p.data as { bot_id: string; mode: 'names' | 'none' };
      const bot = await getBot(x, u, d.bot_id);
      if (!bot) return err('not_allowed', 'unknown bot');
      await putBot(x, u, d.bot_id, { ...bot, discovery: d.mode });
      return { result: { ok: true } };
    }
    case 'register_x25519': {
      const d = p.data as { pub: string; sig: string };
      const xp = fromB64(d.pub, 32), sig = fromB64(d.sig, 64), ed = fromB64(user.ed25519_pub, 32);
      if (!xp || !sig || !ed) return err('invalid_message', 'bad key encoding');
      if (!ed25519Verify(ed, relayX25519Statement(u, d.pub), sig)) return err('not_allowed', 'bad signature');
      await putUser(x, u, { ...user, x25519_pub: Buffer.from(xp).toString('base64') });
      return { result: { ok: true } };
    }
    case 'rotate_identity': {
      const d = p.data as { new_ed25519_pub: string; new_x25519_pub: string; sig_by_old: string };
      const ne = fromB64(d.new_ed25519_pub, 32), nx = fromB64(d.new_x25519_pub, 32), sig = fromB64(d.sig_by_old, 64), old = fromB64(user.ed25519_pub, 32);
      if (!ne || !nx || !sig || !old) return err('invalid_message', 'bad key encoding');
      if (!ed25519Verify(old, relayRotateStatement(u, d.new_ed25519_pub, d.new_x25519_pub), sig)) return err('not_allowed', 'bad signature');
      // user_id stays fixed across rotations (§13.2); the next handshake must use the new key.
      await putUser(x, u, { ...user, ed25519_pub: Buffer.from(ne).toString('base64'), x25519_pub: Buffer.from(nx).toString('base64'), rotated_at: x.now() });
      x.pubkeys.delete(u);
      x.log('identity_rotated', { user: u });
      return { result: { ok: true, user_id: u } };
    }
  }
  return err('invalid_message', 'unhandled');
}
