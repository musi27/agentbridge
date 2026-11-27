// The agent panel's graph window (step B), without any UI: `AgentBridge panel --print-model --graph` prints the
// layout the window draws (B1 bubbles, B2 arc list, merged lines), and `--print-model` carries each conversation's
// B3 sequence. `--render-png --window` draws the window off-screen. Fixtures: 5 and 50 agents.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/exec.ts';
import { ensureHelper } from './helpers.ts';
import { big, NOW, small } from './fixtures/panel-snapshots.ts';

let helper = '';
let skip: string | false = false;
before(() => { const h = ensureHelper(); if ('skip' in h) skip = h.skip; else helper = h.path; });

interface Node { id: string; kind: string; label: string; sub: string; mix?: string; apps?: Array<{ app: string; count: number }>; group: string; state?: string; x: number; y: number; r: number; w: number; h: number }
interface Box { id: string; label: string; count: number; x: number; y: number; w: number; h: number }
interface Edge { id: string; a: string; b: string; conversations: string[]; live: number; pending: number; inside: boolean; label: string; direction: string; waiting: number; recent: number; detail: string }
interface Graph { group_by: string; layout: string; auto: boolean; visible_nodes: number; threshold: number; expanded: string[]; width: number; height: number; nodes: Node[]; boxes: Box[]; edges: Edge[]; movable: boolean; origin_x: number; origin_y: number }
interface Seq { kind: string; side: string; label: string; time?: string; human: boolean }
interface Conv { id: string; from: string; to: string; sequence: Seq[]; waiting: boolean; age?: string; recent_turns: number }

const HARBOR = 'project:p_1a2b3c4d5e6f7a8b', LEDGERLY = 'project:p_2b3c4d5e6f7a8b9c', TRAILMAP = 'project:p_3c4d5e6f7a8b9c0d', NONE = 'project:none';

async function helperJSON<T>(snapshot: unknown, args: string[]): Promise<T> {
  const r = await run(helper, ['panel', '--print-model', '--now', NOW, ...args], { input: JSON.stringify(snapshot), timeoutMs: 10_000, env: { PATH: '/usr/bin:/bin', TZ: 'UTC' } });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout) as T;
}
const graph = (snapshot: unknown, args: string[] = []) => helperJSON<Graph>(snapshot, ['--graph', ...args]);
const convs = async (snapshot: unknown) => { const m = await helperJSON<{ live: Conv[]; ended: Conv[] }>(snapshot, []); return [...m.live, ...m.ended]; };

/** Every node inside the canvas; every edge between drawn nodes. */
function sane(g: Graph): void {
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.equal(ids.size, g.nodes.length, 'node ids are unique');
  for (const n of g.nodes) {
    const hw = n.w > 0 ? n.w / 2 : n.r, hh = n.h > 0 ? n.h / 2 : n.r;
    assert.ok(n.x - hw >= 0 && n.x + hw <= g.width && n.y - hh >= 0 && n.y + hh <= g.height, `${n.id} inside the canvas`);
  }
  for (const e of g.edges) assert.ok(ids.has(e.a) && ids.has(e.b), `${e.id} joins drawn nodes`);
}

