// Relay contract (§13). The `wake` frame doubles as the relay's heartbeat (LIMITS.relayHeartbeatMs). WebSocket GET /v1/connect between bridge and relay; Grok-facing MCP at /v1/u/<user>/b/<bot>/mcp.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { zReason } from './enums.ts';

export const RELAY_PROTOCOL = 1;
export const RELAY_AUTH_CONTEXT = 'agentbridge-relay-auth-v1';
export const RELAY_STREAM_FORMAT = 1; // stream entries and res keys carry this; bump with side-by-side support (§13.2)

/** Exact bytes the bridge signs with Ed25519 during the handshake. */
export function relayAuthMessage(relayHost: string, nonce: string, ts: number): Buffer {
  return Buffer.from(`${RELAY_AUTH_CONTEXT}\n${relayHost}\n${nonce}\n${ts}`, 'utf8');
}

/** On-demand idle check (§13.2): `POST /v1/pending`, signed over these exact bytes; `ts` (ms) within ±60 s. Read-only. */
export const RELAY_PENDING_CONTEXT = 'agentbridge-relay-pending-v1';
export function relayPendingMessage(relayHost: string, ts: number): Buffer {
  return Buffer.from(`${RELAY_PENDING_CONTEXT}\n${relayHost}\n${ts}`, 'utf8');
}
/** Header names for the pending check (hyphenated: some proxies drop header names with underscores). */
export const RELAY_PENDING_HEADERS = { userId: 'x-agentbridge-user-id', ts: 'x-agentbridge-ts', sig: 'x-agentbridge-sig' } as const;
/** Answer of `POST /v1/pending`: entries waiting in the stream and the age of the oldest (null when none). */
export const zRelayPendingResponse = z.object({ pending: z.number().int().nonnegative(), oldest_ms: z.number().int().nonnegative().nullable() });

/** user_id = base32(sha256(ed25519_pubkey_raw32))[:26], RFC 4648 alphabet, lowercase (§13.2). */
export function userIdFromPubkey(rawPubkey: Uint8Array): string {
  if (rawPubkey.length !== 32) throw new Error('expected 32-byte raw Ed25519 public key');
  const h = createHash('sha256').update(rawPubkey).digest();
  const A = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, val = 0, out = '';
  for (const b of h) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.slice(0, 26);
}

/** Keys and signatures on the wire are standard base64 of the raw bytes (Ed25519/X25519 public keys: 32 bytes; signatures: 64). */
export const RELAY_KEY_CONTEXT = { x25519: 'agentbridge-relay-x25519-v1', rotate: 'agentbridge-relay-rotate-v1' } as const;

/** Exact bytes signed (Ed25519, current identity key) to register an X25519 encryption key: `POST /v1/identity` and `register_x25519` (§13.2). */
export function relayX25519Statement(userId: string, x25519PubB64: string): Buffer {
  return Buffer.from(`${RELAY_KEY_CONTEXT.x25519}\n${userId}\n${x25519PubB64}`, 'utf8');
}

/** Exact bytes signed by the old Ed25519 key for `rotate_identity`; user_id stays fixed (§13.2). */
export function relayRotateStatement(userId: string, newEd25519PubB64: string, newX25519PubB64: string): Buffer {
  return Buffer.from(`${RELAY_KEY_CONTEXT.rotate}\n${userId}\n${newEd25519PubB64}\n${newX25519PubB64}`, 'utf8');
}

/** `register_bot.token_hash`: lowercase hex sha256 of the bot token's UTF-8 bytes. */
export const botTokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export const RELAY_PATHS = { connect: '/v1/connect', identity: '/v1/identity', pending: '/v1/pending' } as const;

export const zUserId = z.string().regex(/^[a-z2-7]{26}$/);
export const zBotId = z.string().regex(/^[a-z0-9]{8,32}$/);
export const grokMcpPath = (userId: string, botId: string): string => `/v1/u/${userId}/b/${botId}/mcp`;

