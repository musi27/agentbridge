// Made-up `agentbridge status --json` snapshots (docs/status-json.md, schema 1) for the agent panel tests and design
// checks: a small setup (5 agents) and a big one (50 agents in three projects plus Grok bots). Deterministic.
// Write them out with: node packages/presence/test/fixtures/panel-snapshots.ts <dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOW = '2026-11-24T10:31:00.000Z';
const at = (minAgo: number): string => new Date(Date.parse(NOW) - minAgo * 60_000).toISOString();
const inMin = (min: number): string => new Date(Date.parse(NOW) + min * 60_000).toISOString();

type Activity = 'live' | 'in_conversation' | 'approval' | 'waiting_first_prompt' | 'unreachable' | 'closed';
interface AgentSpec { app: 'claude' | 'codex' | 'grok'; name: string; project: string | null; activity: Activity }

const KEYS: Record<string, string> = { harbor: 'p_1a2b3c4d5e6f7a8b', ledgerly: 'p_2b3c4d5e6f7a8b9c', trailmap: 'p_3c4d5e6f7a8b9c0d' };

function agent(s: AgentSpec, i: number): Record<string, unknown> {
  return {
    address: `${s.app}:${s.name}`, app: s.app, name: s.name, short_id: `a${String(i).padStart(5, '0')}`, title: null,
    mode: s.app === 'grok' ? null : s.activity === 'waiting_first_prompt' ? null : 'default',
    state: s.activity === 'closed' ? 'closed' : s.activity === 'unreachable' ? 'unreachable' : 'live', activity: s.activity,
    folder: s.project ? s.name.split(' ')[0] : null, project: s.project ? { key: KEYS[s.project], label: s.project } : null,
  };
}

function bridge(): Record<string, unknown> {
  return {
    running: true, version: '0.2.9', pid: 4182, started_at: at(60), cli_version: '0.2.9', version_mismatch: null, complete: true,
    policy: { ok: true, version: 7, mode: 'per_conversation' }, relay: { state: 'connected', mode: 'on_demand' },
  };
}

const ap = (kind: string, via: string, agentAddr: string, minAgo: number, extra: Record<string, unknown> = {}) => ({ kind, via, agent: agentAddr, at: at(minAgo), ...extra });

function conv(id: string, from: string, to: string, topic: string, used: number, limit: number, lastMin: number, approvals: unknown[], ended?: { reason: string; min: number }) {
  return {
    id, from, to, topic, state: ended ? 'ended' : 'active', end_reason: ended?.reason ?? null, turns: { used, limit }, origin: 'local', queued: false,
    started_at: at(lastMin + 30), ended_at: ended ? at(ended.min) : null, last_activity_at: at(ended?.min ?? lastMin), approvals,
  };
}

/** 5 agents, one conversation, nothing waiting. */
export function small(): Record<string, unknown> {
  const specs: AgentSpec[] = [
    { app: 'claude', name: 'harbor', project: 'harbor', activity: 'in_conversation' },
    { app: 'claude', name: 'harbor docs', project: 'harbor', activity: 'live' },
    { app: 'claude', name: 'ledgerly', project: 'ledgerly', activity: 'live' },
    { app: 'codex', name: 'ledgerly', project: 'ledgerly', activity: 'live' },
    { app: 'grok', name: 'researcher', project: null, activity: 'in_conversation' },
  ];
  return {
    schema: 1, kind: 'snapshot', generated_at: NOW, bridge: bridge(), warnings: [], needs_you: [],
    agents: specs.map(agent), closed_agents: 0,
    conversations: [conv('01JSMALL1', 'claude:harbor', 'grok:researcher', 'competitor pricing pages', 5, 30, 4, [ap('start', 'prompt', 'claude:harbor', 30), ap('accept', 'bot', 'grok:researcher', 30)])],
    notices: [],
  };
}

