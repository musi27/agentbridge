// Fake `cli.status {watch: true}` answer for the agent panel tests and the PR capture. All names are made up.
import type { WatchStatus } from '../../src/cli/panel.ts';

export const NOW = Date.parse('2026-11-24T14:32:10Z');
const at = (agoS: number): string => new Date(NOW - agoS * 1000).toISOString();

export function fixtureStatus(): WatchStatus {
  return {
    bridge_version: '0.2.3', pid: 4182, started_at: at(3600),
    policy: { ok: true, version: 7, mode: 'per_conversation' },
    participants: [
      { address: 'claude:agentbridge', title: 'status --watch', short_id: 'a1b2c3', state: 'live', permission_mode: 'default', folder: 'agentbridge' },
      { address: 'claude:video-notes', title: 'b-roll ideas', short_id: 'd4e5f6', state: 'live', permission_mode: 'acceptEdits', folder: 'video-notes' },
      { address: 'claude:landing', short_id: 'aa11bb', state: 'live', permission_mode: 'unknown', folder: 'landing' },
      { address: 'codex:trading-bot', short_id: '778899', state: 'live', permission_mode: 'default', folder: 'trading-bot' },
      { address: 'grok:researcher', short_id: 'g00001', state: 'live', permission_mode: 'default' },
      { address: 'claude:old-docs', short_id: 'c0c0c0', state: 'closed', permission_mode: 'unknown', folder: 'old-docs' },
      { address: 'claude:old-site', short_id: 'c1c1c1', state: 'closed', permission_mode: 'default', folder: 'old-site' },
      { address: 'codex:scratch', short_id: 'c2c2c2', state: 'closed', permission_mode: 'default', folder: 'scratch' },
    ],
    auto_mode_sessions: [],
    conversations: { pending: 1, active: 1, ended: 12 },
    queued_deliveries: 2,
    pending_approvals: [
      { approval_id: '01JAPPROVAL', kind: 'accept', participant: 'codex:trading-bot', peer: 'grok:researcher', topic: 'funding-rate summary', turn_limit: 10, expires_in_s: 540 },
    ],
    live_connections: 4,
    notifications: [],
    conversation_list: [
      { id: '01JCONVPENDING', initiator: 'grok:researcher', invitee: 'codex:trading-bot', topic: 'funding-rate summary', state: 'pending', turn_count: 0, turn_limit: 10, origin: 'relay', queued: false, updated_at: at(60) },
      { id: '01JCONVACTIVE', initiator: 'claude:video-notes', invitee: 'grok:researcher', topic: 'b-roll ideas for this week', state: 'active', turn_count: 6, turn_limit: 30, origin: 'local', queued: false, updated_at: at(120) },
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
