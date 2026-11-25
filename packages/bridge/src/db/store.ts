// Typed repository over the schema. No rules live here: the engine decides, the store records.
import type { AgentType, ConversationState, DeliveryState, EndReason, MessageKind, Origin, ParticipantState, PermissionMode, Reason, Severity, ApprovalMode, OutboundItem } from '@agentbridge/protocol';
import type { Db } from './db.ts';

export type Inbound = 'accept' | 'hold' | 'refuse';

export interface ParticipantRow {
  id: string; agent: AgentType; name: string; display_name: string; title: string | null; cwd: string | null; claude_pid: number | null;
  session_id: string | null; transcript_path: string | null; permission_mode: PermissionMode; inbound: Inbound;
  state: ParticipantState; epoch: number; bot_id: string | null; created_at: number; updated_at: number;
  /** Git repository root of `cwd` (or `cwd` itself outside a repository); computed once when `cwd` is set. */
  project_root?: string | null;
}
export interface SessionRow {
  session_id: string; participant_id: string; claude_pid: number | null; source: string | null; transcript_path: string | null;
  cwd: string | null; linked_from: string | null; created_at: number; last_seen_at: number;
}
export interface BotRow { bot_id: string; participant_id: string; token_hash: string; created_at: number; revoked_at: number | null }
export interface ConversationRow {
  id: string; initiator_id: string; invitee_id: string; topic: string; state: ConversationState; end_reason: EndReason | null;
  turn_count: number; turn_limit: number; effective_mode: ApprovalMode; origin: Origin; continues: string | null;
  first_message_id: string | null; invite_issued_at: number | null; waiting_on: string | null; waiting_since: number | null;
  waiting_notified: number; grok_hint_sent: number; queued: number; created_at: number; updated_at: number; ended_at: number | null;
}
export type MessageStatus = DeliveryState;
export interface MessageRow {
  id: string; conversation_id: string; seq: number; turn: number | null; from_id: string; to_id: string; kind: MessageKind;
  body: string; in_reply_to: string | null; reply_expected: number; notice_code: string | null; notice_severity: Severity | null;
  status: MessageStatus; reason: Reason | null; replied_by: string | null; created_at: number;
}
/** Why a pending delivery is waiting (null = ready to try). */
export type Hold = 'policy' | 'closed' | 'unknown_mode' | 'unreachable' | 'serialized' | 'cap' | 'retry' | 'invite_wait' | null;
export interface DeliveryRow {
  id: string; participant_id: string; conversation_id: string | null; item: string; message_ids: string; state: DeliveryState;
  hold: Hold; reason: Reason | null; hint: string | null; attempts: number; run_uuid: string | null;
  created_at: number; updated_at: number; expires_at: number;
}
export interface EventRow {
  id: number; ts: number; level: 'info' | 'warning' | 'error'; type: string; participant_id: string | null;
  conversation_id: string | null; data: string; popup: number; shown: number;
}

type Val = string | number | null;
function setClause(patch: Record<string, unknown>): { sql: string; vals: Val[] } {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  for (const k of keys) if (!/^[a-z_]+$/.test(k)) throw new Error(`bad column ${k}`);
  return { sql: keys.map((k) => `${k} = ?`).join(', '), vals: keys.map((k) => patch[k] as Val) };
}

