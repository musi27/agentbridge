// `agentbridge status --json` and `status --watch --json`: the versioned data contract for the agent panel
// (AgentBridge.app menu-bar dropdown and graph window). Schema: docs/status-json.md.
// Built from the same `cli.status {watch: true}` answer as the terminal panel, via buildPanel(); every field is listed
// explicitly (no spreading of bridge objects), so message bodies, transcripts, tokens and secrets cannot slip in.
import { buildPanel, plainText, type WatchStatus } from './panel.ts';

/** Bump on a breaking change (a field removed, renamed or retyped). New fields can appear without a bump. */
export const STATUS_SCHEMA = 1;

export type Project = { key: string; label: string };
export type ApprovalVia = 'prompt' | 'cli' | 'allow_rule' | 'bot';

export interface StatusBridge {
  running: true;
  version: string; pid: number; started_at: string | null; cli_version: string;
  /** Null when the CLI and the running bridge are the same release. */
  version_mismatch: string | null;
  /** False when the bridge is older than the CLI and sent no panel fields (conversations, notices, projects missing). */
  complete: boolean;
  policy: { ok: true; version: number | null; mode: string | null } | { ok: false; reason: string };
  relay: { state: 'connected' | 'idle' | 'not_configured' | 'unknown'; mode: string | null };
}
export interface NeedsApproval {
  type: 'approval'; approval_id: string; kind: string;
  from: string; to: string; topic: string; turn_limit: number | null; expires_at: string | null; conversation_id: string | null;
  /** The agent whose own permission prompt shows the approval. */
  answer_in: string;
  /** `prompt`: answer in that prompt; `cli`: that session cannot show prompts (dontAsk), use `agentbridge approve <id>`. */
  answer_with: 'prompt' | 'cli';
}
export interface NeedsHeld { type: 'held_messages'; agent: string; hold: string; count: number; text: string }
export interface StatusAgent {
  address: string; app: string; name: string; short_id: string; title: string | null;
  /** Permission mode of a Claude Code / Codex session; null for bots and before the session's first prompt. */
  mode: string | null;
  state: string;
  activity: 'waiting_first_prompt' | 'approval' | 'in_conversation' | 'unreachable' | 'live' | 'closed';
  folder: string | null;
  project: Project | null;
}
export interface StatusConversation {
  id: string; from: string; to: string; topic: string; state: string; end_reason: string | null;
  turns: { used: number; limit: number };
  origin: string | null; queued: boolean;
  started_at: string | null; ended_at: string | null; last_activity_at: string;
  approvals: Array<{ kind: string; via: string; agent: string; at: string; turn_limit?: number }>;
  /** The last turns (at most 50), oldest first: who took each and when. Never message text. Empty from older bridges. */
  turn_log: Array<{ turn: number; from: string; at: string }>;
}
export interface StatusNotice { at: string; title: string; body: string }
export interface StatusWarning { code: string; text: string; agents?: string[] }

export interface StatusSnapshot {
  schema: number; kind: 'snapshot'; generated_at: string;
  bridge: StatusBridge | { running: false; error: string; cli_version: string };
  warnings: StatusWarning[];
  needs_you: Array<NeedsApproval | NeedsHeld>;
  agents: StatusAgent[];
  closed_agents: number;
  conversations: StatusConversation[];
  notices: StatusNotice[];
}
export interface StatusHeartbeat { schema: number; kind: 'heartbeat'; generated_at: string }

const HOSTS = new Set(['claude', 'codex']);
const NO_PROMPT_MODES = new Set(['dontAsk']);
const iso = (ms: number): string => new Date(ms).toISOString();
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const project = (p: { key: string; label: string } | null | undefined): Project | null => (p ? { key: plainText(p.key), label: noPaths(plainText(p.label)) } : null);

