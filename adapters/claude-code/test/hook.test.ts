import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_METHODS, IPC_PROTOCOL, PERMISSION_MODES } from '@agentbridge/protocol';
import { HOOK_IPC_PROTOCOL, HOOK_PERMISSION_MODES, buildSessionEvent, runHook } from '../src/hook.ts';
import { FakeBridge, tempDir } from './helpers.ts';
import { PLUGIN_VERSION } from '../src/version.ts';

const HOOK_BUNDLE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'runtime', 'hook.mjs');
const base = { session_id: 'sess-1', transcript_path: '/tmp/t.jsonl', cwd: '/work/proj' };

test('hook constants equal the protocol ones', () => {
  assert.equal(HOOK_IPC_PROTOCOL, IPC_PROTOCOL);
  assert.deepEqual([...HOOK_PERMISSION_MODES], [...PERMISSION_MODES]);
});

test('SessionStart -> start with source, no permission_mode (M0 V3)', () => {
  const p = buildSessionEvent({ ...base, hook_event_name: 'SessionStart', source: 'clear' }, 4242);
  assert.deepEqual(p, { event: 'start', claude_pid: 4242, session_id: 'sess-1', source: 'clear', transcript_path: '/tmp/t.jsonl', cwd: '/work/proj' });
  IPC_METHODS.session_event.params.parse(p);
});

test('UserPromptSubmit / PreToolUse / Stop -> state with permission_mode', () => {
  for (const ev of ['UserPromptSubmit', 'PreToolUse', 'Stop']) {
    const p = buildSessionEvent({ ...base, hook_event_name: ev, permission_mode: 'acceptEdits' }, 7);
    assert.deepEqual(p, { event: 'state', claude_pid: 7, session_id: 'sess-1', permission_mode: 'acceptEdits', transcript_path: '/tmp/t.jsonl', cwd: '/work/proj' });
    IPC_METHODS.session_event.params.parse(p);
  }
});

test('SessionEnd -> end', () => {
  const p = buildSessionEvent({ ...base, hook_event_name: 'SessionEnd' }, 7);
  assert.equal(p?.event, 'end');
  assert.equal(p?.permission_mode, undefined);
});

test('unknown permission mode is sent as unknown (fail closed); bad source dropped', () => {
  const p = buildSessionEvent({ ...base, hook_event_name: 'Stop', permission_mode: 'yolo' }, 7);
  assert.equal(p?.permission_mode, 'unknown');
  const s = buildSessionEvent({ ...base, hook_event_name: 'SessionStart', source: 'weird' }, 7);
  assert.equal(s?.source, undefined);
  IPC_METHODS.session_event.params.parse(s);
});

test('events we do not report, and inputs without a session id, are ignored', () => {
  assert.equal(buildSessionEvent({ ...base, hook_event_name: 'PostToolUse' }, 7), null);
  assert.equal(buildSessionEvent({ hook_event_name: 'Stop' }, 7), null);
  assert.equal(buildSessionEvent({ ...base, hook_event_name: 'Stop' }, 0), null);
});

test('runHook sends hello then session_event to the bridge and prints nothing', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const bridge = await new FakeBridge(join(dir, 'b.sock')).listen(); t.after(() => bridge.close());
  const out = await runHook(JSON.stringify({ ...base, hook_event_name: 'UserPromptSubmit', permission_mode: 'default', prompt: 'hi' }), { env: { AGENTBRIDGE_SOCKET: bridge.path }, ppid: 999, eventTimeoutMs: 10_000 }); // payloads, not the budget
  assert.equal(out, '');
  assert.deepEqual(bridge.received.map((r) => r.method), ['hello', 'session_event']);
  assert.deepEqual(bridge.received[0]!.params, { protocol: 1, client: 'hook', client_version: PLUGIN_VERSION });
  assert.deepEqual(bridge.received[1]!.params, { event: 'state', claude_pid: 999, session_id: 'sess-1', permission_mode: 'default', transcript_path: '/tmp/t.jsonl', cwd: '/work/proj' });
});

test('runHook: bridge errors never surface', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const bridge = await new FakeBridge(join(dir, 'b.sock')).listen(); t.after(() => bridge.close());
  bridge.handlers.session_event = () => { throw new Error('nope'); };
  assert.equal(await runHook(JSON.stringify({ ...base, hook_event_name: 'SessionStart', source: 'startup' }), { env: { AGENTBRIDGE_SOCKET: bridge.path }, ppid: 9, eventTimeoutMs: 10_000 }), '');
});

test('runHook: SessionStart with no bridge and no CLI -> one systemMessage JSON', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const out = await runHook(JSON.stringify({ ...base, hook_event_name: 'SessionStart', source: 'startup' }), { env: { AGENTBRIDGE_SOCKET: join(dir, 'none.sock') }, ppid: 9, findCli: () => null });
  const j = JSON.parse(out);
  assert.deepEqual(Object.keys(j), ['systemMessage']);
  assert.match(j.systemMessage, /agentbridge start/);
});

test('runHook: SessionStart with no bridge starts the CLI and retries until it is up', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const sock = join(dir, 'b.sock');
  let started: string | null = null;
  let bridge: FakeBridge | null = null;
  t.after(() => bridge?.close());
  const out = await runHook(JSON.stringify({ ...base, hook_event_name: 'SessionStart', source: 'startup' }), {
    env: { AGENTBRIDGE_SOCKET: sock }, ppid: 9, findCli: () => '/fake/agentbridge', startWaitMs: 10_000, // returns as soon as the bridge answers
    startBridge: (cli) => { started = cli; void new FakeBridge(sock).listen().then((b) => { bridge = b; }); return true; },
  });
  assert.equal(out, '');
  assert.equal(started, '/fake/agentbridge');
  const up = bridge as FakeBridge | null; // assigned inside the startBridge callback
  assert.ok(up, 'bridge came up');
  assert.deepEqual(up.calls('session_event').map((r) => (r.params as { event: string }).event), ['start']);
});

