// Claude Code framing (§8.1). Remote-written text can only enter a post through `untrusted()` or a message body,
// and is always nonce-escaped. Bridge text (`trusted`) must not contain anything that looks like a tag.
import { NONCE_RE } from './ids.ts';
import type { Severity } from './enums.ts';

export const TAG_PREFIX = 'ab-';
const REDACTED = '[tag-code removed]';

/** Replace every occurrence of the session nonce so agent content cannot produce a genuine tag. */
export function escapeNonce(text: string, nonce: string): string {
  assertNonce(nonce);
  // also catch case variants (tag names are compared case-sensitively, but be strict)
  return text.replace(new RegExp(nonce, 'gi'), REDACTED);
}

/** Attribute values: only a safe subset survives (addresses, ULIDs, codes, numbers, slashes). */
export function attr(v: string | number): string {
  return String(v).replace(/[^A-Za-z0-9:_./-]/g, '_').slice(0, 128);
}

function assertNonce(nonce: string): void {
  if (!NONCE_RE.test(nonce)) throw new Error('framing: invalid nonce');
}

function assertTrusted(s: string): void {
  if (/<\/?ab-/i.test(s)) throw new Error('framing: trusted text must not contain tag-like sequences');
}

export type NoticePart = { readonly kind: 'trusted'; readonly text: string } | { readonly kind: 'untrusted'; readonly text: string; readonly label: string };
export const trusted = (text: string): NoticePart => { assertTrusted(text); return { kind: 'trusted', text }; };
/** `label` is bridge text naming the author, e.g. "Topic (written by grok:researcher, untrusted):". */
export const untrusted = (label: string, text: string): NoticePart => { assertTrusted(label); return { kind: 'untrusted', label, text }; };

export interface MessageFrame {
  nonce: string; conversationId: string; from: string; turn: number; turnLimit: number; id: string; body: string;
}

/** `<ab-msg-NONCE conversation=… from=… turn="5/30" id=…>` + escaped body + closing tag. */
export function renderMessage(m: MessageFrame): string {
  assertNonce(m.nonce);
  const left = m.turnLimit - m.turn;
  const warn = left <= 2 && left >= 0 ? ` turns_left="${left}"` : '';
  const open = `<${TAG_PREFIX}msg-${m.nonce} conversation="${attr(m.conversationId)}" from="${attr(m.from)}" turn="${m.turn}/${m.turnLimit}"${warn} id="${attr(m.id)}">`;
  return `${open}\n${escapeNonce(m.body, m.nonce)}\n</${TAG_PREFIX}msg-${m.nonce}>`;
}

export interface NoticeFrame {
  nonce: string; code: string; severity: Severity; id: string; conversationId?: string; parts: readonly NoticePart[];
}

/** Notice with a unique id (identical posts are dropped by Claude Code, M0 V2). */
export function renderNotice(n: NoticeFrame): string {
  assertNonce(n.nonce);
  const conv = n.conversationId ? ` conversation="${attr(n.conversationId)}"` : '';
  const head = `<${TAG_PREFIX}notice-${n.nonce} code="${attr(n.code)}" severity="${n.severity}" id="${attr(n.id)}"${conv}>`;
  const body = n.parts.map((p) => {
    if (p.kind === 'trusted') return p.text;
    return `${p.label}\n<${TAG_PREFIX}untrusted-${n.nonce}>${escapeNonce(p.text, n.nonce)}</${TAG_PREFIX}untrusted-${n.nonce}>`;
  }).join('\n');
  return `${head}\n${body}\n</${TAG_PREFIX}notice-${n.nonce}>`;
}

/** Warning line for sessions in Claude Code auto mode (§8.4, owner decision). */
export const AUTO_MODE_WARNING = 'This session is in auto mode: Claude Code may not ask before shell commands, so read this approval prompt carefully.';
