// OutboundItem → thin Grok delivery (§12.4). The bridge hands the adapter one item; this module only reshapes it for
// `packDelivery`, which owns the size invariant (≤ 3,500 chars in UTF-16 and UTF-8, `end` last).
import { LIMITS, packDelivery, type DeliveryConversation, type OutboundItem, type PackInput, type PackResult } from '@agentbridge/protocol';

/** Conversation header for notice-only deliveries that belong to no conversation (e.g. a refused start). */
export const NO_CONVERSATION: DeliveryConversation = { id: 'none', topic: 'agentbridge notice', peer: 'agentbridge', turn: 0, turn_limit: 0, state: 'ended' };

export function toPackInput(item: OutboundItem): PackInput {
  const c = item.conversation;
  const conversation: DeliveryConversation = c
    // Grok-facing state is active|ended; a pending conversation (Grok-initiated, awaiting local approval) reads as active.
    ? { id: c.id, topic: c.topic, peer: c.peer_address, turn: c.turn, turn_limit: c.turn_limit, state: c.state === 'ended' ? 'ended' : 'active' }
    : NO_CONVERSATION;
  return {
    conversation,
    messages: item.messages.map((m) => ({
      message_id: m.message_id, seq: m.seq, from: m.from_address, body: m.body, created_at: m.created_at,
      ...(m.in_reply_to ? { in_reply_to: m.in_reply_to } : {}),
    })),
    replyTo: item.messages.length > 0 ? item.reply_to : null, // notice-only: reply_to is always null (§12.4)
    notices: item.notices.map((n) => ({ code: n.code, severity: n.severity, text: n.text })),
  };
}

/**
 * Pack an item for the webhook. Never fails on size: if even id-only stubs of every message don't fit, the newest
 * messages are kept (reply_to is always the newest) with `truncated: true`, so the run fetches the rest with
 * bridge_get_messages; past that, the oldest notices go. Deterministic: the same item always yields the same JSON.
 */
export function packItem(item: OutboundItem): PackResult {
  const input = toPackInput(item);
  try { return packDelivery(input); } catch { /* too many messages/notices even as stubs */ }
  for (let keep = input.messages.length - 1; keep >= 0; keep--) {
    const r = tryPack({ ...input, messages: input.messages.slice(input.messages.length - keep) });
    if (r) return r;
  }
  for (let keep = input.notices.length - 1; keep >= 0; keep--) {
    const r = tryPack({ ...input, messages: [], notices: input.notices.slice(input.notices.length - keep) });
    if (r) return r;
  }
  throw new Error('grok delivery header alone does not fit'); // unreachable: the header is bounded (topic ≤ 120 chars)
}

function tryPack(input: PackInput): PackResult | null {
  try {
    const r = packDelivery(input);
    const payload = { ...r.payload, truncated: true }; // messages were left out: the run must fetch (Appendix B)
    const json = JSON.stringify(payload);
    if (Math.max(json.length, Buffer.byteLength(json, 'utf8')) > LIMITS.grokDeliveryChars) return null;
    return { payload, json, truncated: true };
  } catch { return null; }
}
