// Claude Code and Codex deliveries (§11.3, §11a): render an OutboundItem with the session's tag nonce (§8.1) and hand it to the
// session's live plugin connection (LinkLookup). Inbox writes never report delivery, so success = handed_off.
import { renderMessage, renderNotice, ulid, LIMITS, type Adapter, type AdapterCapabilities, type DeliverOutcome, type DoctorCheck, type LinkLookup, type OutboundItem, type ParticipantRef } from '@agentbridge/protocol';

/** One post per item: notices first, then messages, each a self-delimited block with a unique id. */
export function renderClaudePost(item: OutboundItem, nonce: string): string {
  const blocks: string[] = [];
  for (const n of item.notices) {
    blocks.push(renderNotice({ nonce, code: n.code, severity: n.severity, id: n.id, ...(item.conversation ? { conversationId: item.conversation.id } : {}), parts: n.parts }));
  }
  for (const m of item.messages) {
    blocks.push(renderMessage({
      nonce, conversationId: item.conversation?.id ?? '', from: m.from_address, turn: m.turn ?? 0,
      turnLimit: item.conversation?.turn_limit ?? LIMITS.turnLimitDefault, id: m.message_id, body: m.body,
    }));
  }
  return blocks.join('\n\n');
}

export class ClaudeLinkAdapter implements Adapter {
  private readonly lookup: LinkLookup;
  private readonly spacingMs: number;
  private readonly lastPost = new Map<string, number>();
  constructor(lookup: LinkLookup, spacingMs: number = LIMITS.inboxPostSpacingMs) { this.lookup = lookup; this.spacingMs = spacingMs; }

  describe(): { name: string; version: string; agent: 'claude' } { return { name: 'claude-code-link', version: '0.1.0', agent: 'claude' }; }
  capabilities(): AdapterCapabilities { return { receive: 'inbox_push', native_confirm: true, delivery_confirmable: false }; }

  async deliver(item: OutboundItem, to: ParticipantRef): Promise<DeliverOutcome> {
    const link = this.lookup(to.participant_id);
    if (!link || !to.tag_nonce) return { status: 'queued' };
    // Codex: the plugin posts with `codex queue --thread <session id>`, so the id must be known (SessionStart hook)
    if (to.agent === 'codex' && !to.session_id) return { status: 'queued' };
    const text = renderClaudePost(item, to.tag_nonce);
    const post_id = ulid();
    // pace posts per session (Claude Code rate-limits per sender, §11.3); the pipeline is serial per participant
    const wait = (this.lastPost.get(to.participant_id) ?? 0) + this.spacingMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastPost.set(to.participant_id, Date.now());
    let res: Array<{ post_id: string; ok: boolean; error?: string }>;
    try { res = await link.deliver([{ post_id, text }], to.agent === 'codex' ? { thread_id: to.session_id! } : {}); }
    catch { return { status: 'queued' }; } // connection dropped mid-delivery: redeliver on reconnect (at-least-once)
    const r = res.find((x) => x.post_id === post_id);
    if (r?.ok) return { status: 'handed_off' };
    return { status: 'failed', reason: 'host_refused', hint: r?.error ?? 'inbox write failed', retryable: true };
  }

  async doctor(): Promise<DoctorCheck[]> { return []; }
}
