// Grok-facing MCP endpoint: POST /v1/u/<user>/b/<bot>/mcp, stateless Streamable HTTP with JSON responses (§13.3, M0 V8a).
// Every text here can reach the Grok model verbatim: keep it short and free of internals.
import { GROK_TOOLS, HOLDABLE_GROK_TOOLS, LIMITS, RELAY_STREAM_FORMAT, ulid, isUlid, type RelayCall } from '@agentbridge/protocol';
import { appendEntry, getBot, getUser, heldUsage, removeEntry, tokenMatches, trimExpired, type BotRecord, type Ctx } from './core.ts';
import { fromB64, seal } from './crypto.ts';

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_MCP_VERSION = MCP_PROTOCOL_VERSIONS[0];
export const SERVER_INFO = { name: 'agentbridge-relay', version: '0.4.0' };

export const TEXT = {
  badToken: 'Invalid or revoked agentbridge token.',
  offline: "The user's computer is offline. Try again later.",
  held: "The user's computer is offline. This was queued and will be delivered when it reconnects.",
  tooLarge: `Message too large (max ${LIMITS.bodyBytes / 1024} KB).`,
  requestTooLarge: 'Request too large.',
  rateLimited: 'Too many requests. Wait a minute and try again.',
  queueFull: "The user's relay queue is full. Try again later.",
  unknownTool: 'Unknown tool.',
  badArgs: 'Invalid arguments.',
  notRegistered: 'This agentbridge connector is not set up yet.',
} as const;

type Json = Record<string, unknown>;
export interface HttpReply { status: number; headers?: Record<string, string>; body?: Json | undefined }

const rpcResult = (id: unknown, result: unknown): HttpReply => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
const rpcError = (id: unknown, code: number, message: string, status = 200): HttpReply => ({ status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } });
const toolText = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const toolFail = (reason: string, message: string) => toolText({ status: 'failed', reason, message }, true);

export function visibleTools(bot: BotRecord) {
  return GROK_TOOLS.filter((t) => bot.discovery !== 'none' || t.name !== 'bridge_list_agents')
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export interface McpRequest { method: string; userId: string; botId: string; authorization: string | undefined; protocolVersion: string | undefined; body: Buffer | null }

/** Pure-ish handler (store side effects only), so it can be unit-tested without HTTP. */
export async function handleMcp(x: Ctx, r: McpRequest): Promise<HttpReply> {
  if (r.method !== 'POST') return { status: 405, headers: { allow: 'POST' } };
  if (r.body === null) return rpcError(null, -32600, TEXT.requestTooLarge, 413);
  if (r.protocolVersion !== undefined && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(r.protocolVersion)) {
    return rpcError(null, -32600, 'Unsupported MCP-Protocol-Version.', 400);
  }
  // Early reject on the bearer token (§13.3 step 1), before parsing or touching the stream.
  const token = /^Bearer (\S+)$/i.exec(r.authorization ?? '')?.[1];
  const bot = token ? await getBot(x, r.userId, r.botId) : null;
  if (!token || !bot || !tokenMatches(token, bot.token_hash)) return rpcError(null, -32001, TEXT.badToken, 401);

  let msg: unknown;
  try { msg = JSON.parse(r.body.toString('utf8')); } catch { return rpcError(null, -32700, 'Parse error.', 400); }
  if (Array.isArray(msg)) return rpcError(null, -32600, 'Batch requests are not supported.', 400);
  if (!msg || typeof msg !== 'object') return rpcError(null, -32600, 'Invalid request.', 400);
  const m = msg as Json;
  if (typeof m.method !== 'string') return { status: 202 }; // a JSON-RPC response from the client
  if (m.id === undefined || m.method.startsWith('notifications/')) return { status: 202 };
  const id = m.id;
  const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Json;

  switch (m.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_MCP_VERSION;
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_MCP_VERSION;
      return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: visibleTools(bot) });
    case 'tools/call': return rpcResult(id, await callTool(x, r.userId, r.botId, bot, token, params));
    default: return rpcError(id, -32601, 'Method not found.');
  }
}

async function callTool(x: Ctx, u: string, b: string, bot: BotRecord, token: string, params: Json) {
  const name = params.name;
  if (typeof name !== 'string' || !visibleTools(bot).some((t) => t.name === name)) return toolFail('invalid_message', TEXT.unknownTool);
  const rawArgs = params.arguments ?? {};
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return toolFail('invalid_message', TEXT.badArgs);
  const args = { ...(rawArgs as Json) };
  if (typeof args.body === 'string' && Buffer.byteLength(args.body) > LIMITS.bodyBytes) return toolFail('too_large', TEXT.tooLarge);

  const minute = Math.floor(x.now() / 60_000);
  if ((await x.store.incr(x.k.rate(u, minute), 1, 120_000)) > LIMITS.relayUserRpm) return toolFail('rate_limited', TEXT.rateLimited);

  const user = await getUser(x, u);
  const xpub = fromB64(user?.x25519_pub, 32);
  if (!user || !xpub) return toolFail('bridge_offline', TEXT.notRegistered);

  // The relay allocates conversation_id for starts; the bridge always uses it (§13.3 step 2).
  if (name === 'bridge_start_conversation') args.conversation_id = ulid(x.now());
  const conversationId = isUlid(args.conversation_id) ? args.conversation_id : undefined;
  const holdable = HOLDABLE_GROK_TOOLS.has(name);
  const online = (await x.store.get(x.k.conn(u))) !== null;
  if (!online && !holdable) return toolFail('bridge_offline', TEXT.offline);

  await trimExpired(x, u);
  const usage = await heldUsage(x, u);
  const reqId = ulid(x.now());
  const now = x.now();
  const call: RelayCall = { method: name, params: args, caller: b, token, received_at: now };
  const sealed = await seal(JSON.stringify(call), xpub); // plaintext exists only in this function (§13.6)
  if (usage.entries >= LIMITS.relayHeldEntries || usage.bytes + sealed.length > LIMITS.relayHeldBytes) return toolFail('rate_limited', TEXT.queueFull);

  const entryId = await appendEntry(x, u, { reqId, method: name, conversationId, deadline: online ? now + x.responseWaitMs : now, sealed });
  await x.store.publish(x.k.wake(u), 'w');
  x.log('call', { user: u, bot: b, method: name, online });

  const held = () => toolText({ status: 'held_relay', ...(conversationId ? { conversation_id: conversationId } : {}), message: TEXT.held });
  if (!online) return held();

  const raw = await x.store.blpop(x.k.res(u, reqId), x.responseWaitMs);
  if (raw === null) {
    if (holdable) return held();
    await removeEntry(x, u, entryId); // a read nobody waits for any more: don't deliver it later
    return toolFail('bridge_offline', TEXT.offline);
  }
  let res: { v?: number; result?: unknown; error?: { code: string; message: string } };
  try { res = JSON.parse(raw); } catch { return toolFail('invalid_message', 'Bad response from the bridge.'); }
  if (res.v !== RELAY_STREAM_FORMAT) return toolFail('version_unsupported', 'Bridge and relay versions differ.');
  if (res.error) return toolFail(String(res.error.code), String(res.error.message).slice(0, 500));
  return toolText(res.result ?? {});
}
