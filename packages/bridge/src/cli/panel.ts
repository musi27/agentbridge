// Agent panel view model (`agentbridge status --watch`, later the AgentBridge.app menu-bar dropdown and graph window).
// buildPanel() is the one pure step from a `cli.status {watch: true}` answer to view rows; renderPanel() turns those
// rows into terminal lines. Neither does I/O. Every agent-written string (topics, titles, notice text, addresses) is
// cleaned in buildPanel, so any surface that draws PanelView gets plain text only.
import { versionMismatch } from '../version.ts';

/** The `cli.status` answer with `watch: true`. Watch fields are optional: an older bridge doesn't send them. */
export interface WatchStatus {
  bridge_version: string; pid: number; started_at?: string | null; cli_version?: string;
  policy: { ok: boolean; mode?: string; version?: number; reason?: string };
  participants: Array<{ address: string; title?: string; short_id: string; state: string; permission_mode: string; folder?: string; project?: { key: string; label: string } | null }>;
  auto_mode_sessions: string[];
  conversations: Record<string, number>;
  queued_deliveries: number;
  pending_approvals: Array<{ approval_id: string; kind: string; participant: string; peer: string; topic?: string; turn_limit?: number; expires_in_s: number | null; expires_at?: string | null; conversation_id?: string | null }>;
  live_connections?: number;
  notifications?: Array<{ at: string; title?: string; body?: string }>;
  conversation_list?: Array<{
    id: string; initiator: string; invitee: string; topic: string; state: string; turn_count: number; turn_limit: number; origin?: string; queued: boolean; updated_at: string;
    // 0.2.9+: ended-today rows, times and approval provenance (status --json)
    created_at?: string; ended_at?: string | null; end_reason?: string | null;
    approvals?: Array<{ kind: string; via: string; agent: string; at: string; turn_limit?: number }>;
  }>;
  waiting_deliveries?: Array<{ participant: string; hold: string | null; count: number }>;
  recent_notices?: Array<{ at: string; title?: string; body?: string }>;
  relay?: { configured: boolean; connected: boolean | null; mode: string | null };
  now?: string;
}

export type RelayState = 'connected' | 'idle' | 'not_configured' | 'unknown';
export type AgentActivity = 'waiting_first_prompt' | 'approval' | 'in_conversation' | 'unreachable' | 'live';

export interface PanelHealth {
  bridgeVersion: string; pid: number; cliVersion: string;
  /** Null when the CLI and the running bridge are the same release. */
  versionMismatch: string | null;
  policyOk: boolean; policy: string;
  relay: RelayState; relayText: string;
  /** False when the bridge is older and sent no watch fields (conversations and notices are then missing). */
  complete: boolean;
}
export interface WaitingApproval { type: 'approval'; id: string; kind: string; participant: string; peer: string; topic: string; turnLimit: number | null; expiresInS: number | null; text: string }
export interface WaitingDelivery { type: 'delivery'; participant: string; hold: string | null; count: number; text: string }
export type WaitingRow = WaitingApproval | WaitingDelivery;
export interface ConversationView { id: string; a: string; b: string; topic: string; state: string; turnsUsed: number; turnLimit: number; queued: boolean; updatedAt: string; agoS: number }
export interface AgentView { address: string; kind: string; title: string; mode: string; state: string; activity: AgentActivity; shortId: string; folder: string }
export interface NoticeView { at: string; agoS: number; title: string; body: string }
export interface PanelView {
  at: string;
  health: PanelHealth;
  waiting: WaitingRow[];
  conversations: ConversationView[];
  agents: AgentView[];
  closedCount: number;
  notices: NoticeView[];
  warnings: string[];
}

// CSI (ESC [ … final), OSC (ESC ] … BEL or ST), other two-byte ESC sequences, then any C0/C1 control or DEL left over,
// plus bidi overrides and isolates that can reorder what the user reads.
const ANSI_SEQ = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Agent-written text as one line of plain text: escape sequences and control characters removed, whitespace collapsed. */
export function plainText(s: unknown): string {
  if (typeof s !== 'string') return s === undefined || s === null ? '' : plainText(String(s));
  return s.replace(ANSI_SEQ, '').replace(/[\t\n\r\v\f]+/g, ' ').replace(CONTROL, '').replace(/ {2,}/g, ' ').trim();
}

const HOLD_TEXT: Record<string, string> = {
  unknown_mode: 'held until someone types in it (waiting for first prompt)',
  closed: 'queued until the session is open again',
  unreachable: 'held: the session does not accept cross-session messages',
  policy: 'held: policy check failed (agentbridge config verify)',
  serialized: 'held until the peer replies to the previous message',
  cap: "held: this bot's hourly delivery cap is reached",
  retry: 'retrying delivery',
  invite_wait: 'held until the invite is accepted',
};

const ms = (iso: string | undefined | null): number | null => { if (!iso) return null; const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };
const HOSTS = new Set(['claude', 'codex']);

