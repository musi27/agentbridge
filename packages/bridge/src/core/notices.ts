// Bridge notices (§9.1). Each has structured `parts` (Claude framing: remote-written text only via untrusted())
// and a plain `text` (Grok). Remote-written text is never placed in a trusted part (§8.1).
import { preview, trusted, untrusted, ulid, sanitizeLabel, truncateChars, AUTO_MODE_WARNING, type NoticePart, type OutboundNotice, type Severity, type ApprovalFacts, type EndReason } from '@agentbridge/protocol';

const LAST_MESSAGE_CHARS = 280;

function make(code: string, severity: Severity, parts: NoticePart[]): OutboundNotice {
  const text = parts.map((p) => (p.kind === 'trusted' ? p.text : `${p.label} "${p.text}"`)).join('\n');
  return { id: ulid(), code, severity, parts, text };
}

const topicPart = (author: string, topic: string): NoticePart => untrusted(`Topic (written by ${author}, untrusted):`, sanitizeLabel(topic));

export interface InviteOpts { facts: ApprovalFacts; conversationId: string; autoModeWarning: boolean; dontAsk: boolean }

/** §8.1 invite notice: approval facts, topic in an untrusted block, the exact confirm/decline instructions. */
export function inviteNotice(o: InviteOpts): OutboundNotice {
  const f = o.facts;
  const parts: NoticePart[] = [
    trusted(`${f.peer} wants to start a conversation (turn limit ${f.turn_limit}).`),
    topicPart(f.peer, f.topic),
    trusted(`To accept, call bridge_confirm with: approval_id=${f.approval_id}, kind=${f.kind}, peer=${f.peer}, direction=${f.direction}, topic=<exactly as above>, turn_limit=${f.turn_limit}.`),
    trusted(`To decline, call bridge_decline(conversation_id=${o.conversationId}).`),
  ];
  if (o.autoModeWarning) parts.push(trusted(AUTO_MODE_WARNING));
  if (o.dontAsk) parts.push(trusted(dontAskHint(f.approval_id)));
  return make('invite', 'info', parts);
}

export const dontAskHint = (approvalId: string): string =>
  `This session is in dontAsk mode, so Claude Code cannot show the approval prompt. The user can approve in a terminal with: agentbridge approve ${approvalId}`;

/** Auto mode (§7.4 B5): the invite just announces the accepted conversation. */
export function autoAcceptedNotice(peer: string, topic: string, turnLimit: number): OutboundNotice {
  return make('invite_accepted', 'info', [
    trusted(`${peer} started a conversation with you; an auto-mode allow rule accepted it (turn limit ${turnLimit}). Its first message follows.`),
    topicPart(peer, topic),
  ]);
}

export const acceptedNotice = (peer: string): OutboundNotice => make('accepted', 'info', [trusted(`${peer} accepted the conversation.`)]);

export function declinedNotice(peer: string, how: 'declined' | 'withdrawn'): OutboundNotice {
  return make('declined', 'info', [trusted(how === 'declined' ? `${peer} declined the conversation.` : `${peer} withdrew the invitation.`)]);
}

export function approvalExpiredNotice(kind: 'start' | 'accept' | 'extend', peer: string, why: 'timeout' | 'restart' = 'timeout'): OutboundNotice {
  const cause = why === 'restart' ? 'because the bridge restarted' : 'because nobody confirmed it in time';
  const what = kind === 'start' ? `Your request to start a conversation with ${peer}` : kind === 'accept' ? `The invitation from ${peer}` : `The request to extend the conversation with ${peer}`;
  return make('approval_expired', 'warning', [trusted(`${what} expired ${cause}.`)]);
}

export function inviteExpiredForInitiator(peer: string): OutboundNotice {
  return make('approval_expired', 'warning', [trusted(`${peer} did not accept your invitation in time; the conversation ended.`)]);
}

/** Returned to a sender whose delivery waits for a new session's first prompt (§7.4). */
export const unknownModeHint = (recipient: string): string =>
  `held: ${recipient} is a new session that hasn't had its first prompt yet. It will be delivered as soon as someone types in that session (agentbridge waits until it knows the session's permission mode).`;

/** Desktop popup when that wait passes LIMITS.unknownModePopupMs. `title` is Claude Code's session title, if any. */
export const unknownModePopup = (recipient: string, title: string | null): { title: string; body: string } => ({
  title: 'agentbridge: message waiting',
  body: `${recipient}${title ? ` ("${title}")` : ''} has a message waiting. Type anything in that session to receive it.`,
});

export function queuedNotice(recipient: string): OutboundNotice {
  return make('queued', 'info', [trusted(`${recipient} is closed. Your message is queued and will be delivered when it reopens (agentbridge open ${recipient}).`)]);
}

export const capNotice = (recipient: string): OutboundNotice =>
  make('grok_cap', 'warning', [trusted(`Deliveries to ${recipient} reached the hourly cap; the message is held and will be sent later.`)]);

export function unreachableNotice(recipient: string): OutboundNotice {
  return make('recipient_unreachable', 'warning', [trusted(`${recipient} does not accept cross-session messages (crossSessionInbound is hold or refuse). Your message stays queued until that is set to accept.`)]);
}

