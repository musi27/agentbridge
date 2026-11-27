// `agentbridge status --json` / `status --watch --json` (agent panel data contract, docs/status-json.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatusJson, changeKey, noPaths, STATUS_SCHEMA, type StatusSnapshot } from '../src/cli/status-json.ts';
import { runWatchJson } from '../src/cli/watch.ts';
import { main } from '../src/cli/main.ts';
import { projectKey, projectRoot } from '../src/core/project.ts';
import { IpcClient } from '../src/ipc/client.ts';
import { fixtureStatus, NOW } from './fixtures/panel-status.ts';
import { ipcHarness, cleanup, FakePlugin, hookEvent, inviteFacts, until } from './ipc-helpers.ts';

const snap = (s = fixtureStatus()): StatusSnapshot => buildStatusJson(s, { cliVersion: '0.2.3', nowMs: NOW });

test('status json: schema shape and stable ordering from a status snapshot', () => {
  const s = fixtureStatus();
  s.participants.push({ address: 'claude:agentbridge-2', title: 'docs pass', short_id: 'a9a9a9', state: 'live', permission_mode: 'dontAsk', folder: 'docs-pass', project: { key: projectKey('/home/dev/src/agentbridge'), label: 'agentbridge' } });
  s.pending_approvals.push({ approval_id: '01JAPPROVAL2', kind: 'start', participant: 'claude:agentbridge-2', peer: 'claude:landing', topic: 'copy review', turn_limit: 6, expires_in_s: 60, expires_at: new Date(NOW + 60_000).toISOString(), conversation_id: null });
  s.auto_mode_sessions = ['claude:video-notes'];
  const j = snap(s);
  assert.deepEqual(Object.keys(j), ['schema', 'kind', 'generated_at', 'bridge', 'warnings', 'needs_you', 'agents', 'closed_agents', 'conversations', 'notices']);
  assert.equal(j.schema, STATUS_SCHEMA); assert.equal(j.kind, 'snapshot'); assert.equal(j.generated_at, new Date(NOW).toISOString());
  assert.deepEqual(j.bridge, { running: true, version: '0.2.3', pid: 4182, started_at: s.started_at, cli_version: '0.2.3', version_mismatch: null, complete: true, policy: { ok: true, version: 7, mode: 'per_conversation' }, relay: { state: 'connected', mode: 'on_demand' } });
  assert.deepEqual(j.warnings, [{ code: 'auto_mode', agents: ['claude:video-notes'], text: 'Claude Code may not ask before shell commands in these sessions' }]);
  // needs_you: approvals (soonest expiry first), then held messages; deliveries in flight are not listed
  assert.deepEqual(j.needs_you.map((n) => (n.type === 'approval' ? n.approval_id : n.agent)), ['01JAPPROVAL2', '01JAPPROVAL', 'claude:landing']);
  assert.deepEqual(j.needs_you[1], { type: 'approval', approval_id: '01JAPPROVAL', kind: 'accept', from: 'grok:researcher', to: 'codex:trading-bot', topic: 'funding-rate summary', turn_limit: 10, expires_at: new Date(NOW + 540_000).toISOString(), conversation_id: '01JCONVPENDING', answer_in: 'codex:trading-bot', answer_with: 'prompt' });
  assert.equal(j.needs_you[0]!.type === 'approval' && j.needs_you[0]!.answer_with, 'cli'); // dontAsk session: agentbridge approve
  assert.deepEqual(j.needs_you[2], { type: 'held_messages', agent: 'claude:landing', hold: 'unknown_mode', count: 2, text: '2 messages held until someone types in it (waiting for first prompt)' });
  // agents: by project label, Grok bots (no project) last; a closed agent appears only because a listed conversation names it
  assert.deepEqual(j.agents.map((a) => a.address), ['claude:agentbridge', 'claude:agentbridge-2', 'claude:landing', 'claude:old-docs', 'codex:trading-bot', 'claude:video-notes', 'grok:researcher']);
  const by = Object.fromEntries(j.agents.map((a) => [a.address, a]));
  assert.deepEqual(by['claude:agentbridge'], { address: 'claude:agentbridge', app: 'claude', name: 'agentbridge', short_id: 'a1b2c3', title: 'status --watch', mode: 'default', state: 'live', activity: 'live', folder: 'agentbridge', project: { key: projectKey('/home/dev/src/agentbridge'), label: 'agentbridge' } });
  assert.equal(by['claude:agentbridge-2']!.project!.key, by['claude:agentbridge']!.project!.key);
  assert.equal(by['claude:landing']!.mode, null); assert.equal(by['claude:landing']!.activity, 'waiting_first_prompt');
  assert.equal(by['claude:old-docs']!.activity, 'closed');
  assert.equal(by['grok:researcher']!.project, null); assert.equal(by['grok:researcher']!.mode, null); assert.equal(by['grok:researcher']!.app, 'grok');
  assert.equal(j.closed_agents, 2);
  // conversations: most recent activity first, ended today included, approval provenance
  assert.deepEqual(j.conversations.map((c) => [c.id, c.state]), [['01JCONVPENDING', 'pending'], ['01JCONVACTIVE', 'active'], ['01JCONVENDED', 'ended']]);
  assert.deepEqual(j.conversations[2], {
    id: '01JCONVENDED', from: 'claude:agentbridge', to: 'claude:old-docs', topic: 'changelog wording', state: 'ended', end_reason: 'ended_by_participant',
    turns: { used: 4, limit: 10 }, origin: 'local', queued: false, started_at: new Date(NOW - 3_000_000).toISOString(), ended_at: new Date(NOW - 2_400_000).toISOString(), last_activity_at: new Date(NOW - 2_400_000).toISOString(),
    approvals: [{ kind: 'start', via: 'prompt', agent: 'claude:agentbridge', at: new Date(NOW - 2_990_000).toISOString() }, { kind: 'accept', via: 'cli', agent: 'claude:old-docs', at: new Date(NOW - 2_900_000).toISOString() }],
    turn_log: [],  // the snapshot came from a bridge without it
  });
  assert.match(j.notices[0]!.title, /message waiting/); // newest first
  // stable: the same state gives byte-identical output, whatever the input order
  const shuffled = fixtureStatus(); shuffled.participants.reverse(); shuffled.conversation_list!.reverse();
  assert.equal(changeKey(snap(shuffled)), changeKey(snap()));
});

