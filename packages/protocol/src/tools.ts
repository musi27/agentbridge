// MCP tool definitions (§11.4 Claude plugin; §12.3 Grok via relay). JSON Schema literals, shared by plugin and relay.
type JsonSchema = Record<string, unknown>;
export interface ToolDef { name: string; description: string; inputSchema: JsonSchema; _meta?: Record<string, unknown> }

const s = (props: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', description, ...extra });
const int = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'integer', description, ...extra });
const ULID = { pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' };
const ADDR = { pattern: '^(claude|grok|fake|codex):[A-Za-z0-9_-]{1,64}$' };
const idem = { idempotency_key: str('Optional key to make retries safe', { maxLength: 128 }) };

export const CLAUDE_TOOLS: readonly ToolDef[] = [
  { name: 'bridge_list_agents', description: 'List agents you can talk to (address, state, folder).', inputSchema: s({}) },
  { name: 'bridge_start_conversation', description: 'Start a conversation with another agent. Use only when the user asks. Usually returns pending_approval: then call bridge_confirm with exactly the returned fields.',
    inputSchema: s({ peer: str('Address, e.g. grok:researcher', ADDR), topic: str('Short topic (max 120 characters)', { maxLength: 480 }), first_message: str('Your first message'), turn_limit: int('Max turns (default 30, max 200)', { minimum: 1, maximum: 200 }), continues: str('Ended conversation this continues', ULID), ...idem }, ['peer', 'topic', 'first_message']) },
  { name: 'bridge_confirm', description: 'Confirm a pending approval. The user must approve it in Claude Code\'s prompt. Pass exactly the fields you were given.',
    inputSchema: s({ approval_id: str('Approval id', ULID), kind: { type: 'string', enum: ['start', 'accept', 'extend'] }, peer: str('Peer address', ADDR), direction: { type: 'string', enum: ['outgoing', 'incoming', 'none'] }, topic: str('Topic exactly as given'), turn_limit: int('Turn limit exactly as given', { minimum: 1, maximum: 200 }) }, ['approval_id', 'kind', 'peer', 'direction', 'topic', 'turn_limit']),
    _meta: { 'anthropic/requiresUserInteraction': true } },
  { name: 'bridge_cancel', description: 'Cancel a pending approval (e.g. after the user denied the prompt).', inputSchema: s({ approval_id: str('Approval id', ULID) }, ['approval_id']) },
  { name: 'bridge_decline', description: 'Decline a pending invitation.', inputSchema: s({ conversation_id: str('Conversation id', ULID) }, ['conversation_id']) },
  { name: 'bridge_send', description: 'Send a message in a conversation you are part of.',
    inputSchema: s({ conversation_id: str('Conversation id', ULID), body: str('Message (markdown, max 32 KB)'), in_reply_to: str('Message id you reply to', ULID), reply_expected: { type: 'boolean', description: 'Whether you expect an answer (default true)' }, ...idem }, ['conversation_id', 'body']) },
  { name: 'bridge_extend_conversation', description: 'Ask to raise a conversation\'s turn limit. Returns pending_approval.', inputSchema: s({ conversation_id: str('Conversation id', ULID), add_turns: int('Turns to add', { minimum: 1, maximum: 200 }) }, ['conversation_id', 'add_turns']) },
  { name: 'bridge_end_conversation', description: 'End a conversation when its purpose is met.', inputSchema: s({ conversation_id: str('Conversation id', ULID) }, ['conversation_id']) },
  { name: 'bridge_list_conversations', description: 'List your conversations.', inputSchema: s({}) },
  { name: 'bridge_get_transcript', description: 'Read a conversation transcript (paged, newest last).', inputSchema: s({ conversation_id: str('Conversation id', ULID), before_seq: int('Page before this seq'), limit: int('Max messages', { minimum: 1, maximum: 200 }) }, ['conversation_id']) },
];

export const GROK_TOOLS: readonly ToolDef[] = [
  { name: 'bridge_list_agents', description: 'List agents on the user\'s computer you may talk to.', inputSchema: s({}) },
  { name: 'bridge_start_conversation', description: 'Start a conversation with one of the user\'s local agents. The user must approve it on their computer.',
    inputSchema: s({ peer: str('Address, e.g. claude:auth-refactor', ADDR), topic: str('Short topic (max 120 characters)', { maxLength: 480 }), first_message: str('Your first message'), turn_limit: int('Max turns (default 30)', { minimum: 1, maximum: 200 }), ...idem }, ['peer', 'topic', 'first_message']) },
  { name: 'bridge_send', description: 'Reply once in a conversation.', inputSchema: s({ conversation_id: str('Conversation id', ULID), body: str('Your reply (markdown, max 32 KB)'), in_reply_to: str('Message id you reply to', ULID), ...idem }, ['conversation_id', 'body']) },
  { name: 'bridge_get_messages', description: 'Read the full text of new messages when a delivery was truncated.', inputSchema: s({ conversation_id: str('Conversation id', ULID), after_seq: int('Return messages after this seq') }, ['conversation_id']) },
  { name: 'bridge_end_conversation', description: 'End the conversation.', inputSchema: s({ conversation_id: str('Conversation id', ULID) }, ['conversation_id']) },
  { name: 'bridge_list_conversations', description: 'List this bot\'s conversations.', inputSchema: s({}) },
  { name: 'bridge_get_transcript', description: 'Read older messages of a conversation (paged).', inputSchema: s({ conversation_id: str('Conversation id', ULID), before_seq: int('Page before this seq'), limit: int('Max messages', { minimum: 1, maximum: 200 }) }, ['conversation_id']) },
];

/** Tools Grok's routine needs the Allow rule for (§12.5). */
export const GROK_ALLOW_RULE_TOOLS = ['bridge_send', 'bridge_get_messages', 'bridge_end_conversation', 'bridge_get_transcript'] as const;
