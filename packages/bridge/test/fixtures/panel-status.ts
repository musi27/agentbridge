// Fake `cli.status {watch: true}` answer for the agent panel tests and the PR capture. All names are made up.
import type { WatchStatus } from '../../src/cli/panel.ts';
import { projectKey } from '../../src/core/project.ts';

export const NOW = Date.parse('2026-11-24T14:32:10Z');
const at = (agoS: number): string => new Date(NOW - agoS * 1000).toISOString();
// project keys are opaque hashes of the git repository root (projectKey); made-up roots
const proj = (label: string) => ({ key: projectKey(`/home/dev/src/${label}`), label });
const P = { agentbridge: proj('agentbridge'), video: proj('video-notes'), landing: proj('landing'), trading: proj('trading-bot'), oldDocs: proj('old-docs') };

export function fixtureStatus(): WatchStatus {
  return {
    bridge_version: '0.2.3', pid: 4182, started_at: at(3600),
    policy: { ok: true, version: 7, mode: 'per_conversation' },
    participants: [
      { address: 'claude:agentbridge', title: 'status --watch', short_id: 'a1b2c3', state: 'live', permission_mode: 'default', folder: 'agentbridge', project: P.agentbridge },
      { address: 'claude:video-notes', title: 'b-roll ideas', short_id: 'd4e5f6', state: 'live', permission_mode: 'acceptEdits', folder: 'video-notes', project: P.video },
      { address: 'claude:landing', short_id: 'aa11bb', state: 'live', permission_mode: 'unknown', folder: 'landing', project: P.landing },
      { address: 'codex:trading-bot', short_id: '778899', state: 'live', permission_mode: 'default', folder: 'trading-bot', project: P.trading },
      { address: 'grok:researcher', short_id: 'g00001', state: 'live', permission_mode: 'default', project: null },
      { address: 'claude:old-docs', short_id: 'c0c0c0', state: 'closed', permission_mode: 'unknown', folder: 'old-docs', project: P.oldDocs },
      { address: 'claude:old-site', short_id: 'c1c1c1', state: 'closed', permission_mode: 'default', folder: 'old-site' },
      { address: 'codex:scratch', short_id: 'c2c2c2', state: 'closed', permission_mode: 'default', folder: 'scratch' },
    ],
    auto_mode_sessions: [],
    conversations: { pending: 1, active: 1, ended: 12 },
    queued_deliveries: 2,
    pending_approvals: [
      { approval_id: '01JAPPROVAL', kind: 'accept', participant: 'codex:trading-bot', peer: 'grok:researcher', topic: 'funding-rate summary', turn_limit: 10, expires_in_s: 540, expires_at: at(-540), conversation_id: '01JCONVPENDING' },
    ],
    live_connections: 4,
    notifications: [],
    conversation_list: [
      { id: '01JCONVPENDING', initiator: 'grok:researcher', invitee: 'codex:trading-bot', topic: 'funding-rate summary', state: 'pending', turn_count: 0, turn_limit: 10, origin: 'relay', queued: false, updated_at: at(60), created_at: at(60), ended_at: null, end_reason: null, approvals: [] },
      { id: '01JCONVACTIVE', initiator: 'claude:video-notes', invitee: 'grok:researcher', topic: 'b-roll ideas for this week', state: 'active', turn_count: 6, turn_limit: 30, origin: 'local', queued: false, updated_at: at(120), created_at: at(1500), ended_at: null, end_reason: null,
        approvals: [{ kind: 'start', via: 'prompt', agent: 'claude:video-notes', at: at(1490) }, { kind: 'accept', via: 'bot', agent: 'grok:researcher', at: at(1490) }] },
      { id: '01JCONVENDED', initiator: 'claude:agentbridge', invitee: 'claude:old-docs', topic: 'changelog wording', state: 'ended', turn_count: 4, turn_limit: 10, origin: 'local', queued: false, updated_at: at(2400), created_at: at(3000), ended_at: at(2400), end_reason: 'ended_by_participant',
        approvals: [{ kind: 'start', via: 'prompt', agent: 'claude:agentbridge', at: at(2990) }, { kind: 'accept', via: 'cli', agent: 'claude:old-docs', at: at(2900) }] },
    ],
    waiting_deliveries: [
      { participant: 'claude:landing', hold: 'unknown_mode', count: 2 },
      { participant: 'grok:researcher', hold: null, count: 1 },
    ],
    recent_notices: [
      { at: at(1800), title: 'agentbridge: session unreachable', body: 'claude:old-site does not accept cross-session messages' },
      { at: at(300), title: 'agentbridge: message waiting', body: 'claude:landing has a message; type anything in it to receive it' },
    ],
    relay: { configured: true, connected: true, mode: 'on_demand' },
    now: new Date(NOW).toISOString(),
  };
}
