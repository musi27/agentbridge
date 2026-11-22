// Thin Grok delivery packing (§12.4). Invariant: serialized size <= LIMITS.grokDeliveryChars in BOTH
// UTF-16 length and UTF-8 bytes (the run's ~4,000 limit unit is unknown, M0 V9), and "end" is the last field.
import { LIMITS } from './limits.ts';
import { preview as mkPreview, sanitizeLabel, truncateChars } from './sanitize.ts';
import type { Severity } from './enums.ts';

export const DELIVERY_VERSION = 2;
export const DELIVERY_END = 'agentbridge-delivery-end';

export interface DeliveryConversation {
  id: string; topic: string; peer: string; turn: number; turn_limit: number; state: 'active' | 'ended';
}
export interface DeliveryMessageIn {
  message_id: string; seq: number; from: string; body: string; in_reply_to?: string; created_at: string;
}
export interface DeliveryNotice { code: string; severity: Severity; text: string }

export interface DeliveryMessageOut {
  message_id: string; seq: number; from: string;
  body?: string; preview?: string; length: number;
  in_reply_to?: string; created_at: string;
}
export interface DeliveryPayload {
  agentbridge: typeof DELIVERY_VERSION;
  conversation: DeliveryConversation & { turns_left: number };
  messages: DeliveryMessageOut[];
  truncated: boolean;
  reply_to: string | null;
  notices: DeliveryNotice[];
  end: typeof DELIVERY_END;
}

export interface PackInput {
  conversation: DeliveryConversation; messages: DeliveryMessageIn[]; replyTo: string | null; notices: DeliveryNotice[];
}
export interface PackResult { payload: DeliveryPayload; json: string; truncated: boolean }

const size = (s: string): number => Math.max(s.length, Buffer.byteLength(s, 'utf8'));

function build(input: PackInput, mode: { previewChars: number | null; noticeChars: number }): DeliveryPayload {
  const c = input.conversation;
  const messages: DeliveryMessageOut[] = input.messages.map((m) => {
    const base = { message_id: m.message_id, seq: m.seq, from: m.from, length: Array.from(m.body).length };
    const content = mode.previewChars === null ? { body: m.body } : mode.previewChars > 0 ? { preview: mkPreview(m.body, mode.previewChars) } : {};
    return { ...base, ...content, ...(m.in_reply_to ? { in_reply_to: m.in_reply_to } : {}), created_at: m.created_at };
  });
  return {
    agentbridge: DELIVERY_VERSION,
    conversation: { id: c.id, topic: sanitizeLabel(c.topic, LIMITS.topicChars), peer: c.peer, turn: c.turn, turn_limit: c.turn_limit, turns_left: Math.max(0, c.turn_limit - c.turn), state: c.state },
    messages,
    truncated: mode.previewChars !== null && input.messages.length > 0,
    reply_to: input.replyTo,
    notices: input.notices.map((n) => ({ code: n.code, severity: n.severity, text: truncateChars(n.text, mode.noticeChars) })),
    end: DELIVERY_END,
  };
}

/** Pack a delivery. Tries full bodies, then shrinking previews, then ids only; throws only if even the skeleton can't fit. */
export function packDelivery(input: PackInput, budget: number = LIMITS.grokDeliveryChars): PackResult {
  const attempts: Array<{ previewChars: number | null; noticeChars: number }> = [
    { previewChars: null, noticeChars: LIMITS.grokNoticeChars },
    { previewChars: LIMITS.grokPreviewChars, noticeChars: LIMITS.grokNoticeChars },
    { previewChars: 120, noticeChars: LIMITS.grokNoticeChars },
    { previewChars: 40, noticeChars: 120 },
    { previewChars: 0, noticeChars: 80 },
  ];
  for (const mode of attempts) {
    const payload = build(input, mode);
    const json = JSON.stringify(payload);
    if (size(json) <= budget) return { payload, json, truncated: payload.truncated };
  }
  throw new Error(`grok delivery cannot fit in ${budget} chars even without bodies (${input.messages.length} messages, ${input.notices.length} notices)`);
}
