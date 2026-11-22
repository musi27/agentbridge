// Sanitisation (§8.2). Pure functions; every remote-written label and body passes through here.
import { LIMITS } from './limits.ts';

// ANSI/VT escape sequences: CSI, OSC (BEL or ST terminated), other ESC sequences.
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// C0 (except \t \n handled per function), DEL, C1.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Bidi controls and zero-width characters.
const BIDI_ZW_RE = /[؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Labels (topics, names): one line, no controls/bidi/zero-width/escapes, collapsed whitespace, capped. */
export function sanitizeLabel(s: string, maxChars: number = LIMITS.topicChars): string {
  const out = s.replace(ANSI_RE, '').replace(/[\r\n\t]+/g, ' ').replace(CONTROL_RE, '').replace(BIDI_ZW_RE, '')
    .replace(/\s+/g, ' ').trim();
  return truncateChars(out, maxChars);
}

/** Bodies: strip escapes and controls except \n and \t; normalise CRLF/CR to \n. */
export function sanitizeBody(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
}

export const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Truncate to at most n Unicode code points without splitting a surrogate pair. */
export function truncateChars(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n).join('');
}

/** Preview: at most n code points, cut at a word boundary when one exists in the last 20%, with an ellipsis. */
export function preview(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const cps = Array.from(flat);
  if (cps.length <= n) return flat;
  const cut = cps.slice(0, n - 1).join('');
  const sp = cut.lastIndexOf(' ');
  return (sp > (n - 1) * 0.8 ? cut.slice(0, sp) : cut) + '…';
}