/** State → view rows. Pure: `nowMs` (default: the bridge's `now`) is the only clock. */
export function buildPanel(s: WatchStatus, o: { cliVersion: string; nowMs?: number }): PanelView {
  const now = o.nowMs ?? ms(s.now) ?? 0;
  const agoS = (iso: string): number => { const t = ms(iso); return t === null ? 0 : Math.max(0, Math.round((now - t) / 1000)); };
  const complete = s.conversation_list !== undefined;

  const relay: RelayState = !s.relay ? 'unknown' : !s.relay.configured ? 'not_configured' : s.relay.connected === true ? 'connected' : s.relay.connected === false ? 'idle' : 'unknown';
  const relayText = relay === 'connected' ? 'relay connected'
    : relay === 'idle' ? (s.relay?.mode === 'always' ? 'relay DISCONNECTED' : 'relay idle (connects when a Grok bot needs it)')
    : relay === 'not_configured' ? 'relay not set up' : 'relay ?';
  const health: PanelHealth = {
    bridgeVersion: plainText(s.bridge_version), pid: s.pid, cliVersion: o.cliVersion,
    versionMismatch: versionMismatch(s.bridge_version, o.cliVersion),
    policyOk: s.policy.ok,
    policy: s.policy.ok ? `policy v${s.policy.version ?? '?'}, ${s.policy.mode ?? '?'}` : `policy TAMPERED (${plainText(s.policy.reason)}): run agentbridge config verify`,
    relay, relayText, complete,
  };

  const conversations: ConversationView[] = (s.conversation_list ?? [])
    .filter((c) => c.state !== 'ended')
    .map((c) => ({ id: plainText(c.id), a: plainText(c.initiator), b: plainText(c.invitee), topic: plainText(c.topic), state: plainText(c.state), turnsUsed: c.turn_count, turnLimit: c.turn_limit, queued: !!c.queued, updatedAt: c.updated_at, agoS: agoS(c.updated_at) }))
    .sort((x, y) => (x.state === y.state ? x.agoS - y.agoS : x.state === 'active' ? -1 : 1));

  const approvals: WaitingApproval[] = s.pending_approvals.map((a) => {
    const participant = plainText(a.participant);
    const expires = a.expires_in_s === null ? '' : ` · expires in ${duration(a.expires_in_s)}`;
    return { type: 'approval', id: plainText(a.approval_id), kind: plainText(a.kind), participant, peer: plainText(a.peer), topic: plainText(a.topic), turnLimit: a.turn_limit ?? null, expiresInS: a.expires_in_s, text: `approve in ${participant}'s own prompt${expires}` };
  });
  const deliveries: WaitingDelivery[] = (s.waiting_deliveries ?? [])
    .filter((d) => d.hold !== null)
    .map((d) => ({ type: 'delivery', participant: plainText(d.participant), hold: d.hold, count: d.count, text: `${d.count} message${d.count === 1 ? '' : 's'} ${HOLD_TEXT[d.hold!] ?? `held (${plainText(d.hold)})`}` }));

  const approvalFor = new Set(approvals.map((a) => a.participant));
  const inConv = new Set(conversations.filter((c) => c.state === 'active').flatMap((c) => [c.a, c.b]));
  const agents: AgentView[] = [];
  let closedCount = 0;
  for (const p of s.participants) {
    if (p.state === 'closed' || p.state === 'gone') { closedCount++; continue; }
    const address = plainText(p.address);
    const kind = address.includes(':') ? address.slice(0, address.indexOf(':')) : address;
    const firstPrompt = HOSTS.has(kind) && p.state === 'live' && p.permission_mode === 'unknown';
    const activity: AgentActivity = p.state === 'unreachable' ? 'unreachable' : firstPrompt ? 'waiting_first_prompt' : approvalFor.has(address) ? 'approval' : inConv.has(address) ? 'in_conversation' : 'live';
    const mode = !HOSTS.has(kind) ? 'bot' : p.permission_mode === 'unknown' ? '-' : plainText(p.permission_mode);
    agents.push({ address, kind, title: plainText(p.title), mode, state: plainText(p.state), activity, shortId: plainText(p.short_id), folder: plainText(p.folder) });
  }
  agents.sort((x, y) => x.address.localeCompare(y.address));

  const notices: NoticeView[] = (s.recent_notices ?? s.notifications ?? []).map((n) => ({ at: n.at, agoS: agoS(n.at), title: plainText(n.title), body: plainText(n.body) })).reverse();
  const warnings: string[] = [];
  if (s.auto_mode_sessions.length) warnings.push(`auto mode (Claude Code may not ask before shell commands): ${s.auto_mode_sessions.map(plainText).join(', ')}`);

  return { at: new Date(now).toISOString(), health, waiting: [...approvals, ...deliveries], conversations, agents, closedCount, notices, warnings };
}