export class Store {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }
  tx<T>(fn: () => T): T { return this.db.tx(fn); }

  // ---------- participants ----------
  insertParticipant(p: ParticipantRow): void {
    this.db.run(`INSERT INTO participants (id, agent, name, display_name, title, cwd, claude_pid, session_id, transcript_path, permission_mode, inbound, state, epoch, bot_id, created_at, updated_at, project_root)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p.id, p.agent, p.name, p.display_name, p.title ?? null, p.cwd, p.claude_pid, p.session_id,
    p.transcript_path, p.permission_mode, p.inbound, p.state, p.epoch, p.bot_id, p.created_at, p.updated_at, p.project_root ?? null);
  }
  participant(id: string): ParticipantRow | undefined { return this.db.get<ParticipantRow>('SELECT * FROM participants WHERE id = ?', id); }
  participants(): ParticipantRow[] { return this.db.all<ParticipantRow>('SELECT * FROM participants ORDER BY created_at, id'); }
  participantsByName(agent: string, name: string): ParticipantRow[] {
    return this.db.all<ParticipantRow>('SELECT * FROM participants WHERE agent = ? AND name = ? ORDER BY created_at', agent, name);
  }
  participantByPid(pid: number): ParticipantRow | undefined {
    return this.db.get<ParticipantRow>("SELECT * FROM participants WHERE claude_pid = ? AND agent IN ('claude', 'codex') ORDER BY updated_at DESC LIMIT 1", pid);
  }
  updateParticipant(id: string, patch: Partial<Omit<ParticipantRow, 'id'>>): void {
    const { sql, vals } = setClause(patch); if (!sql) return;
    this.db.run(`UPDATE participants SET ${sql} WHERE id = ?`, ...vals, id);
  }
  deleteParticipant(id: string): void {
    this.db.run('DELETE FROM sessions WHERE participant_id = ?', id);
    this.db.run('DELETE FROM deliveries WHERE participant_id = ?', id);
    this.db.run('DELETE FROM participants WHERE id = ?', id);
  }

  // ---------- sessions ----------
  session(id: string): SessionRow | undefined { return this.db.get<SessionRow>('SELECT * FROM sessions WHERE session_id = ?', id); }
  sessionsOf(participantId: string): SessionRow[] { return this.db.all<SessionRow>('SELECT * FROM sessions WHERE participant_id = ? ORDER BY created_at', participantId); }
  upsertSession(s: SessionRow): void {
    this.db.run(`INSERT INTO sessions (session_id, participant_id, claude_pid, source, transcript_path, cwd, linked_from, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET participant_id = excluded.participant_id, claude_pid = excluded.claude_pid, source = excluded.source,
        transcript_path = coalesce(excluded.transcript_path, sessions.transcript_path), cwd = coalesce(excluded.cwd, sessions.cwd), last_seen_at = excluded.last_seen_at`,
    s.session_id, s.participant_id, s.claude_pid, s.source, s.transcript_path, s.cwd, s.linked_from, s.created_at, s.last_seen_at);
  }
  moveSessions(fromParticipant: string, toParticipant: string): void {
    this.db.run('UPDATE sessions SET participant_id = ? WHERE participant_id = ?', toParticipant, fromParticipant);
  }

  // ---------- bots ----------
  insertBot(b: BotRow): void {
    this.db.run('INSERT INTO bots (bot_id, participant_id, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)', b.bot_id, b.participant_id, b.token_hash, b.created_at, b.revoked_at);
  }
  bot(botId: string): BotRow | undefined { return this.db.get<BotRow>('SELECT * FROM bots WHERE bot_id = ?', botId); }
  botByParticipant(pid: string): BotRow | undefined { return this.db.get<BotRow>('SELECT * FROM bots WHERE participant_id = ?', pid); }
  bots(): BotRow[] { return this.db.all<BotRow>('SELECT * FROM bots ORDER BY created_at'); }
  updateBot(botId: string, patch: Partial<Omit<BotRow, 'bot_id' | 'participant_id'>>): void {
    const { sql, vals } = setClause(patch); if (!sql) return;
    this.db.run(`UPDATE bots SET ${sql} WHERE bot_id = ?`, ...vals, botId);
  }

  // ---------- conversations ----------
  insertConversation(c: ConversationRow): void {
    this.db.run(`INSERT INTO conversations (id, initiator_id, invitee_id, topic, state, end_reason, turn_count, turn_limit, effective_mode, origin, continues,
      first_message_id, invite_issued_at, waiting_on, waiting_since, waiting_notified, grok_hint_sent, queued, created_at, updated_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.id, c.initiator_id, c.invitee_id, c.topic, c.state, c.end_reason, c.turn_count, c.turn_limit, c.effective_mode, c.origin, c.continues,
    c.first_message_id, c.invite_issued_at, c.waiting_on, c.waiting_since, c.waiting_notified, c.grok_hint_sent, c.queued, c.created_at, c.updated_at, c.ended_at);
  }
  conversation(id: string): ConversationRow | undefined { return this.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id); }
  conversationsOf(participantId: string): ConversationRow[] {
    return this.db.all<ConversationRow>('SELECT * FROM conversations WHERE initiator_id = ? OR invitee_id = ? ORDER BY created_at, id', participantId, participantId);
  }
  conversations(state?: ConversationState): ConversationRow[] {
    return state ? this.db.all<ConversationRow>('SELECT * FROM conversations WHERE state = ? ORDER BY created_at, id', state)
      : this.db.all<ConversationRow>('SELECT * FROM conversations ORDER BY created_at, id');
  }
  updateConversation(id: string, patch: Partial<Omit<ConversationRow, 'id'>>): void {
    const { sql, vals } = setClause(patch); if (!sql) return;
    this.db.run(`UPDATE conversations SET ${sql} WHERE id = ?`, ...vals, id);
  }
  countPendingInvites(by: { initiator?: string; invitee?: string }): number {
    if (by.initiator) return this.db.get<{ n: number }>("SELECT count(*) AS n FROM conversations WHERE state = 'pending' AND initiator_id = ?", by.initiator)!.n;
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM conversations WHERE state = 'pending' AND invitee_id = ?", by.invitee!)!.n;
  }

  // ---------- messages ----------
  nextSeq(conversationId: string): number {
    return (this.db.get<{ s: number | null }>('SELECT max(seq) AS s FROM messages WHERE conversation_id = ?', conversationId)?.s ?? 0) + 1;
  }
  insertMessage(m: MessageRow): void {
    this.db.run(`INSERT INTO messages (id, conversation_id, seq, turn, from_id, to_id, kind, body, in_reply_to, reply_expected, notice_code, notice_severity, status, reason, replied_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, m.id, m.conversation_id, m.seq, m.turn, m.from_id, m.to_id, m.kind, m.body, m.in_reply_to,
    m.reply_expected, m.notice_code, m.notice_severity, m.status, m.reason, m.replied_by, m.created_at);
  }
  message(id: string): MessageRow | undefined { return this.db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id); }
  messages(conversationId: string, opts: { beforeSeq?: number; afterSeq?: number; limit?: number; kinds?: MessageKind[] } = {}): MessageRow[] {
    const where = ['conversation_id = ?']; const vals: Val[] = [conversationId];
    if (opts.beforeSeq !== undefined) { where.push('seq < ?'); vals.push(opts.beforeSeq); }
    if (opts.afterSeq !== undefined) { where.push('seq > ?'); vals.push(opts.afterSeq); }
    if (opts.kinds) { where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`); vals.push(...opts.kinds); }
    const limit = opts.limit ?? 1000;
    // newest `limit` before the cursor, returned oldest first
    return this.db.all<MessageRow>(`SELECT * FROM (SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`, ...vals, limit);
  }
  updateMessage(id: string, patch: Partial<Omit<MessageRow, 'id'>>): void {
    const { sql, vals } = setClause(patch); if (!sql) return;
    this.db.run(`UPDATE messages SET ${sql} WHERE id = ?`, ...vals, id);
  }

  // ---------- deliveries ----------
  insertDelivery(d: DeliveryRow): void {
    this.db.run(`INSERT INTO deliveries (id, participant_id, conversation_id, item, message_ids, state, hold, reason, hint, attempts, run_uuid, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, d.id, d.participant_id, d.conversation_id, d.item, d.message_ids, d.state, d.hold, d.reason, d.hint,
    d.attempts, d.run_uuid, d.created_at, d.updated_at, d.expires_at);
  }
  delivery(id: string): DeliveryRow | undefined { return this.db.get<DeliveryRow>('SELECT * FROM deliveries WHERE id = ?', id); }
  /** Deliveries not yet handed off, oldest first. */
  pendingDeliveries(participantId?: string): DeliveryRow[] {
    return participantId
      ? this.db.all<DeliveryRow>("SELECT * FROM deliveries WHERE participant_id = ? AND state IN ('accepted','queued','held_by_host') ORDER BY created_at, id", participantId)
      : this.db.all<DeliveryRow>("SELECT * FROM deliveries WHERE state IN ('accepted','queued','held_by_host') ORDER BY created_at, id");
  }
  deliveriesOf(conversationId: string): DeliveryRow[] {
    return this.db.all<DeliveryRow>('SELECT * FROM deliveries WHERE conversation_id = ? ORDER BY created_at, id', conversationId);
  }
  updateDelivery(id: string, patch: Partial<Omit<DeliveryRow, 'id'>>): void {
    const { sql, vals } = setClause(patch); if (!sql) return;
    this.db.run(`UPDATE deliveries SET ${sql} WHERE id = ?`, ...vals, id);
  }
  /** Deliveries handed off to a participant within [since, now] (Grok cap, §6.5). */
  countHandedOffSince(participantId: string, since: number): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM deliveries WHERE participant_id = ? AND state IN ('handed_off','delivered') AND updated_at >= ?", participantId, since)!.n;
  }

  // ---------- idempotency ----------
  idem(caller: string, epoch: number, key: string): { method: string; result: string; created_at: number } | undefined {
    return this.db.get('SELECT method, result, created_at FROM idempotency WHERE caller = ? AND epoch = ? AND key = ?', caller, epoch, key);
  }
  putIdem(caller: string, epoch: number, key: string, method: string, result: string, now: number): void {
    this.db.run('INSERT OR REPLACE INTO idempotency (caller, epoch, key, method, result, created_at) VALUES (?, ?, ?, ?, ?, ?)', caller, epoch, key, method, result, now);
  }
  purgeIdem(olderThan: number): number { return this.db.run('DELETE FROM idempotency WHERE created_at < ?', olderThan).changes; }

  // ---------- policy ----------
  policyRows(): Array<{ key: string; value: string }> { return this.db.all('SELECT key, value FROM policy ORDER BY key'); }
  replacePolicy(rows: Array<{ key: string; value: string }>): void {
    this.tx(() => {
      this.db.run('DELETE FROM policy');
      for (const r of rows) this.db.run('INSERT INTO policy (key, value) VALUES (?, ?)', r.key, r.value);
    });
  }

  // ---------- kv (non-security bridge state: relay ack cursor, connected-time usage) ----------
  kvGet(key: string): string | undefined { return this.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value; }
  kvSet(key: string, value: string, now: number = Date.now()): void {
    this.db.run('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, value, now);
  }

  // ---------- events (log + pending popups) ----------
  insertEvent(e: Omit<EventRow, 'id' | 'shown'>): number {
    this.db.run('INSERT INTO events (ts, level, type, participant_id, conversation_id, data, popup) VALUES (?, ?, ?, ?, ?, ?, ?)',
      e.ts, e.level, e.type, e.participant_id, e.conversation_id, e.data, e.popup);
    return Number(this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id);
  }
  events(opts: { type?: string; limit?: number; sinceId?: number } = {}): EventRow[] {
    const where: string[] = []; const vals: Val[] = [];
    if (opts.type) { where.push('type = ?'); vals.push(opts.type); }
    if (opts.sinceId !== undefined) { where.push('id > ?'); vals.push(opts.sinceId); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.all<EventRow>(`SELECT * FROM (SELECT * FROM events ${w} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`, ...vals, opts.limit ?? 200);
  }
  unshownPopups(): EventRow[] { return this.db.all<EventRow>('SELECT * FROM events WHERE popup = 1 AND shown = 0 ORDER BY id'); }
  /** Events of one type for these conversations, oldest first (agent panel: approval provenance). */
  conversationEvents(conversationIds: readonly string[], type: string): EventRow[] {
    if (!conversationIds.length) return [];
    return this.db.all<EventRow>(`SELECT * FROM events WHERE type = ? AND conversation_id IN (${conversationIds.map(() => '?').join(', ')}) ORDER BY id`, type, ...conversationIds);
  }
  /** The newest popups, shown or not (read-only: `status --watch` must not take them from `status`). */
  recentPopups(limit: number): EventRow[] { return this.db.all<EventRow>('SELECT * FROM events WHERE popup = 1 ORDER BY id DESC LIMIT ?', limit).reverse(); }
  markShown(ids: number[]): void { for (const id of ids) this.db.run('UPDATE events SET shown = 1 WHERE id = ?', id); }
}

export const parseItem = (d: DeliveryRow): OutboundItem => JSON.parse(d.item) as OutboundItem;