test('50 agents by project: four closed groups as bubbles, lines merged with counts', async (t) => {
  if (skip) return t.skip(skip);
  const g = await graph(big());
  sane(g);
  assert.deepEqual([g.layout, g.auto, g.visible_nodes, g.threshold, g.expanded], ['bubbles', true, 4, 12, []]);
  assert.deepEqual(g.nodes.map((n) => [n.label, n.kind, n.sub, n.mix]), [
    ['harbor', 'group', '18 agents', 'C12 · X6'], ['ledgerly', 'group', '14 agents', 'C8 · X6'],
    ['trailmap', 'group', '14 agents', 'C8 · X6'], ['Bots & no project', 'group', '4 agents', 'G4'],
  ]);
  const byPair = Object.fromEntries(g.edges.map((e) => [e.id, [e.label, e.live, e.pending, e.inside]]));
  assert.deepEqual(byPair, {
    [`${HARBOR}|${HARBOR}`]: ['1', 1, 0, true],                      // codex:harbor ↔ claude:harbor fix/login
    [`${NONE}|${HARBOR}`]: ['3 conversations', 3, 0, false],          // three harbor sessions with Grok bots
    [`${NONE}|${TRAILMAP}`]: ['1 + invite', 1, 1, false],             // review + grok:scout's pending invitation
    [`${HARBOR}|${LEDGERLY}`]: ['1', 1, 0, false],
  });
  // closed groups are donut chips: each app with its count, sized to fit, never overlapping
  assert.deepEqual(g.nodes[0]!.apps, [{ app: 'claude', count: 12 }, { app: 'codex', count: 6 }]);
  for (const n of g.nodes) assert.ok(n.w >= 110 && (n.h === 36 || n.h === 52), `${n.label} chip size`);
  assert.ok(g.nodes.find((n) => n.label === 'Bots & no project')!.w > g.nodes.find((n) => n.label === 'ledgerly')!.w - 30, 'a longer name gets a wider chip');
  for (const a of g.nodes) for (const b of g.nodes) {
    if (a.id < b.id) assert.ok(Math.abs(a.x - b.x) > (a.w + b.w) / 2 + 8 || Math.abs(a.y - b.y) > (a.h + b.h) / 2 + 8, `${a.label} and ${b.label} apart`);
  }
});

test('50 agents by app, Claude Code open: its talking agents as dots in a box, idle ones folded into +N', async (t) => {
  if (skip) return t.skip(skip);
  const g = await graph(big(), ['--group-by', 'app', '--expand', 'app:claude']);
  sane(g);
  assert.deepEqual([g.group_by, g.layout, g.visible_nodes, g.expanded], ['app', 'bubbles', 9, ['app:claude']]);
  const box = g.boxes.find((b) => b.id === 'app:claude')!;
  assert.deepEqual([box.label, box.count], ['Claude Code', 28]);
  const inBox = g.nodes.filter((n) => n.group === 'app:claude');
  assert.deepEqual(inBox.map((n) => n.label), ['trailmap feat/maps', 'harbor', 'harbor feat/billing', 'harbor fix/login', 'harbor-2', 'trailmap', '+22']);
  assert.equal(inBox.at(-1)!.sub, '17 idle · 5 closed');
  for (const n of inBox) assert.ok(n.x > box.x && n.x < box.x + box.w && n.y > box.y && n.y < box.y + box.h, `${n.label} in its box`);
  // lines now end at the agents; the other apps stay single circles
  assert.ok(g.edges.some((e) => e.id === 'app:codex|claude:harbor' && e.label === '1'));
  assert.ok(g.edges.some((e) => e.id === 'app:grok|claude:harbor feat/billing'));
  assert.deepEqual(g.edges.find((e) => e.id === 'app:codex|app:grok')!.label, '1 + invite');
});

test('more than 12 visible nodes switch to the arc list; picking a layout overrides the count', async (t) => {
  if (skip) return t.skip(skip);
  const g = await graph(big(), ['--group-by', 'app', '--expand', 'app:claude,app:codex']);
  sane(g);
  assert.deepEqual([g.layout, g.auto, g.visible_nodes], ['list', true, 13]);
  // one row per node, top to bottom, nothing overlapping; the open groups' headers are rows too
  const rows = [...g.nodes].sort((a, b) => a.y - b.y);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i]!.y - rows[i - 1]!.y >= rows[i]!.r + rows[i - 1]!.r, `${rows[i]!.label} below ${rows[i - 1]!.label}`);
  assert.deepEqual(g.boxes.map((b) => b.label), ['Claude Code', 'Codex']);
  assert.ok(g.nodes.every((n) => n.x === g.nodes[0]!.x), 'every row starts at the arc gutter');

  assert.equal((await graph(big(), ['--group-by', 'app', '--expand', 'app:claude,app:codex', '--layout', 'bubbles'])).layout, 'bubbles');
  const list = await graph(big(), ['--layout', 'list']);
  assert.deepEqual([list.layout, list.auto, list.visible_nodes], ['list', false, 4]);
  sane(list);
});