export function queueExpiredNotice(recipient: string, count: number): OutboundNotice {
  return make('queue_expired', 'warning', [trusted(`${count === 1 ? 'A queued message' : `${count} queued messages`} to ${recipient} expired without being delivered.`)]);
}

export function noReplyNotice(peer: string, minutes: number): OutboundNotice {
  return make('no_reply', 'info', [trusted(`${peer} has not replied for ${minutes} minutes.`)]);
}
export const grokWaitingHint = (peer: string): OutboundNotice =>
  make('grok_waiting', 'info', [trusted(`${peer} has not replied for 25 minutes. Grok may be waiting on an approval card in your Grok chat.`)]);

export function extendedNotice(by: string, newLimit: number): OutboundNotice {
  return make('extended', 'info', [trusted(`The turn limit was raised to ${newLimit} (requested by ${by}).`)]);
}

/** Fixed bridge-side wording per reason; adapter-supplied detail only ever goes in an untrusted block. */
const FAILURE_TEXT: Partial<Record<string, string>> = {
  grok_run_not_started: 'the Grok routine did not start a run',
  host_refused: 'the receiving host refused it',
  recipient_unsafe_mode: 'the recipient runs in bypassPermissions mode',
  recipient_gone: 'the recipient no longer exists',
  too_large: 'it is too large',
};

export function deliveryFailedNotice(recipient: string, reason: string, detail?: string): OutboundNotice {
  const why = FAILURE_TEXT[reason] ?? 'delivery failed';
  const parts: NoticePart[] = [trusted(`A message to ${recipient} could not be delivered: ${why}. It did not use a turn; you may send it again.`)];
  if (detail) parts.push(untrusted('Details reported by the delivery adapter (untrusted):', truncateChars(sanitizeLabel(detail, 300), 300)));
  return make('delivery_failed', 'error', parts);
}

export function unsafeModeNotice(who: string, which: 'requester' | 'recipient'): OutboundNotice {
  return make(which === 'requester' ? 'requester_unsafe_mode' : 'recipient_unsafe_mode', 'warning', [trusted(which === 'requester'
    ? `${who} runs in bypassPermissions mode and cannot start or accept agentbridge conversations.`
    : `${who} runs in bypassPermissions mode and cannot receive agentbridge messages.`)]);
}

export function refusedNotice(code: 'not_allowed' | 'rate_limited', peer: string, hint?: string): OutboundNotice {
  return make(code, 'warning', [trusted(code === 'not_allowed' ? `Your conversation request to ${peer} is not allowed by the user's policy.` : `Your conversation request to ${peer} was rate limited.${hint ? ` ${hint}` : ''}`)]);
}

export interface SummaryInput {
  conversationId: string; a: string; b: string; topic: string; turnsUsed: number; turnLimit: number; durationMs: number; reason: EndReason;
  last: Array<{ from: string; body: string }>;
}

/** §6.6 mechanical end summary. Last messages are agent-written: untrusted blocks only. */
export function endSummaryNotice(s: SummaryInput): OutboundNotice {
  const mins = Math.max(0, Math.round(s.durationMs / 60_000));
  const parts: NoticePart[] = [
    trusted(`Conversation ended (${s.reason.replaceAll('_', ' ')}). Participants: ${s.a}, ${s.b}. Turns used: ${s.turnsUsed}/${s.turnLimit}. Duration: ${mins} min.`),
    topicPart(s.a, s.topic),
  ];
  for (const m of s.last) parts.push(untrusted(`Last message from ${m.from} (untrusted):`, preview(m.body, LAST_MESSAGE_CHARS))); // word boundary + "…" (e2e run 1)
  parts.push(trusted(`Full transcript: bridge_get_transcript(conversation_id=${s.conversationId}) or agentbridge show ${s.conversationId}.`));
  return make('ended', 'info', parts);
}

/** §13.3: a Grok write held by the relay while the bridge was offline was rejected when it arrived. */
export function heldRejectedNotice(method: string, reason: string, hint?: string): OutboundNotice {
  const what = method === 'bridge_send' ? 'Your earlier message' : method === 'bridge_start_conversation' ? 'Your earlier request to start a conversation' : method === 'bridge_end_conversation' ? 'Your earlier request to end the conversation' : `Your earlier ${method} call`;
  const parts: NoticePart[] = [trusted(`${what} reached the user's computer late and was not accepted (${reason.replaceAll('_', ' ')}).`)];
  if (hint) parts.push(untrusted('Bridge detail (untrusted):', truncateChars(sanitizeLabel(hint, 200), 200)));
  return make('held_rejected', 'warning', parts);
}
export const relayExpiredNotice = (count: number): OutboundNotice =>
  make('relay_expired', 'warning', [trusted(`${count === 1 ? 'A call you made' : `${count} calls you made`} in this conversation waited at the relay too long and expired before the user's computer received ${count === 1 ? 'it' : 'them'}. Send it again if it still matters.`)]);

export const approvalsDroppedNotice = (): OutboundNotice =>
  make('bridge_restarted', 'warning', [trusted('The agentbridge service restarted. Pending approvals were dropped; ask again if still needed.')]);