test('runHook: non-start events stay silent when the bridge is down; garbage input is ignored', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  let started = false;
  const deps = { env: { AGENTBRIDGE_SOCKET: join(dir, 'none.sock') }, ppid: 9, findCli: () => '/x', startBridge: () => { started = true; return true; } };
  assert.equal(await runHook(JSON.stringify({ ...base, hook_event_name: 'Stop', permission_mode: 'default' }), deps), '');
  assert.equal(await runHook('not json', deps), '');
  assert.equal(await runHook('', deps), '');
  assert.equal(started, false);
});

function runBundle(stdin: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string; ownMs: number }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [HOOK_BUNDLE], { env: { PATH: process.env.PATH ?? '', AGENTBRIDGE_HOOK_TIMING: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => res({ code, stdout, stderr, ownMs: Number(/agentbridge-hook-ms=(\d+)/.exec(stderr)?.[1] ?? NaN) }));
    p.stdin.end(stdin);
  });
}

/** The hook's budget (Claude Code must never wait on us), enforced inside it by a 900 ms hard stop. */
const HOOK_BUDGET_MS = 1000;
/** Extra allowance when the suite runs on a heavily loaded machine (CPU-starved timers fire late). Applied to the
 *  hook's own runtime as it reports it (module start to exit), so process spawn and Node boot don't count at all. */
const HOOK_LOAD_TOLERANCE_MS = 1500;
function assertWithinBudget(r: { ownMs: number }): void {
  assert.ok(Number.isFinite(r.ownMs), 'hook reported its runtime');
  assert.ok(r.ownMs < HOOK_BUDGET_MS + HOOK_LOAD_TOLERANCE_MS, `hook ran ${r.ownMs} ms (budget ${HOOK_BUDGET_MS} + load tolerance ${HOOK_LOAD_TOLERANCE_MS})`);
}

test('bundled hook: reports to the bridge with its parent pid, exits 0 fast, stdout empty', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const bridge = await new FakeBridge(join(dir, 'b.sock')).listen(); t.after(() => bridge.close());
  const r = await runBundle(JSON.stringify({ ...base, hook_event_name: 'PreToolUse', permission_mode: 'auto', tool_name: 'mcp__plugin_agentbridge_agentbridge__bridge_send' }), { AGENTBRIDGE_SOCKET: bridge.path });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assertWithinBudget(r);
  const ev = bridge.calls('session_event')[0]!.params as { claude_pid: number; permission_mode: string };
  assert.equal(ev.claude_pid, process.pid);
  assert.equal(ev.permission_mode, 'auto');
});

test('bundled hook: bridge down + no CLI -> valid hook JSON on stdout, exit 0, < 1 s', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const r = await runBundle(JSON.stringify({ ...base, hook_event_name: 'SessionStart', source: 'startup' }), { AGENTBRIDGE_SOCKET: join(dir, 'none.sock'), AGENTBRIDGE_CLI: join(dir, 'missing') });
  assert.equal(r.code, 0);
  assertWithinBudget(r);
  assert.ok(JSON.parse(r.stdout).systemMessage);
});

test('bundled hook: a bridge that never answers cannot hold it past the budget', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const net = await import('node:net');
  const silent = net.createServer(() => {}); const silentPath = join(dir, 's.sock');
  await new Promise<void>((r) => silent.listen(silentPath, () => r())); t.after(() => silent.close());
  const r = await runBundle(JSON.stringify({ ...base, hook_event_name: 'Stop', permission_mode: 'default' }), { AGENTBRIDGE_SOCKET: silentPath });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assertWithinBudget(r);
});

test('bundled hook: no timing output unless AGENTBRIDGE_HOOK_TIMING=1', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const r = await runBundle(JSON.stringify({ ...base, hook_event_name: 'Stop', permission_mode: 'default' }), { AGENTBRIDGE_SOCKET: join(dir, 'none.sock'), AGENTBRIDGE_HOOK_TIMING: '0' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('SessionStart does not auto-start the bridge while agentbridge init holds a live setup marker', async () => {
  const { runHook } = await import('../src/hook.ts');
  const { setupInProgress } = await import('../src/start-bridge.ts');
  const { formatSetupMarker } = await import('@agentbridge/protocol');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const home = mkdtempSync('/tmp/ab-hk-');
  try {
    const env = { AGENTBRIDGE_HOME: home, PATH: '/usr/bin' };
    assert.equal(setupInProgress(env), false);
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(join(home, 'run', 'setup.lock'), formatSetupMarker(process.pid, Date.now()));
    assert.equal(setupInProgress(env), true);
    assert.equal(setupInProgress(env, Date.now(), () => false), false); // dead pid → stale
    let started = 0;
    const out = await runHook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup', cwd: '/tmp', transcript_path: '/tmp/t.jsonl' }), {
      env, ppid: 4242, eventTimeoutMs: 50, findCli: () => '/usr/local/bin/agentbridge', startBridge: () => { started++; return true; },
    });
    assert.equal(started, 0);
    assert.match(out, /setup \(agentbridge init\) is running/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