test('5 agents: every group opens by itself; --expand none and --show-all', async (t) => {
  if (skip) return t.skip(skip);
  const g = await graph(small());
  sane(g);
  assert.deepEqual([g.layout, g.visible_nodes, g.expanded], ['bubbles', 4, [HARBOR, LEDGERLY, NONE]]);
  assert.deepEqual(g.nodes.map((n) => [n.label, n.kind]), [['harbor', 'agent'], ['+1', 'more'], ['+2', 'more'], ['researcher', 'agent']]);
  assert.deepEqual(g.edges.map((e) => [e.id, e.label]), [['claude:harbor|grok:researcher', '1']]);
  // boxes side by side, not overlapping
  const [a, b, c] = g.boxes;
  assert.ok(a!.x + a!.w <= b!.x && b!.x + b!.w <= c!.x);

  const closed = await graph(small(), ['--expand', 'none']);
  assert.deepEqual([closed.visible_nodes, closed.nodes.map((n) => n.kind)], [3, ['group', 'group', 'group']]);
  const all = await graph(small(), ['--show-all', LEDGERLY]);
  assert.deepEqual(all.nodes.filter((n) => n.group === LEDGERLY).map((n) => n.id), ['claude:ledgerly', 'codex:ledgerly']);
});

test('richer lines: direction, turns and age, waiting on you, recent turns', async (t) => {
  if (skip) return t.skip(skip);
  const g = await graph(small());
  assert.deepEqual(g.edges.map((e) => [e.direction, e.waiting, e.recent, e.detail]), [['ab', 0, 0, '5/30 turns · 4m']]);

  // a "more turns" approval for that conversation, and a turn log: one turn 2 minutes ago, one 20 minutes ago
  const snap = small() as { needs_you: unknown[]; conversations: Array<Record<string, unknown>> };
  const ago = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
  snap.needs_you = [{ type: 'approval', approval_id: '01JAPPEXT', kind: 'extend', from: 'claude:harbor', to: 'grok:researcher', topic: 'competitor pricing pages', turn_limit: 40, expires_at: ago(-5), conversation_id: '01JSMALL1', answer_in: 'claude:harbor', answer_with: 'prompt' }];
  snap.conversations[0]!.turn_log = [{ turn: 4, from: 'grok:researcher', at: ago(20) }, { turn: 5, from: 'claude:harbor', at: ago(2) }];
  const w = await graph(snap);
  assert.deepEqual(w.edges.map((e) => [e.waiting, e.recent, e.detail]), [[1, 1, 'waiting on you · 4m']]);
  const c = (await convs(snap)).find((x) => x.id === '01JSMALL1')!;
  assert.deepEqual([c.waiting, c.age, c.recent_turns], [true, '4m', 1]);
});

test('moved chips: a saved spot overrides the ring, the canvas takes it in, the rest stay put', async (t) => {
  if (skip) return t.skip(skip);
  const g = await graph(big());
  assert.equal(g.movable, true);
  const at = (x: Graph, id: string) => x.nodes.find((n) => n.id === id)!;
  // the ring as given: each chip's ring coordinates are x - origin_x, y - origin_y
  const ledgerly = at(g, LEDGERLY);
  const ring = [ledgerly.x - g.origin_x, ledgerly.y - g.origin_y];
  const moved = await graph(big(), ['--positions', JSON.stringify({ [HARBOR]: [ring[0]! + 400, ring[1]!] })]);
  sane(moved);
  const h = at(moved, HARBOR);
  assert.deepEqual([Math.round(h.x - moved.origin_x), Math.round(h.y - moved.origin_y)], [Math.round(ring[0]! + 400), Math.round(ring[1]!)]);
  assert.ok(moved.width > g.width, 'the canvas grows to take the moved chip in');
  const l = at(moved, LEDGERLY);
  assert.deepEqual([Math.round(l.x - moved.origin_x), Math.round(l.y - moved.origin_y)], ring.map(Math.round), 'unmoved chips keep their ring spot');
  // an opened group is not the ring: nothing to move
  assert.equal((await graph(small())).movable, false);
});

test('filter: only matching groups and agents, opened', async (t) => {
  if (skip) return t.skip(skip);
  const g = await graph(big(), ['--filter', 'trail']);
  sane(g);
  assert.deepEqual(g.expanded, [TRAILMAP]);
  assert.ok(g.nodes.every((n) => n.group === TRAILMAP));
  // conversations to agents filtered out are not drawn
  assert.deepEqual(g.edges, []);
});

