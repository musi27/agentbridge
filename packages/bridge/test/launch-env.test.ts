// launchd paths (§14.1): stable node, recorded claude, plist PATH; doctor's plist program checks. Fake bins in temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPlist } from '@agentbridge/presence';
import { resolveLaunchPaths, isVersionedPath, claudeVersionRunner, launchdProgramChecks, plistProgram, CLAUDE_BIN_ENV } from '../src/init/launch-env.ts';
import { runInit } from '../src/init/init.ts';

function fakeBin(dir: string, name: string, out = `${name} 1.0.0`): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name); writeFileSync(p, `#!/bin/sh\necho "${out}"\n`); chmodSync(p, 0o755); return p;
}

test('launch paths: stable node over the versioned Cellar path; claude from ~/.local/bin; PATH holds both', () => {
  const t = mkdtempSync('/tmp/ab-lp-');
  try {
    const cellar = join(t, 'opt', 'homebrew', 'Cellar', 'node', '25.9.0_2', 'bin'); const brewBin = join(t, 'opt', 'homebrew', 'bin');
    const real = fakeBin(cellar, 'node'); mkdirSync(brewBin, { recursive: true }); symlinkSync(real, join(brewBin, 'node'));
    const home = join(t, 'home'); const claude = fakeBin(join(home, '.local', 'bin'), 'claude', '2.1.340 (Claude Code)');
    // the CLI ran with the versioned path first on PATH (as Homebrew's node re-execs) and without ~/.local/bin
    const lp = resolveLaunchPaths({ pathVar: `${cellar}:/usr/bin`, home, execPath: real, fixed: [brewBin] });
    assert.equal(lp.nodePath, join(brewBin, 'node')); // not realpath'd, not the Cellar path
    assert.equal(lp.nodeVersioned, false);
    assert.equal(lp.claudePath, claude);
    assert.equal(lp.environment[CLAUDE_BIN_ENV], claude);
    const dirs = lp.path.split(':');
    assert.ok(dirs.includes(brewBin) && dirs.includes(join(home, '.local', 'bin')) && dirs.includes('/usr/bin'));
    assert.equal(new Set(dirs).size, dirs.length);
    // only a versioned node available → flagged
    const only = resolveLaunchPaths({ pathVar: cellar, home: join(t, 'nohome'), execPath: real, fixed: [] });
    assert.equal(only.nodePath, real); assert.equal(only.nodeVersioned, true); assert.equal(only.claudePath, null);
    assert.ok(isVersionedPath('/Users/a/.nvm/versions/node/v24.1.0/bin/node'));
    assert.ok(!isVersionedPath('/opt/homebrew/bin/node')); assert.ok(!isVersionedPath('/usr/local/bin/node'));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('doctor runs the recorded claude path first (launchd PATH lacks ~/.local/bin)', async () => {
  const t = mkdtempSync('/tmp/ab-lp-');
  try {
    const claude = fakeBin(join(t, 'local'), 'claude', '2.1.340 (Claude Code)');
    assert.match(await claudeVersionRunner({ PATH: '/usr/bin:/bin', [CLAUDE_BIN_ENV]: claude })(), /2\.1\.340/);
    await assert.rejects(claudeVersionRunner({ PATH: '/usr/bin:/bin' })()); // no record, not on PATH
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('doctor: plist program exists and runs; missing (upgraded) node or versioned node is reported', async () => {
  const t = mkdtempSync('/tmp/ab-lp-');
  try {
    const node = fakeBin(join(t, 'bin'), 'node', 'v25.9.0'); const entry = join(t, 'service-main.mjs'); writeFileSync(entry, '');
    const plist = join(t, 'live.musi.agentbridge.plist');
    const write = (n: string): void => writeFileSync(plist, renderPlist({ label: 'live.musi.agentbridge', programArguments: [n, entry], stdoutPath: '/tmp/o', stderrPath: '/tmp/e' }));
    assert.deepEqual(await launchdProgramChecks(join(t, 'none.plist')), []);
    write(node);
    assert.deepEqual(plistProgram(plist), [node, entry]);
    const ok = await launchdProgramChecks(plist);
    assert.deepEqual(ok.map((c) => [c.id, c.ok]), [['launchd_program', true]]);
    write(join(t, 'Cellar', 'node', '25.9.0_2', 'bin', 'node')); // deleted by `brew upgrade node`
    const gone = await launchdProgramChecks(plist);
    assert.equal(gone[0]!.ok, false); assert.match(gone[0]!.detail, /no longer exists/); assert.match(gone[0]!.fix!, /agentbridge init/);
    const cellarNode = fakeBin(join(t, 'Cellar', 'node', '25.9.0_2', 'bin'), 'node', 'v25.9.0');
    write(cellarNode);
    const versioned = await launchdProgramChecks(plist);
    assert.deepEqual(versioned.map((c) => [c.id, c.ok]), [['launchd_program', true], ['launchd_node_stable', false]]);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('init installs the plist with the stable node and the claude PATH/env, warns on a versioned node, re-runs replace it', async () => {
  const installs: Array<{ nodePath: string; environment: Record<string, string> }> = [];
  const lines: string[] = [];
  let versioned = false;
  const { MemorySecretStore } = await import('../src/policy/integrity.ts');
  const { ScriptedPresence } = await import('./helpers.ts');
  const { DEFAULT_POLICY } = await import('../src/policy/policy.ts');
  let pol = structuredClone(DEFAULT_POLICY);
  const deps = {
    claude: async (a: string[]) => ({ code: 0, stdout: a[0] === '--version' ? '2.1.340 (Claude Code)' : 'ok', stderr: '' }),
    secrets: new MemorySecretStore(), presence: new ScriptedPresence(),
    policy: async () => ({ get: async () => pol, set: async (k: string, v: string) => { const { applySetting } = await import('../src/policy/policy.ts'); pol = applySetting(pol, k, v); } }),
    service: { status: async () => 'not_installed' as const, install: async (o: { nodePath: string; environment: Record<string, string> }) => { installs.push(o); }, stopManaged: async () => {}, startManaged: async () => {}, plistMatches: async () => false, job: async () => null, kickstart: async () => {} },
      lockPid: () => null,
    startBridge: async () => {}, stopForeignBridge: async () => false, marker: { write: () => {}, remove: () => {} },
    bridgeRunning: async () => installs.length > 0, stopBridge: async () => {}, waitForBridge: async () => true,
    doctor: async () => [], lock: () => () => {}, fetch: (async () => new Response('{}', { status: 500 })) as typeof fetch,
    prompt: { choose: async <T extends string>(_q: string, _o: unknown, d: T) => d }, print: (l: string) => lines.push(l),
    marketplace: null, claudeSettingsPath: join(mkdtempSync('/tmp/ab-lp-'), 'settings.json'), home: '/nonexistent-home',
    settings: { env: { HOME: '/nonexistent-home', CLAUDE_CONFIG_DIR: '/nonexistent-home/.claude' }, managedDir: '/nonexistent-managed' },
    service_entry: { entry: '/pkg/dist/service-main.mjs', logDir: '/tmp/ab-logs' },
    launchPaths: () => ({ nodePath: versioned ? '/opt/homebrew/Cellar/node/25.9.0_2/bin/node' : '/opt/homebrew/bin/node', nodeVersioned: versioned, claudePath: '/Users/x/.local/bin/claude', path: '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin', environment: { PATH: '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin', AGENTBRIDGE_CLAUDE_BIN: '/Users/x/.local/bin/claude' } }),
  };
  const r1 = await runInit(deps, { yes: true, skipPlugin: true, skipRelay: true });
  assert.equal(installs[0]!.nodePath, '/opt/homebrew/bin/node');
  assert.equal(installs[0]!.environment['AGENTBRIDGE_CLAUDE_BIN'], '/Users/x/.local/bin/claude');
  assert.match(installs[0]!.environment['PATH']!, /\.local\/bin/);
  assert.ok(!r1.steps.some((s) => s.id === 'service_node'));
  versioned = true;
  const r2 = await runInit(deps, { yes: true, skipPlugin: true, skipRelay: true });
  assert.equal(installs.length, 2); // re-run installs again (presence's install replaces the plist)
  const warn = r2.steps.find((s) => s.id === 'service_node')!;
  assert.equal(warn.ok, false); assert.match(warn.detail, /versioned/);
});

test('launchctl print parsing and the doctor owner check', async () => {
  const { parseLaunchctlJob, ownerCheck } = await import('../src/init/launch-env.ts');
  assert.deepEqual(parseLaunchctlJob('gui/501/live.musi.agentbridge = {\n\tstate = running\n\tpid = 4242\n}'), { state: 'running', pid: 4242 });
  assert.deepEqual(parseLaunchctlJob('\tstate = spawn scheduled\n'), { state: 'spawn scheduled', pid: null });
  assert.equal(ownerCheck({ jobState: null, jobPid: null, lockPid: 5 }), null); // agent not loaded: the status check covers it
  const manual = ownerCheck({ jobState: 'spawn scheduled', jobPid: null, lockPid: 5151 })!;
  assert.equal(manual.ok, false);
  assert.match(manual.detail, /^a manually started bridge is running instead of the launchd agent — run agentbridge init \(manual bridge pid 5151; launchd job: spawn scheduled\)$/);
  assert.deepEqual(ownerCheck({ jobState: 'running', jobPid: 4242, lockPid: 4242 }), { id: 'launchd_owner', ok: true, detail: 'the launchd agent runs the bridge (pid 4242)' });
});