/** 50 agents in harbor (18), trailmap (14), ledgerly (14) and 4 projectless Grok bots; 6 live conversations, 3 ended. */
export function big(): Record<string, unknown> {
  const specs: AgentSpec[] = [];
  const add = (app: AgentSpec['app'], project: string | null, names: string[], acts: Activity[]) => names.forEach((n, i) => specs.push({ app, name: n, project, activity: acts[i] ?? 'live' }));
  add('claude', 'harbor', ['harbor', 'harbor-2', 'harbor feat/billing', 'harbor fix/login', 'harbor feat/search', 'harbor docs', 'harbor chore/deps', 'harbor feat/onboarding', 'harbor perf', 'harbor-3', 'harbor feat/emails', 'harbor spike/ai'],
    ['in_conversation', 'in_conversation', 'in_conversation', 'in_conversation', 'live', 'live', 'live', 'live', 'live', 'closed', 'live', 'closed']);
  add('codex', 'harbor', ['harbor', 'harbor-2', 'harbor feat/billing', 'harbor refactor/db', 'harbor test', 'harbor lint'], ['in_conversation', 'live', 'in_conversation', 'live', 'live', 'unreachable']);
  add('claude', 'ledgerly', ['ledgerly', 'ledgerly-2', 'ledgerly feat/import', 'ledgerly fix/rounding', 'ledgerly feat/reports', 'ledgerly docs', 'ledgerly feat/export', 'ledgerly spike/ocr'], ['live', 'live', 'live', 'live', 'closed', 'live', 'live', 'closed']);
  add('codex', 'ledgerly', ['ledgerly', 'ledgerly-2', 'ledgerly feat/import', 'ledgerly fix/fx', 'ledgerly perf', 'ledgerly test'], ['in_conversation', 'live', 'live', 'live', 'closed', 'live']);
  add('claude', 'trailmap', ['trailmap', 'trailmap feat/maps', 'trailmap fix/gps', 'trailmap feat/offline', 'trailmap-2', 'trailmap docs', 'trailmap feat/routes', 'trailmap ui'], ['in_conversation', 'waiting_first_prompt', 'live', 'live', 'live', 'closed', 'live', 'live']);
  add('codex', 'trailmap', ['trailmap', 'trailmap-2', 'trailmap feat/offline', 'trailmap test', 'trailmap perf', 'trailmap lint'], ['approval', 'live', 'live', 'live', 'closed', 'live']);
  add('grok', null, ['researcher', 'reviewer', 'scout', 'writer'], ['in_conversation', 'in_conversation', 'live', 'live']);
  const sorted = [...specs].sort((a, b) => (a.project === null ? 1 : 0) - (b.project === null ? 1 : 0) || (a.project ?? '').localeCompare(b.project ?? '') || `${a.app}:${a.name}`.localeCompare(`${b.app}:${b.name}`));
  return {
    schema: 1, kind: 'snapshot', generated_at: NOW, bridge: bridge(),
    warnings: [{ code: 'auto_mode', agents: ['claude:harbor perf'], text: 'Claude Code may not ask before shell commands in these sessions' }],
    needs_you: [
      { type: 'approval', approval_id: '01JAPPROVAL1', kind: 'accept', from: 'grok:scout', to: 'codex:trailmap', topic: 'app-store keyword trends', turn_limit: 4, expires_at: inMin(7), conversation_id: '01JCONVPEND', answer_in: 'codex:trailmap', answer_with: 'prompt' },
      { type: 'held_messages', agent: 'claude:trailmap feat/maps', hold: 'unknown_mode', count: 1, text: '1 message held until someone types in it (waiting for first prompt)' },
    ],
    agents: sorted.map(agent), closed_agents: 7,
    conversations: [
      conv('01JC1', 'claude:harbor fix/login', 'codex:harbor', 'flaky login test', 9, 16, 2, [ap('start', 'prompt', 'claude:harbor fix/login', 96), ap('accept', 'prompt', 'codex:harbor', 95)]),
      conv('01JC2', 'claude:harbor feat/billing', 'grok:researcher', 'EU VAT rules for invoices', 12, 30, 1, [ap('start', 'prompt', 'claude:harbor feat/billing', 79), ap('accept', 'bot', 'grok:researcher', 79)]),
      conv('01JC3', 'claude:trailmap', 'grok:reviewer', 'review offline sync PR', 7, 20, 3, [ap('start', 'allow_rule', 'claude:trailmap', 61), ap('accept', 'bot', 'grok:reviewer', 61)]),
      conv('01JC4', 'claude:harbor-2', 'grok:researcher', 'competitor pricing pages', 5, 30, 4, [ap('start', 'prompt', 'claude:harbor-2', 43), ap('accept', 'bot', 'grok:researcher', 43)]),
      conv('01JC5', 'codex:harbor feat/billing', 'grok:reviewer', 'review billing migration', 2, 10, 6, [ap('start', 'prompt', 'codex:harbor feat/billing', 11), ap('accept', 'bot', 'grok:reviewer', 11)]),
      conv('01JC6', 'claude:harbor', 'codex:ledgerly', 'shared auth client API', 3, 12, 9, [ap('start', 'prompt', 'claude:harbor', 26), ap('accept', 'cli', 'codex:ledgerly', 25), ap('extend', 'prompt', 'claude:harbor', 12, { turn_limit: 12 })]),
      conv('01JE1', 'claude:ledgerly', 'grok:researcher', 'FX rate sources', 8, 8, 29, [ap('start', 'prompt', 'claude:ledgerly', 60), ap('accept', 'bot', 'grok:researcher', 60)], { reason: 'turn_limit', min: 29 }),
      conv('01JE2', 'codex:trailmap-2', 'claude:trailmap', 'GPS fixture format', 2, 2, 136, [ap('start', 'prompt', 'codex:trailmap-2', 160), ap('accept', 'prompt', 'claude:trailmap', 159)], { reason: 'turn_limit', min: 136 }),
      conv('01JE3', 'claude:harbor-3', 'grok:reviewer', 'onboarding copy', 4, 20, 161, [], { reason: 'ended_by_participant', min: 161 }),
    ],
    notices: [{ at: at(4), title: 'agentbridge: message waiting', body: 'claude:trailmap feat/maps has a message; type anything in it to receive it' }],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? '.';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'panel-5.json'), `${JSON.stringify(small(), null, 2)}\n`);
  writeFileSync(join(dir, 'panel-50.json'), `${JSON.stringify(big(), null, 2)}\n`);
  writeFileSync(join(dir, 'panel-down.json'), `${JSON.stringify({ schema: 1, kind: 'snapshot', generated_at: NOW, bridge: { running: false, error: 'agentbridge is not running (start it with: agentbridge start)', cli_version: '0.2.9' }, warnings: [], needs_you: [], agents: [], closed_agents: 0, conversations: [], notices: [] }, null, 2)}\n`);
  writeFileSync(join(dir, 'panel-schema2.json'), `${JSON.stringify({ ...small(), schema: 2 }, null, 2)}\n`);
  console.log(`wrote panel-5.json, panel-50.json, panel-down.json, panel-schema2.json to ${dir}`);
}