// An absolute path (two or more segments) at the start of the text or after a space, quote, bracket, `=` or `:`.
const ABS_PATH = /(^|[\s"'`(=:\[])\/(?:[^\s"'`)\]/]+\/)+([^\s"'`)\]/]*)/g;
/** Free text with every absolute path cut to its last segment (`…/name`): the snapshot never carries local paths. */
export function noPaths(s: string): string {
  return s.replace(ABS_PATH, (_m, pre: string, last: string) => `${pre}…/${last}`);
}

/** One snapshot from a `cli.status {watch: true}` answer. Pure: `nowMs` is only used for `generated_at`. */
export function buildStatusJson(s: WatchStatus, o: { cliVersion: string; nowMs: number }): StatusSnapshot {
  const v = buildPanel(s, { cliVersion: o.cliVersion, nowMs: o.nowMs });
  const h = v.health;
  const bridge: StatusBridge = {
    running: true, version: h.bridgeVersion, pid: h.pid, started_at: s.started_at ?? null, cli_version: o.cliVersion,
    version_mismatch: h.versionMismatch, complete: h.complete,
    policy: s.policy.ok ? { ok: true, version: s.policy.version ?? null, mode: s.policy.mode ? plainText(s.policy.mode) : null } : { ok: false, reason: noPaths(plainText(s.policy.reason)) },
    relay: { state: h.relay, mode: s.relay?.mode ?? null },
  };

  const warnings: StatusWarning[] = [];
  if (h.versionMismatch) warnings.push({ code: 'version_mismatch', text: `${noPaths(h.versionMismatch)}; run agentbridge init to restart the bridge on this version` });
  if (!s.policy.ok) warnings.push({ code: 'policy_tampered', text: noPaths(h.policy) });
  if (s.auto_mode_sessions.length) {
    const agents = s.auto_mode_sessions.map(plainText).sort(cmp);
    warnings.push({ code: 'auto_mode', agents, text: 'Claude Code may not ask before shell commands in these sessions' });
  }
  if (bridge.relay.state === 'idle' && bridge.relay.mode === 'always') warnings.push({ code: 'relay_disconnected', text: h.relayText });

  // raw rows by cleaned address: the view model drops fields the panel doesn't draw (project, permission mode, expiry)
  const raw = new Map(s.participants.map((p) => [plainText(p.address), p]));
  const expiresAt = new Map(s.pending_approvals.map((a) => [plainText(a.approval_id), a]));
  const approvals: NeedsApproval[] = [];
  const held: NeedsHeld[] = [];
  for (const w of v.waiting) {
    if (w.type === 'approval') {
      const a = expiresAt.get(w.id);
      const [from, to] = w.kind === 'accept' ? [w.peer, w.participant] : [w.participant, w.peer];
      const mode = raw.get(w.participant)?.permission_mode ?? '';
      approvals.push({
        type: 'approval', approval_id: w.id, kind: w.kind, from, to, topic: noPaths(w.topic), turn_limit: w.turnLimit,
        // older bridges send only the relative expiry; turn it into a time once here
        expires_at: a?.expires_at ?? (w.expiresInS === null ? null : iso(Math.round(o.nowMs / 1000) * 1000 + w.expiresInS * 1000)),
        conversation_id: a?.conversation_id ? plainText(a.conversation_id) : null,
        answer_in: w.participant, answer_with: NO_PROMPT_MODES.has(mode) ? 'cli' : 'prompt',
      });
    } else held.push({ type: 'held_messages', agent: w.participant, hold: plainText(w.hold), count: w.count, text: noPaths(w.text) });
  }
  approvals.sort((x, y) => (x.expires_at === y.expires_at ? cmp(x.approval_id, y.approval_id) : x.expires_at === null ? 1 : y.expires_at === null ? -1 : cmp(x.expires_at, y.expires_at)));
  held.sort((x, y) => cmp(x.agent, y.agent) || cmp(x.hold, y.hold));

  const conversations: StatusConversation[] = (s.conversation_list ?? []).map((c) => ({
    id: plainText(c.id), from: plainText(c.initiator), to: plainText(c.invitee), topic: noPaths(plainText(c.topic)), state: plainText(c.state), end_reason: c.end_reason ? plainText(c.end_reason) : null,
    turns: { used: c.turn_count, limit: c.turn_limit }, origin: c.origin ? plainText(c.origin) : null, queued: !!c.queued,
    started_at: c.created_at ?? null, ended_at: c.ended_at ?? null, last_activity_at: c.updated_at,
    approvals: (c.approvals ?? []).map((a) => ({ kind: plainText(a.kind), via: plainText(a.via), agent: plainText(a.agent), at: a.at, ...(a.turn_limit !== undefined ? { turn_limit: a.turn_limit } : {}) })),
    turn_log: (c.turn_log ?? []).map((t) => ({ turn: t.turn, from: plainText(t.from), at: t.at })),
  })).sort((x, y) => cmp(y.last_activity_at, x.last_activity_at) || cmp(x.id, y.id));

  const agentOf = (address: string, base: { kind: string; title: string; state: string; activity: StatusAgent['activity']; shortId: string; folder: string }): StatusAgent => {
    const r = raw.get(address);
    const mode = r && HOSTS.has(base.kind) && r.permission_mode !== 'unknown' ? plainText(r.permission_mode) : null;
    return {
      address, app: base.kind, name: address.slice(base.kind.length + 1), short_id: base.shortId, title: noPaths(base.title) || null, mode, state: base.state, activity: base.activity,
      folder: noPaths(base.folder) || null, project: project(r?.project),
    };
  };
  const agents = v.agents.map((a) => agentOf(a.address, a));
  // a closed agent stays out (it counts in closed_agents) unless a listed conversation names it: the graph needs its node
  const shown = new Set(agents.map((a) => a.address));
  let closed = v.closedCount;
  for (const c of conversations) for (const address of [c.from, c.to]) {
    const r = raw.get(address);
    if (shown.has(address) || !r || (r.state !== 'closed' && r.state !== 'gone')) continue;
    shown.add(address); closed--;
    const kind = address.includes(':') ? address.slice(0, address.indexOf(':')) : address;
    agents.push(agentOf(address, { kind, title: plainText(r.title), state: plainText(r.state), activity: 'closed', shortId: plainText(r.short_id), folder: plainText(r.folder) }));
  }
  // by project (label, then key; agents without a project, e.g. Grok bots, last), then address
  agents.sort((x, y) => (x.project === null) !== (y.project === null) ? (x.project === null ? 1 : -1)
    : cmp(x.project?.label ?? '', y.project?.label ?? '') || cmp(x.project?.key ?? '', y.project?.key ?? '') || cmp(x.address, y.address));

  return {
    schema: STATUS_SCHEMA, kind: 'snapshot', generated_at: iso(o.nowMs), bridge, warnings,
    needs_you: [...approvals, ...held], agents, closed_agents: Math.max(0, closed), conversations,
    notices: v.notices.map((n) => ({ at: n.at, title: noPaths(n.title), body: noPaths(n.body) })),
  };
}

/** The snapshot when the bridge can't be reached: same shape, empty lists. */
export function notRunning(error: string, o: { cliVersion: string; nowMs: number }): StatusSnapshot {
  return {
    schema: STATUS_SCHEMA, kind: 'snapshot', generated_at: iso(o.nowMs), bridge: { running: false, error: noPaths(plainText(error)), cli_version: o.cliVersion },
    warnings: [], needs_you: [], agents: [], closed_agents: 0, conversations: [], notices: [],
  };
}

/** The snapshot without `generated_at`: equal keys mean nothing changed (watch de-duplication). */
export function changeKey(s: StatusSnapshot): string {
  const { generated_at: _ignored, ...rest } = s;
  return JSON.stringify(rest);
}
