// Single source of truth for every enum in SPEC (§6, §7, §8.4, §16).
import { z } from 'zod';

export const CONVERSATION_STATES = ['pending', 'active', 'ended'] as const;
export const END_REASONS = ['declined', 'approval_expired', 'invite_expired', 'participant_gone', 'ended_by_participant', 'turn_limit', 'manual'] as const;
export const MESSAGE_KINDS = ['message', 'invite', 'accept', 'decline', 'end', 'notice'] as const;
export const STATUSES = ['delivered', 'handed_off', 'queued', 'held_relay', 'held_by_host', 'pending_approval', 'awaiting_local_approval', 'declined', 'failed', 'expired'] as const;
export const REASONS = [
  // recipients and requesters
  'recipient_gone', 'recipient_ambiguous', 'recipient_unsafe_mode', 'recipient_unreachable', 'requester_unsafe_mode', 'not_participant',
  // unknown ids
  'unknown_conversation', 'unknown_approval',
  // conversation state
  'conversation_ended', 'turn_limit', 'duplicate_reply',
  // approvals
  'approval_declined', 'approval_expired', 'approval_mismatch', 'approval_unavailable',
  // policy
  'not_allowed', 'rate_limited',
  // size and expiry
  'too_large', 'queue_expired',
  // connectivity and host
  'bridge_offline', 'host_refused',
  // grok
  'grok_run_not_started',
  // protocol and integrity
  'invalid_message', 'version_unsupported', 'policy_tampered',
] as const;
export const APPROVAL_KINDS = ['start', 'accept', 'extend'] as const;
export const DIRECTIONS = ['outgoing', 'incoming', 'none'] as const;
export const APPROVAL_STATES = ['issued', 'confirmed', 'declined', 'cancelled', 'expired'] as const;
/** Claude Code permission modes as hook input reports them, plus `unknown` (SessionStart carries none, §8.4). */
export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'unknown'] as const;
export const SEVERITIES = ['info', 'warning', 'error'] as const;
export const ORIGINS = ['local', 'relay'] as const;
export const APPROVAL_MODES = ['per_conversation', 'auto'] as const;
export const PARTICIPANT_STATES = ['live', 'closed', 'gone', 'unreachable'] as const;
export const AGENT_TYPES = ['claude', 'grok', 'fake', 'codex'] as const;
/** Agents that run as local sessions linked to the bridge by an MCP server child process (§10, §11, §11a). */
export const HOST_AGENTS = ['claude', 'codex'] as const;
export type HostAgent = (typeof HOST_AGENTS)[number];
export const DELIVERY_STATES = ['accepted', 'queued', 'handed_off', 'held_by_host', 'delivered', 'failed', 'expired'] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];
export type EndReason = (typeof END_REASONS)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Reason = (typeof REASONS)[number];
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export type Direction = (typeof DIRECTIONS)[number];
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Origin = (typeof ORIGINS)[number];
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export type ParticipantState = (typeof PARTICIPANT_STATES)[number];
export type AgentType = (typeof AGENT_TYPES)[number];
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const zConversationState = z.enum(CONVERSATION_STATES);
export const zEndReason = z.enum(END_REASONS);
export const zMessageKind = z.enum(MESSAGE_KINDS);
export const zStatus = z.enum(STATUSES);
export const zReason = z.enum(REASONS);
export const zApprovalKind = z.enum(APPROVAL_KINDS);
export const zDirection = z.enum(DIRECTIONS);
export const zPermissionMode = z.enum(PERMISSION_MODES);
export const zSeverity = z.enum(SEVERITIES);
export const zOrigin = z.enum(ORIGINS);
export const zAgentType = z.enum(AGENT_TYPES);

/** Direction is fixed by kind (§7.3). */
export const DIRECTION_FOR_KIND: Readonly<Record<ApprovalKind, Direction>> = { start: 'outgoing', accept: 'incoming', extend: 'none' };

/** Modes in which a session may not start, accept or receive (§8.4). `auto` is allowed with a warning. */
export const UNSAFE_MODES: ReadonlySet<PermissionMode> = new Set(['bypassPermissions']);
/** Modes in which `bridge_confirm` cannot be answered by a human (§8.4). */
export const NO_CONFIRM_MODES: ReadonlySet<PermissionMode> = new Set(['dontAsk']);
