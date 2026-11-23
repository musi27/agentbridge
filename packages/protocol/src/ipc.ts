// Local IPC contract (§10). Unix socket ~/.agentbridge/run/bridge.sock (dir 0700, socket 0600, peer UID checked),
// newline-delimited JSON frames <= 256 KB. Every method below is the complete surface; anything else -> invalid_message.
import { z } from 'zod';
import { HOST_AGENTS, zPermissionMode, zReason, zStatus } from './enums.ts';
import { zAddress, zApprovalFacts, zBody, zTopic, zTurnLimit, zUlid, zConversationSummary } from './records.ts';
import { NONCE_RE } from './ids.ts';

export const IPC_PROTOCOL = 1;
export const IPC_PROTOCOLS_SUPPORTED = [1] as const; // current + previous (§10 versioning)

export const zIpcError = z.object({ code: z.union([zReason, z.literal('unauthenticated'), z.literal('method_not_found'), z.literal('internal')]), message: z.string(), data: z.unknown().optional() });
export type IpcError = z.infer<typeof zIpcError>;

export const zIpcFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('req'), id: z.string().min(1).max(64), method: z.string(), params: z.unknown().optional() }),
  z.object({ type: z.literal('res'), id: z.string().min(1).max(64), result: z.unknown().optional(), error: zIpcError.optional() }),
  z.object({ type: z.literal('evt'), method: z.string(), params: z.unknown().optional() }),
]);
export type IpcFrame = z.infer<typeof zIpcFrame>;

// ---------- result returned by every bridge_* tool ----------
export const zToolResult = z.object({
  status: zStatus,
  reason: zReason.optional(),
  conversation_id: zUlid.optional(),
  message_id: zUlid.optional(),
  approval: zApprovalFacts.optional(), // present iff status = pending_approval
  candidates: z.array(z.object({ address: zAddress, title: z.string().optional(), short_id: z.string(), folder: z.string().optional() })).optional(), // recipient_ambiguous
  warning: z.string().optional(), // e.g. AUTO_MODE_WARNING
  hint: z.string().optional(),
  data: z.unknown().optional(), // list/transcript payloads
});
export type ToolResult = z.infer<typeof zToolResult>;

// ---------- method table ----------
const zHello = z.object({ protocol: z.number().int(), client: z.enum(['plugin', 'hook', 'cli']), client_version: z.string() });
const zHelloResult = z.object({ protocol: z.number().int(), bridge_version: z.string() });

/** Hook → bridge (unauthenticated; bridge verifies the socket peer is a child of claude_pid, §10). */
const zSessionEvent = z.object({
  event: z.enum(['start', 'end', 'state']),
  host: z.enum(HOST_AGENTS).optional(), // default claude; codex asks for the standing instruction in the result (§11a)
  claude_pid: z.number().int().positive(),
  session_id: z.string().min(1),
  source: z.enum(['startup', 'resume', 'clear', 'compact', 'fork']).optional(), // event=start
  permission_mode: zPermissionMode.optional(), // event=state (and any event that carries it)
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
});

/** Plugin MCP server → bridge. */
const zRegister = z.object({
  claude_pid: z.number().int().positive(), // the host process (claude or codex), kept under its original name
  host: z.enum(HOST_AGENTS).optional(), // default claude
  tag_nonce: z.string().regex(NONCE_RE),
  inbox: z.object({ socket: z.string().min(1), token: z.string().min(1) }).optional(), // Claude Code only (§11.3); Codex posts with codex queue
  plugin_version: z.string(),
  cwd: z.string().optional(),
});
const zRegisterResult = z.object({ participant_id: zUlid, address: zAddress, epoch: z.number().int().positive(), session_secret: z.string() });
const zReconnect = z.object({ participant_id: zUlid, session_secret: z.string(), claude_pid: z.number().int().positive() });

const zIdem = { idempotency_key: z.string().max(128).optional() };
export const toolParams = {
  'tool.bridge_list_agents': z.object({}),
  'tool.bridge_start_conversation': z.object({ peer: zAddress, topic: zTopic, first_message: zBody, turn_limit: zTurnLimit.optional(), continues: zUlid.optional(), ...zIdem }),
  'tool.bridge_confirm': zApprovalFacts,
  'tool.bridge_cancel': z.object({ approval_id: zUlid }),
  'tool.bridge_decline': z.object({ conversation_id: zUlid }),
  'tool.bridge_send': z.object({ conversation_id: zUlid, body: zBody, in_reply_to: zUlid.optional(), reply_expected: z.boolean().optional(), ...zIdem }),
  'tool.bridge_extend_conversation': z.object({ conversation_id: zUlid, add_turns: z.number().int().min(1).max(200) }),
  'tool.bridge_end_conversation': z.object({ conversation_id: zUlid }),
  'tool.bridge_list_conversations': z.object({}),
  'tool.bridge_get_transcript': z.object({ conversation_id: zUlid, before_seq: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional() }),
} as const;

/** Bridge → plugin: posts to put into the session inbox, in order, >= 200 ms apart. Each text is unique (§8.1). */
const zDeliverEvt = z.object({ items: z.array(z.object({ post_id: zUlid, text: z.string() })).min(1), thread_id: z.string().min(1).optional() }); // thread_id: Codex session to queue into (§11a)
/** Plugin → bridge: outcome of one inbox write. Writes never report delivery (§11.3), so ok=true means handed_off. */
const zPostResult = z.object({ post_id: zUlid, ok: z.boolean(), error: z.string().optional() });

/** CLI methods (§14). `privileged` ones trigger the bridge-run user-presence check (§9.2). */
export const CLI_METHODS = {
  'cli.status': { privileged: false }, 'cli.agents': { privileged: false }, 'cli.conversations': { privileged: false },
  'cli.doctor': { privileged: false }, 'cli.logs': { privileged: false }, 'cli.open': { privileged: false }, 'cli.config_get': { privileged: false },
  'cli.show': { privileged: true }, 'cli.end': { privileged: true }, 'cli.extend': { privileged: true },
  'cli.approve': { privileged: true }, 'cli.decline': { privileged: true }, 'cli.revoke': { privileged: true }, 'cli.remove': { privileged: true },
  'cli.add_grok': { privileged: true }, 'cli.config_set': { privileged: true }, 'cli.config_verify': { privileged: true },
  'cli.identity_rotate': { privileged: true }, 'cli.purge': { privileged: true }, 'cli.stop': { privileged: true },
} as const;
export type CliMethod = keyof typeof CLI_METHODS;

export const IPC_METHODS = {
  hello: { params: zHello, result: zHelloResult, auth: 'none' },
  ping: { params: z.object({}).optional(), result: z.object({ t: z.number() }), auth: 'none' },
  session_event: { params: zSessionEvent, result: z.object({ ok: z.literal(true), context: z.string().optional() }), auth: 'hook' },
  register_session: { params: zRegister, result: zRegisterResult, auth: 'none' },
  reconnect_session: { params: zReconnect, result: zRegisterResult, auth: 'none' },
  post_result: { params: zPostResult, result: z.object({ ok: z.literal(true) }), auth: 'participant' },
} as const;

/** Bridge → plugin: a newer valid registration replaced this connection, which is closed right after.
 *  The plugin must not reconnect on its own after receiving it. */
const zReplacedEvt = z.object({ reason: z.string() });

export const IPC_EVENTS = { deliver: zDeliverEvt, replaced: zReplacedEvt } as const;

export type ToolMethod = keyof typeof toolParams;
export const TOOL_METHODS = Object.keys(toolParams) as ToolMethod[];

export { zConversationSummary };
