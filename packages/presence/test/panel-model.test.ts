// The agent panel's Swift view model, without any UI: `AgentBridge panel --print-model` reads a `status --json`
// snapshot on stdin and prints the grouped, sorted model the dropdown draws. Fixtures: 5 and 50 agents.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/exec.ts';
import { ensureHelper } from './helpers.ts';
import { big, NOW, small } from './fixtures/panel-snapshots.ts';

let helper = '';
let skip: string | false = false;
before(() => { const h = ensureHelper(); if ('skip' in h) skip = h.skip; else helper = h.path; });

interface Row { address: string; name: string; badge: string; state: string; tag?: string; project?: string }
interface Group { id: string; label: string; count: number; collapsed: boolean; bar: Record<string, number>; agents: Row[] }
interface Model {
  status: string; message?: string; icon_count: number; agent_count: number; closed_agents: number; show_search: boolean;
  status_short: string; status_long: string; warnings: string[]; incomplete: boolean;
  needs_you: Array<{ kind: string; verb: string; target: string; meta: string; context: string; copy: string; copy_label: string; detail: string }>;
  live: Array<{ topic: string; pair: string; turns: string; mark: string; approvals: string[] }>;
  ended: Array<{ topic: string; ended: string }>;
  by_project: Group[]; by_app: Group[];
}

async function model(snapshot: unknown, extra: string[] = []): Promise<Model> {
  const input = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot);
  // TZ fixes the HH:mm in approval and end times
  const r = await run(helper, ['panel', '--print-model', '--now', NOW, ...extra], { input, timeoutMs: 10_000, env: { PATH: '/usr/bin:/bin', TZ: 'UTC' } });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout) as Model;
}

test('50 agents: needs-you lines, icon count, search, status line', async (t) => {
  if (skip) return t.skip(skip);
  const m = await model(big());
  assert.equal(m.status, 'ok');
  assert.equal(m.icon_count, 2);
  assert.equal(m.agent_count, 43);            // 50 listed, 7 of them closed
  assert.equal(m.show_search, true);
  assert.equal(m.status_short, '0.2.9 · relay ok · policy v7');
  assert.match(m.status_long, /policy v7, per conversation/);
  assert.deepEqual(m.needs_you.map((n) => [n.verb, n.target, n.meta, n.copy]), [
    ['Answer in', 'codex:trailmap', '7 min', 'codex:trailmap'],
    ['Type in', 'trailmap feat/maps', '1 held', 'claude:trailmap feat/maps'],
  ]);
  assert.match(m.needs_you[0]!.detail, /grok:scout invites codex:trailmap · “app-store keyword trends” · 4 turns/);
  // the short grey second line: what it's about
  assert.deepEqual(m.needs_you.map((n) => n.context), ['“app-store keyword trends” · from grok:scout', '1 message waiting for its first prompt']);
  assert.deepEqual(m.warnings, ['Claude Code may not ask before shell commands in these sessions: harbor perf']);
});

test('50 agents: conversations are topic first, with who approved, how and when', async (t) => {
  if (skip) return t.skip(skip);
  const m = await model(big());
  assert.equal(m.live.length, 7);            // 6 active + grok:scout's pending invitation
  assert.equal(m.ended.length, 3);
  const vat = m.live.find((c) => c.topic === 'EU VAT rules for invoices')!;
  assert.deepEqual([vat.pair, vat.turns, vat.mark], ['harbor feat/billing ↔ grok:researcher', '12/30', '✓']);
  assert.deepEqual(vat.approvals, ['Started: you, in harbor feat/billing\'s prompt · 09:12', 'Accepted: grok:researcher by itself · 09:12']);
  assert.equal(m.live.find((c) => c.topic === 'review offline sync PR')!.mark, 'rule');
  const auth = m.live.find((c) => c.topic === 'shared auth client API')!;
  assert.deepEqual(auth.approvals.map((a) => a.split(':')[0]), ['Started', 'Accepted', 'Extended to 12 turns']);
  assert.match(auth.approvals[1]!, /you, agentbridge approve for codex:ledgerly/);
  assert.deepEqual(m.ended.map((e) => e.ended), ['10:02 · turn limit', '08:15 · turn limit', '07:50 · ended by an agent']);
});

test('50 agents: grouped by project and by app, active agents first, state bars add up', async (t) => {
  if (skip) return t.skip(skip);
  const m = await model(big());
  assert.deepEqual(m.by_project.map((g) => [g.label, g.count]), [['harbor', 18], ['ledgerly', 14], ['trailmap', 14], ['Bots & no project', 4]]);
  assert.deepEqual(m.by_app.map((g) => [g.label, g.count]), [['Claude Code', 28], ['Codex', 18], ['Grok', 4]]);
  for (const g of [...m.by_project, ...m.by_app]) {
    const sum = Object.values(g.bar).reduce((a, b) => a + b, 0);
    assert.equal(sum, g.count, g.label);
    // order: needs you, talking, working, idle, closed
    const rank = { needs_you: 0, talking: 1, working: 2, idle: 3, closed: 4 } as Record<string, number>;
    const ranks = g.agents.map((a) => rank[a.state]!);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), g.label);
  }
  const trail = m.by_project.find((g) => g.label === 'trailmap')!;
  assert.equal(trail.bar['needs_you'], 2);   // the invited Codex session + the session with a held message
  assert.deepEqual(trail.agents.slice(0, 2).map((a) => [a.name, a.badge, a.tag]), [['trailmap feat/maps', 'C', '1st prompt'], ['trailmap', 'X', 'invited']]);
  assert.equal(m.by_project.find((g) => g.label === 'harbor')!.collapsed, false);
});

