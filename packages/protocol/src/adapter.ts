// Adapter interface (§11.1). The bridge core calls adapters; adapters never touch storage or policy.
import type { AgentType, Reason, Severity } from './enums.ts';
import type { NoticePart } from './framing.ts';

export interface ParticipantRef {
  participant_id: string; address: string; agent: AgentType;
  /** Claude/Codex: tag nonce for framing. Grok: unused. */
  tag_nonce?: string;
  /** Codex: the session (thread) id that `codex queue` posts into (§11a). */
  session_id?: string;
}

export interface OutboundMessage { message_id: string; seq: number; turn?: number; from_address: string; body: string; in_reply_to?: string; created_at: string }
export interface OutboundNotice {
  id: string; code: string; severity: Severity;
  /** Claude rendering: structured parts (remote text only via untrusted()). */
  parts: readonly NoticePart[];
  /** Grok rendering: plain text (bridge-written; remote text quoted). */
  text: string;
}

/** One delivery to one participant: new messages and/or notices in one conversation (or a conversation-less notice). */
export interface OutboundItem {
  item_id: string; // ULID; idempotency for retries
  conversation?: { id: string; topic: string; peer_address: string; turn: number; turn_limit: number; state: 'pending' | 'active' | 'ended' };
  messages: OutboundMessage[];
  notices: OutboundNotice[];
  reply_to: string | null;
}

export type DeliverOutcome =
  | { status: 'delivered' | 'handed_off'; run_uuid?: string }
  | { status: 'queued' | 'held_by_host'; reason?: Reason; hint?: string }
  | { status: 'failed'; reason: Reason; hint?: string; retryable: boolean };

export interface AdapterCapabilities {
  receive: 'inbox_push' | 'webhook' | 'memory';
  /** Host has a native always-prompt confirm (Claude Code requiresUserInteraction). */
  native_confirm: boolean;
  /** Can the bridge learn that a delivery reached the agent? (Claude inbox: no; M0 V2.) */
  delivery_confirmable: boolean;
}

export interface DoctorCheck { id: string; ok: boolean; detail: string; fix?: string }

export interface Adapter {
  describe(): { name: string; version: string; agent: AgentType };
  capabilities(): AdapterCapabilities;
  deliver(item: OutboundItem, to: ParticipantRef): Promise<DeliverOutcome>;
  doctor(): Promise<DoctorCheck[]>;
}

/** A live plugin connection for one Claude participant, owned by the bridge's IPC server (§11.3).
 *  `deliver` sends the `deliver` event and resolves with each post's `post_result`. */
export interface ParticipantLink {
  deliver(items: Array<{ post_id: string; text: string }>, opts?: { thread_id?: string }): Promise<Array<{ post_id: string; ok: boolean; error?: string }>>;
}
export type LinkLookup = (participant_id: string) => ParticipantLink | null;