test('B3 sequence: approvals and turns over time, never message text', async (t) => {
  if (skip) return t.skip(skip);
  const cs = await convs(big());
  const auth = cs.find((c) => c.id === '01JC6')!;
  assert.deepEqual(auth.sequence.map((e) => [e.kind, e.side, e.label, e.time ?? null, e.human]), [
    ['approval', 'from', '✓ Started: you, in harbor\'s prompt', '10:05', true],
    ['approval', 'to', '✓ Accepted: you, agentbridge approve for codex:ledgerly', '10:06', true],
    ['turns', 'both', '3 turns · 09:52–10:22', null, false],       // no turn log from this bridge: one aggregated row
    ['approval', 'from', '✓ Extended to 12 turns: you, in harbor\'s prompt', '10:19', true],
  ]);
  const review = cs.find((c) => c.id === '01JC3')!;
  assert.deepEqual(review.sequence.slice(0, 2).map((e) => [e.label, e.human]), [['Started: an allow rule (trailmap)', false], ['Accepted: grok:reviewer by itself', false]]);
  assert.deepEqual(cs.find((c) => c.id === '01JE1')!.sequence.at(-1), { kind: 'end', side: 'both', label: 'Ended · turn limit', time: '10:02', human: false });
  assert.equal(cs.find((c) => c.id === '01JCONVPEND')!.sequence.at(-1)!.label, 'Waiting for codex:trailmap to accept');
  assert.deepEqual(cs.find((c) => c.id === '01JE3')!.sequence.map((e) => e.kind), ['turns', 'end']);
});

test('B3 sequence with a turn log: one arrow per turn from whoever took it, older turns counted', async (t) => {
  if (skip) return t.skip(skip);
  const s = small() as { conversations: Array<Record<string, unknown>> };
  const at = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
  // 5 turns used, the log keeps the last 3
  s.conversations[0]!['turn_log'] = [
    { turn: 3, from: 'claude:harbor', at: at(10) }, { turn: 4, from: 'grok:researcher', at: at(8) }, { turn: 5, from: 'claude:harbor', at: at(4) },
  ];
  const c = (await convs(s))[0]!;
  assert.deepEqual(c.sequence.map((e) => [e.kind, e.side, e.label]), [
    ['approval', 'from', '✓ Started: you, in harbor\'s prompt'],
    ['approval', 'to', 'Accepted: grok:researcher by itself'],
    ['turns', 'both', '2 earlier turns'],
    ['turn', 'from', 'turn 3'], ['turn', 'to', 'turn 4'], ['turn', 'from', 'turn 5'],
  ]);
  assert.deepEqual(c.sequence.filter((e) => e.kind === 'turn').map((e) => e.time), ['10:21', '10:23', '10:27']);
});

test('render the window off-screen: bubbles, list and a sequence, light and dark', async (t) => {
  if (skip) return t.skip(skip);
  const dir = mkdtempSync(join(tmpdir(), 'ab-graph-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'p5.json'), JSON.stringify(small()));
  writeFileSync(join(dir, 'p50.json'), JSON.stringify(big()));
  const cases: Array<[string, string[]]> = [
    ['p5.json', []],
    ['p50.json', ['--select', `edge:${NONE}|${HARBOR}`]],
    ['p50.json', ['--group-by', 'app', '--expand', 'app:claude,app:codex', '--select', 'conv:01JC6', '--dark']],
  ];
  for (const [i, [file, extra]] of cases.entries()) {
    const out = join(dir, `w${i}.png`);
    const r = await run(helper, ['panel', '--render-png', out, '--snapshot-file', join(dir, file), '--window', '--size', '900x560', ...extra], { timeoutMs: 20_000, env: { PATH: '/usr/bin:/bin', TZ: 'UTC' } });
    assert.equal(r.code, 0, r.stderr);
    const png = readFileSync(out);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.ok(png.readUInt32BE(16) >= 900 && png.readUInt32BE(20) >= 560, 'at least the asked size (2x on Retina)');
  }
});