/** WebSocket close codes used by the relay. */
export const RELAY_CLOSE = { unauthorized: 4401, superseded: 4409, protocolUnsupported: 4426, overloaded: 4429 } as const;

export const zRelayFrame = z.discriminatedUnion('type', [
  // handshake
  z.object({ type: z.literal('challenge'), protocol: z.number().int(), nonce: z.string(), ts: z.number().int() }),
  z.object({ type: z.literal('auth'), protocol: z.number().int(), user_id: zUserId, pubkey: z.string(), sig: z.string(), conn_id: z.string(), cursor: z.string().optional() }),
  z.object({ type: z.literal('ready'), conn_id: z.string(), server_time: z.number().int() }),
  // relay -> bridge: a Grok tool call (or held item). `sealed` is a libsodium sealed box (base64) of {method, params, caller, token}.
  // deadline_in_ms: how long the relay still waits for `res`, relative to sending (0 = nobody waits: a held item). Relative, so clock skew doesn't matter.
  z.object({ type: z.literal('req'), entry_id: z.string(), req_id: z.string(), format: z.number().int(), deadline_in_ms: z.number().int().nonnegative(), sealed: z.string() }),
  z.object({ type: z.literal('wake') }),
  // bridge -> relay
  z.object({ type: z.literal('res'), req_id: z.string(), result: z.unknown().optional(), error: z.object({ code: z.union([zReason, z.string()]), message: z.string() }).optional() }),
  z.object({ type: z.literal('ack'), cursor: z.string() }),
  z.object({ type: z.literal('ctl'), id: z.string(), method: z.string(), params: z.unknown() }),
  z.object({ type: z.literal('ctl_res'), id: z.string(), result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string() }).optional() }),
  // trimmed unacked entries (§13.4); kept by the relay until the bridge answers `expiry_ack` with the same cursor
  z.object({ type: z.literal('expiry'), cursor: z.string(), entries: z.array(z.object({ req_id: z.string(), method: z.string(), conversation_id: z.string().optional() })) }),
  z.object({ type: z.literal('expiry_ack'), cursor: z.string() }),
]);
export type RelayFrame = z.infer<typeof zRelayFrame>;

/** Bridge -> relay control methods (§13.3). */
export const RELAY_CONTROL = {
  register_bot: z.object({ bot_id: zBotId, token_hash: z.string(), discovery: z.enum(['names', 'none']) }),
  revoke_bot: z.object({ bot_id: zBotId }),
  set_discovery: z.object({ bot_id: zBotId, mode: z.enum(['names', 'none']) }),
  rotate_identity: z.object({ new_ed25519_pub: z.string(), new_x25519_pub: z.string(), sig_by_old: z.string() }),
  register_x25519: z.object({ pub: z.string(), sig: z.string() }),
} as const;

/** `POST /v1/identity`: create a relay identity. `sig` = Ed25519(relayX25519Statement(userIdFromPubkey(ed25519_pub), x25519_pub)). Answer: `{ user_id }`. */
export const zRelayIdentityRequest = z.object({ ed25519_pub: z.string(), x25519_pub: z.string(), sig: z.string() });

/** Decrypted content of a sealed `req`. The relay allocates conversation_id for starts (§13.3). */
export const zRelayCall = z.object({
  method: z.string(), // a Grok tool name, e.g. bridge_send
  params: z.record(z.string(), z.unknown()),
  caller: zBotId,
  token: z.string(), // bridge re-verifies against its own copy
  received_at: z.number().int(),
});
export type RelayCall = z.infer<typeof zRelayCall>;

/** Grok tools that may be held while the bridge is offline (§13.3); the rest fail with bridge_offline. */
export const HOLDABLE_GROK_TOOLS: ReadonlySet<string> = new Set(['bridge_send', 'bridge_start_conversation', 'bridge_end_conversation']);
