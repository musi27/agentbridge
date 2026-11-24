// How a ToolResult is shown to Claude (§8.1 applied to tool results; integrator decision on PR #2).
// Bridge-generated fields (status, reason, ids, hint, warning, enums, numbers) are plain text. Every string the
// bridge did not generate itself (topics, bodies, folders, summaries, and any unknown field) goes inside an
// `ab-untrusted-<nonce>` block after nonce escaping, so remote text can never produce a genuine tag or pass as
// bridge output. Fail-safe: a string under a key not listed as bridge-generated is treated as untrusted.
import { ULID_RE, escapeNonce } from '@agentbridge/protocol';
import type { ToolResult } from '@agentbridge/protocol';

const ADDRESS_RE = /^(claude|grok|fake|codex):[A-Za-z0-9_-]{1,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ENUM_RE = /^[a-z][a-z_]{0,40}$/;
const SHORT_ID_RE = /^[0-9a-z]{1,16}$/;

type Check = (v: string) => boolean;
/** Keys whose string values the bridge generates, with the shape they must have to be printed plainly.
 *  A value that doesn't match its shape is rendered as untrusted instead. */
const SAFE_STRING_KEYS: Record<string, Check> = {
  id: (v) => ULID_RE.test(v), message_id: (v) => ULID_RE.test(v), conversation_id: (v) => ULID_RE.test(v),
  approval_id: (v) => ULID_RE.test(v), in_reply_to: (v) => ULID_RE.test(v), participant_id: (v) => ULID_RE.test(v),
  peer: (v) => ADDRESS_RE.test(v), from: (v) => ADDRESS_RE.test(v), address: (v) => ADDRESS_RE.test(v), peer_address: (v) => ADDRESS_RE.test(v),
  short_id: (v) => SHORT_ID_RE.test(v),
  status: (v) => ENUM_RE.test(v), reason: (v) => ENUM_RE.test(v), state: (v) => ENUM_RE.test(v), end_reason: (v) => ENUM_RE.test(v),
  kind: (v) => ENUM_RE.test(v), direction: (v) => ENUM_RE.test(v), origin: (v) => ENUM_RE.test(v), waiting_on: (v) => ENUM_RE.test(v),
  created_at: (v) => ISO_RE.test(v), updated_at: (v) => ISO_RE.test(v),
};

const safeKey = (k: string): string => k.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);