/** 75 → "1m", 3600 → "1h". */
export function duration(s: number): string {
  if (s < 60) return `${Math.max(0, Math.round(s))}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const ago = (s: number): string => (s < 5 ? 'just now' : `${duration(s)} ago`);

const ACTIVITY_TEXT: Record<AgentActivity, string> = {
  waiting_first_prompt: 'waiting for first prompt', approval: 'approval waiting', in_conversation: 'in conversation', unreachable: 'unreachable', live: 'live',
};

export interface RenderOptions { width?: number; color?: boolean; clock?: string }

/** View rows → terminal lines (no trailing newlines). Lines are cut to `width` columns. */
export function renderPanel(v: PanelView, o: RenderOptions = {}): string[] {
  const width = Math.max(40, o.width ?? 100);
  const c = (code: string, t: string): string => (o.color ? `\u001b[${code}m${t}\u001b[0m` : t);
  const dim = (t: string): string => c('2', t); const bold = (t: string): string => c('1', t);
  const yellow = (t: string): string => c('33', t); const green = (t: string): string => c('32', t); const blue = (t: string): string => c('34', t); const red = (t: string): string => c('31', t);
  const out: Array<[string, string]> = []; // [plain, styled]: plain decides the cut, styled is printed
  const line = (plain = '', styled = plain): void => { out.push([plain, styled]); };
  const quote = (t: string): string => (t ? `"${t}"` : '');

  const h = v.health;
  const head = `agentbridge ${h.bridgeVersion} · pid ${h.pid} · ${h.relayText} · ${h.policy}`;
  const clock = o.clock ?? '';
  line(`${head}   ${clock}`, `${h.policyOk ? head : red(head)}   ${dim(clock)}`);
  if (h.versionMismatch) { const t = `warning: ${h.versionMismatch}; run agentbridge init to restart the bridge on this version`; line(t, yellow(t)); }
  if (!h.complete) { const t = 'note: this bridge is older than the CLI, so conversations and notices are missing here'; line(t, yellow(t)); }
  for (const w of v.warnings) line(`warning: ${w}`, yellow(`warning: ${w}`));
  line();

  line('WAITING ON YOU', bold(yellow('WAITING ON YOU')));
  if (!v.waiting.length) line(' nothing', dim(' nothing'));
  for (const w of v.waiting) {
    if (w.type === 'approval') {
      const who = w.kind === 'accept' ? `${w.peer} → ${w.participant}` : w.kind === 'start' ? `${w.participant} → ${w.peer}` : `${w.participant} ↔ ${w.peer}`;
      const t = ` ● ${w.kind}: ${who}   ${quote(w.topic)}${w.turnLimit !== null ? `  (${w.turnLimit} turns)` : ''}`;
      line(t, `${yellow(' ●')}${t.slice(2)}`);
      line(`   ${w.text}`, dim(`   ${w.text}`));
    } else {
      const t = ` ● ${w.participant}: ${w.text}`;
      line(t, `${yellow(' ●')}${t.slice(2)}`);
    }
  }
  line();

  line('CONVERSATIONS', bold(blue('CONVERSATIONS')));
  if (!v.conversations.length) line(h.complete ? ' none active' : ' (not available from this bridge)', dim(h.complete ? ' none active' : ' (not available from this bridge)'));
  for (const cv of v.conversations) {
    const t = ` ◆ ${cv.a} ↔ ${cv.b}${cv.state === 'active' ? '' : cv.queued ? '   (invite queued)' : '   (invite pending)'}`;
    line(t, `${blue(' ◆')}${t.slice(2)}`);
    const d = `   ${quote(cv.topic) || '(no topic)'}   ${cv.turnsUsed}/${cv.turnLimit} · ${ago(cv.agoS)}`;
    line(d, `   ${quote(cv.topic) || '(no topic)'}   ${dim(`${cv.turnsUsed}/${cv.turnLimit} · ${ago(cv.agoS)}`)}`);
  }
  line();

  const addrW = Math.min(30, Math.max(14, ...v.agents.map((a) => a.address.length)));
  const head2 = `AGENTS${' '.repeat(addrW - 2)}mode            state`;
  line(head2, `${bold(green('AGENTS'))}${dim(head2.slice(6))}`);
  if (!v.agents.length) line(' no live agents', dim(' no live agents'));
  for (const a of v.agents) {
    const dot = a.activity === 'live' || a.activity === 'in_conversation' ? green(' ●') : yellow(' ●');
    const t = ` ● ${a.address.padEnd(addrW)} ${a.mode.padEnd(15)} ${ACTIVITY_TEXT[a.activity]}${a.title ? `  ${quote(a.title)}` : ''}`;
    line(t, `${dot}${t.slice(2)}`);
  }
  if (v.closedCount) line(`   + ${v.closedCount} closed`, dim(`   + ${v.closedCount} closed`));
  line();

  line('NOTICES', bold('NOTICES'));
  if (!v.notices.length) line(' none', dim(' none'));
  for (const n of v.notices) {
    const t = ` ${ago(n.agoS).padEnd(9)} ${n.title}${n.body ? ` — ${n.body}` : ''}`;
    line(t, `${dim(` ${ago(n.agoS).padEnd(9)}`)}${t.slice(10)}`);
  }

  return out.map(([plain, styled]) => (plain.length <= width ? styled : cut(plain, width)));
}

/** Cut a plain line to `width` columns with an ellipsis (styling is dropped on cut lines). */
function cut(s: string, width: number): string {
  const chars = [...s];
  return chars.length <= width ? s : `${chars.slice(0, width - 1).join('')}…`;
}
