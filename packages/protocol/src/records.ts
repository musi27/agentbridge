// Wire records (§6.1, §7.3) with zod schemas. `from` is always set by the bridge from the authenticated caller.
import { z } from 'zod';
import { zMessageKind, zSeverity, zApprovalKind, zDirection, zConversationState, zEndReason, zOrigin } from './enums.ts';
import { ULID_RE } from './ids.ts';
import { LIMITS } from './limits.ts';

export const zUlid = z.string().regex(ULID_RE, 'expected ULID');
export const zAddress = z.string().regex(/^(claude|grok|fake):[A-Za-z0-9_-]{1,64}$/, 'expected <agent>:<name>');
export const zTopic = z.string().min(1).max(LIMITS.topicChars * 4); // raw input; sanitizeLabel caps to 120 code points
export const zBody = z.string().refine((s) => Buffer.byteLength(s, 'utf8') <= LIMITS.bodyBytes, 'too_large');
export const zTurnLimit = z.number().int().min(1).max(LIMITS.turnLimitMax);

export const zMessage = z.object({
  v: z.literal(1),
  conversation_id: zUlid,
  message_id: zUlid,
  seq: z.number().int().nonnegative(),
  turn: z.number().int().positive().optional(), // kind=message only
  from: zUlid, // participant id
  to: zUlid,
  kind: zMessageKind,
  body: z.string(),
  in_reply_to: zUlid.optional(),
  reply_expected: z.boolean().optional(),
  notice: z.object({ code: z.string(), severity: zSeverity }).optional(),
  created_at: z.string(),
});
export type Message = z.infer<typeof zMessage>;

/** Approval facts as returned in `pending_approval` and echoed exactly to `bridge_confirm` (§7.3). */
export const zApprovalFacts = z.object({
  approval_id: zUlid,
  kind: zApprovalKind,
  peer: zAddress,
  direction: zDirection,
  topic: z.string(),
  turn_limit: zTurnLimit,
});
export type ApprovalFacts = z.infer<typeof zApprovalFacts>;

/** Exact-match comparison used by the bridge before accepting a confirm. */
export function sameFacts(a: ApprovalFacts, b: ApprovalFacts): boolean {
  return a.approval_id === b.approval_id && a.kind === b.kind && a.peer === b.peer && a.direction === b.direction && a.topic === b.topic && a.turn_limit === b.turn_limit;
}

export const zConversationSummary = z.object({
  id: zUlid,
  peer: zAddress,
  topic: z.string(),
  state: zConversationState,
  end_reason: zEndReason.optional(),
  turn_count: z.number().int().nonnegative(),
  turn_limit: zTurnLimit,
  origin: zOrigin,
  initiator: z.boolean(),
  waiting_on: z.enum(['me', 'peer']).optional(),
  queued: z.boolean().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ConversationSummary = z.infer<typeof zConversationSummary>;