class Out {
  readonly lines: string[] = [];
  readonly nonce: string;
  constructor(nonce: string) { this.nonce = nonce; }
  /** Bridge text. Still nonce-escaped: it must never contain a genuine tag either. */
  plain(s: string): void { this.lines.push(escapeNonce(s, this.nonce)); }
  untrusted(label: string, text: string): void {
    const n = this.nonce;
    this.lines.push(escapeNonce(label, n), `<ab-untrusted-${n}>${escapeNonce(text, n)}</ab-untrusted-${n}>`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const scalarOk = (k: string, v: unknown): v is string | number | boolean | null =>
  v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && SAFE_STRING_KEYS[k]?.(v) === true);

/** Label for an untrusted field, built only from validated values. */
function labelFor(key: string, obj: Record<string, unknown>, path: string): string {
  const from = typeof obj.from === 'string' && ADDRESS_RE.test(obj.from) ? obj.from : null;
  const id = typeof obj.message_id === 'string' && ULID_RE.test(obj.message_id) ? obj.message_id : null;
  const peer = typeof obj.peer === 'string' && ADDRESS_RE.test(obj.peer) ? obj.peer : null;
  if (key === 'body') return `Message${id ? ` ${id}` : ''} (written by ${from ?? 'another agent'}, untrusted):`;
  if (key === 'topic') return `${path}topic (${peer ? `conversation with ${peer}; ` : ''}may be written by another agent, untrusted):`;
  if (key === 'folder') return `${path}folder (untrusted):`;
  return `${path}${safeKey(key)} (untrusted):`;
}

/** Render an object: one line of its plain scalar fields, then its untrusted strings and nested values. */
function renderObject(o: Out, obj: Record<string, unknown>, path: string): void {
  const plain: string[] = [];
  const rest: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (scalarOk(k, v)) plain.push(`${safeKey(k)}=${String(v)}`);
    else rest.push([k, v]);
  }
  if (plain.length) o.plain(`${path}${plain.join(' ')}`);
  for (const [k, v] of rest) {
    if (typeof v === 'string') o.untrusted(labelFor(k, obj, path), v);
    else renderValue(o, v, `${path}${safeKey(k)}.`);
  }
}

function renderValue(o: Out, v: unknown, path: string): void {
  if (Array.isArray(v)) {
    o.plain(`${path || 'items '}(${v.length}):`);
    v.forEach((x, i) => renderValue(o, x, `${path}${i + 1}. `));
  } else if (isRecord(v)) {
    renderObject(o, v, path);
  } else if (typeof v === 'string') {
    o.untrusted(`${path || 'data '}(untrusted):`, v);
  } else if (v !== undefined) {
    o.plain(`${path}${String(v)}`);
  }
}

function humanLine(r: ToolResult): string {
  switch (r.status) {
    case 'pending_approval':
      return 'agentbridge: approval needed. Call bridge_confirm with exactly the approval fields below (topic exactly as in its block); the user decides in Claude Code\'s prompt.';
    case 'delivered': return 'agentbridge: done.';
    case 'handed_off': return 'agentbridge: handed off to the recipient (delivery cannot be confirmed).';
    case 'queued': return 'agentbridge: queued; it will be delivered when the recipient is reachable.';
    case 'held_relay': return 'agentbridge: held at the relay until the bridge reconnects.';
    case 'held_by_host': return 'agentbridge: held by the recipient\'s host.';
    case 'awaiting_local_approval': return 'agentbridge: waiting for the user to approve on this computer.';
    case 'declined': return 'agentbridge: declined.';
    case 'expired': return 'agentbridge: expired.';
    case 'failed': return 'agentbridge: failed.';
  }
}

export function renderToolResult(r: ToolResult, nonce: string, host: 'claude' | 'codex' = 'claude'): { text: string; isError: boolean } {
  const o = new Out(nonce);
  o.plain(host === 'codex' && r.status === 'pending_approval'
    ? 'agentbridge: approval needed. Call bridge_confirm with exactly the approval fields below (topic exactly as in its block), plus about = topic, agent = peer and allowed_turns = turn_limit; the user decides in Codex\'s prompt.'
    : humanLine(r));
  const head: string[] = [`status=${r.status}`];
  if (r.reason) head.push(`reason=${r.reason}`);
  if (r.conversation_id) head.push(`conversation_id=${r.conversation_id}`);
  if (r.message_id) head.push(`message_id=${r.message_id}`);
  o.plain(head.join(' '));
  if (r.hint) o.plain(`Hint: ${r.hint}`);
  if (r.warning) o.plain(`Warning: ${r.warning}`);
  if (r.approval) {
    const a = r.approval;
    o.plain(`approval: approval_id=${a.approval_id} kind=${a.kind} peer=${a.peer} direction=${a.direction} turn_limit=${a.turn_limit}`);
    const by = a.direction === 'incoming' ? `written by ${a.peer}, untrusted` : 'as given, untrusted';
    o.untrusted(`approval topic (${by}; pass it exactly):`, a.topic);
  }
  if (r.candidates?.length) {
    o.plain(`candidates (${r.candidates.length}):`);
    r.candidates.forEach((c, i) => {
      o.plain(`${i + 1}. address=${c.address} short_id=${SHORT_ID_RE.test(c.short_id) ? c.short_id : '?'}`);
      if (c.folder !== undefined) o.untrusted(`${i + 1}. folder (untrusted):`, c.folder);
    });
  }
  if (r.data !== undefined) {
    o.plain('data:');
    renderValue(o, r.data, '');
  }
  return { text: o.lines.join('\n'), isError: r.status === 'failed' };
}