test('filter: matches addresses and project names; matching groups expand', async (t) => {
  if (skip) return t.skip(skip);
  const m = await model(big(), ['--filter', 'trail']);
  assert.deepEqual(m.by_project.map((g) => [g.label, g.count, g.collapsed]), [['trailmap', 14, false]]);
  const codex = await model(big(), ['--filter', 'codex:']);
  assert.deepEqual(codex.by_app.map((g) => g.label), ['Codex']);
});

test('5 agents: no search field, idle groups start collapsed, nothing needs you', async (t) => {
  if (skip) return t.skip(skip);
  const m = await model(small());
  assert.equal(m.show_search, false);
  assert.equal(m.icon_count, 0);
  assert.deepEqual(m.needs_you, []);
  assert.deepEqual(m.by_project.map((g) => [g.label, g.collapsed]), [['harbor', false], ['ledgerly', true], ['Bots & no project', false]]);
});

test('bridge down, newer schema, an old bridge, and a --watch capture', async (t) => {
  if (skip) return t.skip(skip);
  const down = await model({ schema: 1, kind: 'snapshot', bridge: { running: false, error: 'agentbridge is not running (start it with: agentbridge start)', cli_version: '0.2.9' }, warnings: [], needs_you: [], agents: [], closed_agents: 0, conversations: [], notices: [] });
  assert.deepEqual([down.status, down.message, down.icon_count], ['bridge_down', 'agentbridge is not running (start it with: agentbridge start)', 0]);
  const newer = await model({ ...small(), schema: 2 });
  assert.equal(newer.status, 'update_needed');
  assert.match(newer.message!, /Update agentbridge/);
  const old = await model({ ...small(), bridge: { ...(small()['bridge'] as object), complete: false } });
  assert.equal(old.incomplete, true);
  // a `status --watch --json` capture: the last snapshot wins, heartbeats and unknown fields are ignored
  const lines = [JSON.stringify(small()), JSON.stringify({ ...big(), future_field: { x: 1 } }), JSON.stringify({ schema: 1, kind: 'heartbeat', generated_at: NOW })].join('\n');
  assert.equal((await model(lines)).agent_count, 43);
});

test('agent-written text is passed through as plain text (no markup interpretation)', async (t) => {
  if (skip) return t.skip(skip);
  const s = small() as { conversations: Array<Record<string, unknown>> };
  s.conversations[0]!['topic'] = '<b>bold</b> **not markdown** [link](https://example.com)';
  const m = await model(s);
  assert.equal(m.live[0]!.topic, '<b>bold</b> **not markdown** [link](https://example.com)');
});

test('panel options never reach the one-request subcommands: version and the arg-count guard are unchanged', async (t) => {
  if (skip) return t.skip(skip);
  const v = await run(helper, ['version'], { input: '{}', timeoutMs: 10_000 });
  assert.deepEqual([v.code, JSON.parse(v.stdout)], [0, { ok: true, protocol: 1, version: '0.1.0' }]);
  const extra = await run(helper, ['version', '--print-model'], { input: '{}', timeoutMs: 10_000 });
  assert.equal(extra.code, 2);
  assert.match(extra.stdout, /usage: AgentBridge <subcommand>/);
  const noInput = await run(helper, ['panel', '--print-model'], { input: '', timeoutMs: 10_000 });
  assert.equal(noInput.code, 2);
});

test('an agent asked only for more turns is tagged "more turns?", not "invited"', async (t) => {
  if (skip) return t.skip(skip);
  type Snap = { needs_you: Array<Record<string, unknown>>; agents: Array<Record<string, unknown>> };
  const tagOf = (m: Model, address: string) => m.by_project.flatMap((g) => g.agents).find((a) => a.address === address)!;
  const later = new Date(Date.parse(NOW) + 5 * 60_000).toISOString();
  const extend = { type: 'approval', approval_id: '01JAPPEXT', kind: 'extend', from: 'claude:harbor', to: 'grok:researcher', topic: 'competitor pricing pages', turn_limit: 40, expires_at: later, conversation_id: '01JSMALL1', answer_in: 'claude:harbor', answer_with: 'prompt' };
  // the bridge reports both invites and extends as activity "approval" for the agent asked
  const snap = small() as Snap;
  snap.agents.find((a) => a['address'] === 'claude:harbor')!['activity'] = 'approval';
  snap.needs_you = [extend];
  const m = await model(snap);
  assert.deepEqual([tagOf(m, 'claude:harbor').state, tagOf(m, 'claude:harbor').tag], ['needs_you', 'more turns?']);
  assert.equal(m.needs_you[0]!.context.startsWith('more turns (to 40)'), true);

  // an invite waiting on the same agent as well: "invited" wins (it's the one that needs a yes to start)
  snap.needs_you = [extend, { ...extend, approval_id: '01JAPPINV', kind: 'accept', from: 'codex:ledgerly', to: 'claude:harbor', conversation_id: '01JINV', topic: 'shared auth client' }];
  assert.equal(tagOf(await model(snap), 'claude:harbor').tag, 'invited');
});