test('noPaths: absolute paths in free text are cut to their last segment', () => {
  assert.equal(noPaths('/home/dev/src/shop'), '…/shop');
  assert.equal(noPaths('see "/a/b/c.ts" and (/x/y) or k=/p/q, ok'), 'see "…/c.ts" and (…/y) or k=…/q, ok');
  assert.equal(noPaths('on/off and 1/2 and /single'), 'on/off and 1/2 and /single');
});

test('status json: older bridge, tampered policy, agent-written escapes', () => {
  const old = fixtureStatus(); delete old.conversation_list; delete old.recent_notices; delete old.waiting_deliveries; delete old.relay; delete old.now;
  for (const p of old.participants) delete p.project;
  const o = snap(old);
  assert.equal(o.bridge.running && o.bridge.complete, false); assert.deepEqual(o.conversations, []);
  assert.ok(o.agents.every((a) => a.project === null));
  const t = fixtureStatus(); t.policy = { ok: false, reason: 'signature_mismatch' };
  const tj = snap(t);
  assert.deepEqual(tj.bridge.running && tj.bridge.policy, { ok: false, reason: 'signature_mismatch' });
  assert.equal(tj.warnings[0]!.code, 'policy_tampered');
  const e = fixtureStatus(); e.conversation_list![1]!.topic = 'hi\u001b[2J\u001b]0;owned\u0007 there'; e.participants[0]!.title = '\u001b[31mred';
  const ej = JSON.stringify(snap(e));
  assert.doesNotMatch(ej, /\\u001b|\\u0007/);
  assert.match(ej, /"topic":"hi there"/);
});

test('project root: worktrees of one repository share a key, a plain folder is its own, a submodule stays separate', () => {
  const root = realpathSync(mkdtempSync('/tmp/ab-proj-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const wt = join(root, 'elsewhere', 'repo-feature'); mkdirSync(join(wt, 'pkg'), { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
    const nested = join(repo, '.claude', 'worktrees', 'x'); mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, '.git', 'worktrees', 'x'), { recursive: true }); writeFileSync(join(repo, '.git', 'worktrees', 'x', 'commondir'), '../..');
    writeFileSync(join(nested, '.git'), 'gitdir: ../../../.git/worktrees/x\n'); // relative gitdir
    const sub = join(repo, 'vendor', 'lib'); mkdirSync(join(repo, '.git', 'modules', 'lib'), { recursive: true }); mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), `gitdir: ${join(repo, '.git', 'modules', 'lib')}\n`);
    const plain = join(root, 'notes'); mkdirSync(plain);
    assert.equal(projectRoot(repo), repo);
    assert.equal(projectRoot(join(repo, 'src', 'deep')), repo);
    assert.equal(projectRoot(join(wt, 'pkg')), repo);
    assert.equal(projectRoot(nested), repo);
    assert.equal(projectRoot(sub), sub);
    assert.equal(projectRoot(plain), plain);
    assert.equal(projectRoot(join(root, 'gone', 'away')), join(root, 'gone', 'away')); // a deleted folder: no throw
    // symlinked spelling of the same folder → same key
    const link = join(root, 'link'); spawnSync('ln', ['-s', repo, link]);
    assert.equal(projectRoot(join(link, 'src')), repo);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('project root: a real git worktree (skipped without git)', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) { t.skip('git not installed'); return; }
  const root = realpathSync(mkdtempSync('/tmp/ab-git-'));
  try {
    const repo = join(root, 'proj'); mkdirSync(repo);
    const git = (...a: string[]): void => { const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]); assert.equal(r.status, 0, String(r.stderr)); };
    git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'x'); git('worktree', 'add', '-q', join(root, 'proj-wt'), '-b', 'feature');
    assert.equal(projectRoot(join(root, 'proj-wt')), repo);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('watch json: one line per change, no duplicates, heartbeat, bridge down and back, stops when the reader goes away', async () => {
  const lines: string[] = []; let t = NOW; let calls = 0; let stop!: () => void;
  const stopped = new Promise<void>((r) => { stop = r; });
  const states = [fixtureStatus(), fixtureStatus(), fixtureStatus(), 'down', 'down', fixtureStatus(), fixtureStatus()] as Array<ReturnType<typeof fixtureStatus> | 'down'>;
  (states[2] as ReturnType<typeof fixtureStatus>).conversation_list![1]!.turn_count = 7; // a change
  const code = await runWatchJson({
    cliVersion: '0.2.3', stopped, heartbeatMs: 10_000, intervalMs: 1500, now: () => t,
    fetch: async () => { const s = states[calls++]!; if (s === 'down') throw new Error('agentbridge is not running'); return s; },
    write: (l) => { lines.push(l); },
    sleep: async () => { t += calls === 6 ? 20_000 : 1500; if (calls >= states.length) stop(); },
  });
  assert.equal(code, 0);
  assert.ok(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n') && !l.includes('\u001b')));
  const objs = lines.map((l) => JSON.parse(l) as { kind: string; bridge?: { running: boolean }; conversations?: Array<{ turns: { used: number } }> });
  // snapshot, (same: nothing), change, down, (down again: nothing), back (= a change), heartbeat after 20 s of no change
  assert.deepEqual(objs.map((o) => (o.kind === 'heartbeat' ? 'hb' : o.bridge!.running ? 'up' : 'down')), ['up', 'up', 'down', 'up', 'hb']);
  assert.equal(objs[1]!.conversations!.find((c) => c.turns.used === 7) !== undefined, true);
  // a write that fails (EPIPE) ends the stream cleanly
  let n = 0;
  assert.equal(await runWatchJson({ cliVersion: '0.2.3', stopped: new Promise(() => {}), fetch: async () => { const s = fixtureStatus(); s.pid = n++; return s; }, write: () => { throw new Error('EPIPE'); }, sleep: async () => {} }), 0);
  assert.equal(n, 1);
});

test('status --json without a bridge: one object that says so, non-zero exit, no human text', async () => {
  const home = mkdtempSync('/tmp/ab-nobridge-');
  try {
    const out: string[] = []; const err: string[] = [];
    assert.equal(await main(['status', '--json', '--home', home], (s) => out.push(s), (s) => err.push(s)), 1);
    const j = JSON.parse(out.join('\n')) as StatusSnapshot;
    assert.equal(j.bridge.running, false); assert.equal(j.schema, STATUS_SCHEMA);
    assert.deepEqual([j.needs_you, j.agents, j.conversations, j.notices], [[], [], [], []]);
    assert.deepEqual(err, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('status --json over ipc: projects by git root, approval provenance, and never a message body, token or secret', async () => {
  const h = await ipcHarness();
  const work = realpathSync(mkdtempSync('/tmp/ab-work-'));
  try {
    const repo = join(work, 'shop'); mkdirSync(join(repo, '.git', 'worktrees', 'feat'), { recursive: true }); mkdirSync(join(repo, 'web'));
    writeFileSync(join(repo, '.git', 'worktrees', 'feat', 'commondir'), '../..');
    const wt = join(work, 'shop-feat'); mkdirSync(wt); writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'feat')}`);
    const plain = join(work, 'scratch'); mkdirSync(plain);
    const BODY = 'CANARY-BODY-5e1f9 the first message text'; const REPLY = 'CANARY-REPLY-77ab second message';
    const a = await FakePlugin.connect(h, 100, { cwd: join(repo, 'web') });
    const b = await FakePlugin.connect(h, 200, { cwd: wt });
    const c = await FakePlugin.connect(h, 300, { cwd: plain });
    await hookEvent(h, { event: 'state', claude_pid: 100, session_id: 'sa', permission_mode: 'default', transcript_path: join(work, 'sa.jsonl') });
    await hookEvent(h, { event: 'state', claude_pid: 200, session_id: 'sb', permission_mode: 'default' });
    const r = await a.tool('bridge_start_conversation', { peer: 'claude:shop-feat', topic: 'checkout copy', first_message: BODY, turn_limit: 6 });
    assert.equal(r.status, 'pending_approval');
    await a.tool('bridge_confirm', r.approval);
    const invite = await b.waitPost(/approval_id=/);
    await b.tool('bridge_confirm', inviteFacts(invite));
    await b.waitPost(/CANARY-BODY-5e1f9/);
    const conv = h.svc.store.conversations()[0]!;
    assert.equal((await b.tool('bridge_send', { conversation_id: conv.id, body: REPLY })).status !== 'failed', true);
    await a.waitPost(/CANARY-REPLY-77ab/);
    // a second conversation: started from the prompt, then approved with `agentbridge approve` on the other side
    const r2 = await c.tool('bridge_start_conversation', { peer: 'claude:shop-feat', topic: 'notes', first_message: 'CANARY-BODY-second' });
    await c.tool('bridge_confirm', r2.approval);
    await until(() => h.svc.engine.pendingApprovals().some((x) => x.kind === 'accept'), 'accept approval');
    const acc = h.svc.engine.pendingApprovals().find((x) => x.kind === 'accept')!;
    assert.equal((await h.svc.engine.approveById(acc.approval_id)).status !== 'failed', true);

    // seeded absolute paths: a notice naming the repository, a topic quoting a file in it
    h.svc.store.insertEvent({ ts: Date.now(), level: 'warning', type: 'popup', participant_id: null, conversation_id: null, data: JSON.stringify({ title: `agentbridge: ${repo}`, body: `see ${join(repo, 'web', 'a.ts')} and "${wt}"` }), popup: 1 });
    await c.tool('bridge_start_conversation', { peer: 'claude:web', topic: `look at ${join(plain, 'notes.md')}`, first_message: 'x' });
    const out: string[] = [];
    assert.equal(await main(['status', '--json', '--home', h.root], (s) => out.push(s), () => {}), 0);
    const text = out.join('\n');
    // and the stream: first line of status --watch --json
    const cli = await IpcClient.open(h.svc.paths.socket, 'cli');
    const streamed: string[] = []; let stopStream!: () => void;
    await runWatchJson({ cliVersion: 'test', stopped: new Promise<void>((r) => { stopStream = r; }), fetch: () => cli.request('cli.status', { watch: true }), write: (l) => { streamed.push(l); stopStream(); }, sleep: async () => {} });
    cli.close();
    for (const [name, body] of [['--json', text], ['--watch --json', streamed.join('')]] as const) {
      for (const p of [work, repo, wt, plain, h.root, '/tmp/', '/private/']) assert.ok(!body.includes(p), `${name} leaked a path: ${p}`);
      assert.doesNotMatch(body, /"\/[A-Za-z]/, `${name}: a string starting with an absolute path`);
    }
    assert.match(text, /"topic": "look at …\/notes\.md"/);
    // no message text, ever; no session secret, tag nonce, inbox token or transcript path
    for (const secret of [BODY, REPLY, 'CANARY', a.reg.session_secret, b.reg.session_secret, a.nonce, b.nonce, 'sa.jsonl', 'inbox', 'token']) assert.ok(!text.includes(secret), `leaked ${secret}`);
    const j = JSON.parse(text) as StatusSnapshot;
    const by = Object.fromEntries(j.agents.map((x) => [x.address, x]));
    // keys are opaque hashes of the root: worktrees share one, a plain folder has its own, the DB keeps the real root
    assert.match(by['claude:web']!.project!.key, /^p_[0-9a-f]{16}$/);
    assert.deepEqual(by['claude:web']!.project, { key: projectKey(repo), label: 'shop' });
    assert.deepEqual(by['claude:shop-feat']!.project, { key: projectKey(repo), label: 'shop' });
    assert.deepEqual(by['claude:scratch']!.project, { key: projectKey(plain), label: 'scratch' });
    assert.notEqual(projectKey(repo), projectKey(plain));
    assert.equal(h.svc.store.participant(a.reg.participant_id)!.project_root, repo);
    const first = j.conversations.find((x) => x.topic === 'checkout copy')!;
    assert.deepEqual(first.approvals.map((x) => [x.kind, x.via, x.agent]), [['start', 'prompt', 'claude:web'], ['accept', 'prompt', 'claude:shop-feat']]);
    assert.deepEqual(first.turns, { used: 2, limit: 6 });
    // who took each turn and when, for the graph window's sequence view: no text
    assert.deepEqual(first.turn_log.map((t) => [t.turn, t.from]), [[1, 'claude:web'], [2, 'claude:shop-feat']]);
    for (const t of first.turn_log) { assert.deepEqual(Object.keys(t).sort(), ['at', 'from', 'turn']); assert.ok(!Number.isNaN(Date.parse(t.at))); }
    // a long conversation: only the last 50 turns are listed, and none of the bodies get in
    const seed = h.svc.store.messages(first.id).find((m) => m.turn === 2)!;
    for (let turn = 3; turn <= 60; turn++) {
      h.svc.store.insertMessage({ ...seed, id: `seeded-${turn}`, seq: 100 + turn, turn, body: `CANARY-BULK-${turn} long message text`, created_at: seed.created_at + turn * 1000 });
    }
    const outLong: string[] = [];
    await main(['status', '--json', '--home', h.root], (s) => outLong.push(s), () => {});
    const longText = outLong.join('\n');
    assert.ok(!longText.includes('CANARY'), 'turn_log leaked a message body');
    const long = (JSON.parse(longText) as StatusSnapshot).conversations.find((x) => x.id === first.id)!;
    assert.deepEqual([long.turn_log.length, long.turn_log[0]!.turn, long.turn_log.at(-1)!.turn], [50, 11, 60]);
    const second = j.conversations.find((x) => x.topic === 'notes')!;
    assert.deepEqual(second.approvals.map((x) => [x.kind, x.via, x.agent]), [['start', 'prompt', 'claude:scratch'], ['accept', 'cli', 'claude:shop-feat']]);
    // ended today stays listed, with its end time
    h.svc.engine.endManual(first.id);
    const out2: string[] = [];
    await main(['status', '--json', '--home', h.root], (s) => out2.push(s), () => {});
    const ended = (JSON.parse(out2.join('\n')) as StatusSnapshot).conversations.find((x) => x.id === first.id)!;
    assert.equal(ended.state, 'ended'); assert.ok(ended.ended_at); assert.equal(ended.approvals.length, 2);
    // the project is stored once at registration; a bridge restart backfills rows from before the column
    h.svc.store.updateParticipant(a.reg.participant_id, { project_root: null });
    a.close(); b.close(); c.close();
    const h2 = await h.restart();
    try { assert.equal(h2.svc.store.participant(a.reg.participant_id)!.project_root, repo); } finally { await h2.stop(); }
  } finally { await h.stop().catch(() => {}); cleanup(h); rmSync(work, { recursive: true, force: true }); }
});

const MAIN = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

/** Spawn `agentbridge status --watch --json` against the harness bridge; resolves its first stdout line. */
function spawnWatch(home: string): { child: ReturnType<typeof spawn>; first: Promise<string>; exit: Promise<{ code: number | null; signal: string | null; stderr: string }> } {
  const child = spawn(process.execPath, ['--conditions=agentbridge-source', MAIN, 'status', '--watch', '--json', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = ''; let stderr = '';
  child.stderr!.on('data', (d: Buffer) => { stderr += String(d); });
  const first = new Promise<string>((resolve, reject) => {
    const onData = (d: Buffer): void => { buf += String(d); const i = buf.indexOf('\n'); if (i >= 0) { child.stdout!.off('data', onData); resolve(buf.slice(0, i)); } };
    child.stdout!.on('data', onData); child.once('exit', () => reject(new Error(`exited before a line: ${stderr}`)));
  });
  const exit = new Promise<{ code: number | null; signal: string | null; stderr: string }>((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal, stderr })); });
  return { child, first, exit };
}

test('status --watch --json as a process: exits cleanly on SIGPIPE (reader closed) and on SIGINT', { timeout: 60_000 }, async () => {
  const h = await ipcHarness();
  try {
    const p1 = spawnWatch(h.root);
    assert.equal((JSON.parse(await p1.first) as StatusSnapshot).bridge.running, true);
    p1.child.stdout!.destroy(); // like `| head -1`
    // make the state change so the stream writes into the closed pipe
    h.svc.store.insertEvent({ ts: Date.now(), level: 'warning', type: 'popup', participant_id: null, conversation_id: null, data: JSON.stringify({ title: 'agentbridge: test', body: 'x' }), popup: 1 });
    const e1 = await p1.exit;
    assert.equal(e1.code, 0, e1.stderr); assert.equal(e1.stderr, '');

    const p2 = spawnWatch(h.root);
    await p2.first;
    p2.child.kill('SIGINT');
    const e2 = await p2.exit;
    assert.equal(e2.code, 0, e2.stderr); assert.equal(e2.stderr, '');
  } finally { await h.stop(); cleanup(h); }
});
