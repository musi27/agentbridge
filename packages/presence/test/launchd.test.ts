import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPlist, xmlEscape, parseLaunchctlPrint, LaunchdServiceManager, LAUNCHD_LABEL } from '../src/launchd.ts';
import { PanelAgent, PANEL_LABEL, panelProgramArguments } from '../src/panel.ts';
import type { Runner, RunResult } from '../src/exec.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'ab-launchd-'));
const res = (code: number, stdout = '', stderr = ''): RunResult => ({ code, signal: null, stdout, stderr, timedOut: false });

test('xmlEscape escapes markup and rejects XML-illegal characters', () => {
  assert.equal(xmlEscape(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
  assert.throws(() => xmlEscape('a\u0000b'), TypeError);
  assert.throws(() => xmlEscape('a\u001bb'), TypeError);
});

test('renderPlist is a valid plist with the expected keys (plutil)', (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only');
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const weird = '/Users/x/My <Apps> & "stuff"/node';
  const xml = renderPlist({
    label: LAUNCHD_LABEL,
    programArguments: [weird, '/opt/agentbridge/dist/bridge.js'],
    stdoutPath: '/Users/x/.agentbridge/logs/bridge.out.log',
    stderrPath: '/Users/x/.agentbridge/logs/bridge.err.log',
    environment: { AGENTBRIDGE_HOME: "/Users/x/it's here" },
  });
  const f = join(dir, 'p.plist');
  writeFileSync(f, xml);
  execFileSync('/usr/bin/plutil', ['-lint', '-s', f]);
  const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8' }));
  assert.deepEqual(parsed, {
    Label: 'live.musi.agentbridge',
    ProgramArguments: [weird, '/opt/agentbridge/dist/bridge.js'],
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 10,
    ProcessType: 'Interactive',
    StandardOutPath: '/Users/x/.agentbridge/logs/bridge.out.log',
    StandardErrorPath: '/Users/x/.agentbridge/logs/bridge.err.log',
    EnvironmentVariables: { AGENTBRIDGE_HOME: "/Users/x/it's here" },
  });
});

test('parseLaunchctlPrint', () => {
  assert.equal(parseLaunchctlPrint('gui/501/live.musi.agentbridge = {\n\tactive count = 1\n\tstate = running\n\tpid = 123\n}'), 'running');
  assert.equal(parseLaunchctlPrint('gui/501/live.musi.agentbridge = {\n\tstate = not running\n\tlast exit code = 1\n}'), 'stopped');
  assert.equal(parseLaunchctlPrint('\tjob state = running\n'), 'stopped');
});

function fakeLaunchctl(script: (args: readonly string[]) => RunResult) {
  const calls: (readonly string[])[] = [];
  const runner: Runner = async (file, args) => { assert.equal(file, '/bin/launchctl'); calls.push(args); return script(args); };
  return { calls, runner };
}

test('install writes the plist (0644) and log dir, boots out any old job, then bootstraps', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeLaunchctl((a) => (a[0] === 'bootout' ? res(3, '', 'Boot-out failed: 3: No such process') : res(0)));
  const m = new LaunchdServiceManager({ launchAgentsDir: join(dir, 'LaunchAgents'), uid: 501, runner: fake.runner });
  assert.equal(await m.status(), 'not_installed');
  const logDir = join(dir, 'logs');
  await m.install({ nodePath: '/usr/local/bin/node', entry: '/opt/ab/bridge.js', logDir });
  assert.equal(m.plistPath, join(dir, 'LaunchAgents', 'live.musi.agentbridge.plist'));
  assert.equal(statSync(m.plistPath).mode & 0o777, 0o644);
  assert.equal(statSync(logDir).mode & 0o777, 0o700);
  const xml = readFileSync(m.plistPath, 'utf8');
  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>\n {4}<string>\/opt\/ab\/bridge.js<\/string>/);
  assert.ok(xml.includes(`<key>StandardErrorPath</key><string>${join(logDir, 'bridge.err.log')}</string>`));
  assert.ok(xml.includes('<key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>'));
  assert.ok(xml.includes('<key>AGENTBRIDGE_LAUNCHD</key><string>1</string>'));
  assert.deepEqual(fake.calls, [
    ['bootout', 'gui/501/live.musi.agentbridge'],
    ['bootstrap', 'gui/501', m.plistPath],
  ]);
});

test('install retries bootstrap while the old instance is being torn down, then fails loudly', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const flaky = fakeLaunchctl((a) => (a[0] === 'bootstrap' && n++ < 2 ? res(5, '', 'Bootstrap failed: 5: Input/output error') : res(0)));
  const m = new LaunchdServiceManager({ launchAgentsDir: dir, uid: 501, runner: flaky.runner, retryDelayMs: 1 });
  await m.install({ nodePath: '/n', entry: '/e', logDir: join(dir, 'l') });
  assert.equal(flaky.calls.filter((c) => c[0] === 'bootstrap').length, 3);

  const broken = fakeLaunchctl((a) => (a[0] === 'bootstrap' ? res(122, '', 'Bootstrap failed: 122: Path had bad ownership/permissions') : res(0)));
  const m2 = new LaunchdServiceManager({ launchAgentsDir: dir, uid: 501, runner: broken.runner, retryDelayMs: 1 });
  await assert.rejects(m2.install({ nodePath: '/n', entry: '/e', logDir: join(dir, 'l') }), /bad ownership/);
  assert.equal(broken.calls.filter((c) => c[0] === 'bootstrap').length, 1);
});

test('bootout: only 3 / 113 mean "not loaded"; any other failure is an error (uninstall keeps the plist)', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const code of [3, 113]) {
    const m = new LaunchdServiceManager({ launchAgentsDir: dir, uid: 501, runner: fakeLaunchctl(() => res(code)).runner });
    writeFileSync(m.plistPath, 'x');
    await m.uninstall();
    assert.ok(!existsSync(m.plistPath));
  }
  const failing = fakeLaunchctl((a) => (a[0] === 'bootout' ? res(5, '', 'Boot-out failed: 5: Input/output error') : res(0)));
  const m = new LaunchdServiceManager({ launchAgentsDir: dir, uid: 501, runner: failing.runner });
  writeFileSync(m.plistPath, 'x');
  await assert.rejects(m.uninstall(), /bootout .* failed \(exit 5\)/);
  assert.ok(existsSync(m.plistPath));
  await assert.rejects(m.install({ nodePath: '/n', entry: '/e', logDir: join(dir, 'l') }), /exit 5/);
  assert.ok(!failing.calls.some((c) => c[0] === 'bootstrap'));
});

test('install rejects relative paths', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = new LaunchdServiceManager({ launchAgentsDir: dir, uid: 501, runner: fakeLaunchctl(() => res(0)).runner });
  await assert.rejects(m.install({ nodePath: 'node', entry: '/e', logDir: '/l' }), /nodePath must be an absolute path/);
});

test('status: running / stopped (loaded but not running) / stopped (not loaded); uninstall removes the plist', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let printOut = res(0, 'state = running\n');
  const fake = fakeLaunchctl((a) => (a[0] === 'print' ? printOut : res(0)));
  const m = new LaunchdServiceManager({ launchAgentsDir: dir, uid: 501, label: 'live.musi.agentbridge.test', runner: fake.runner });
  await m.install({ nodePath: '/n', entry: '/e', logDir: join(dir, 'l') });
  assert.equal(await m.status(), 'running');
  printOut = res(0, '\tstate = not running\n');
  assert.equal(await m.status(), 'stopped');
  printOut = res(113, '', 'Could not find service "live.musi.agentbridge.test" in domain for user gui: 501');
  assert.equal(await m.status(), 'stopped');
  assert.deepEqual(fake.calls.at(-1), ['print', 'gui/501/live.musi.agentbridge.test']);
  await m.uninstall();
  assert.ok(!existsSync(m.plistPath));
  assert.deepEqual(fake.calls.at(-1), ['bootout', 'gui/501/live.musi.agentbridge.test']);
  assert.equal(await m.status(), 'not_installed');
  await m.uninstall(); // idempotent
});

test('label is validated', () => {
  assert.throws(() => new LaunchdServiceManager({ label: '../evil', uid: 1 }), TypeError);
});

test('PanelAgent: its own label and plist, runs AgentBridge panel with node + CLI entry, logs panel.*.log, bridge env not inherited', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only (plutil)');
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeLaunchctl((a) => (a[0] === 'bootout' ? res(3) : res(0)));
  const a = new PanelAgent({ launchAgentsDir: join(dir, 'LaunchAgents'), uid: 501, runner: fake.runner });
  assert.equal(a.plistPath, join(dir, 'LaunchAgents', 'live.musi.agentbridge.panel.plist'));
  const logDir = join(dir, 'logs');
  await a.install({ helperPath: '/pkg/bin/AgentBridge.app/Contents/MacOS/AgentBridge', nodePath: '/opt/homebrew/bin/node', cliEntry: '/pkg/dist/cli.mjs', home: '/tmp/ab home' }, logDir);
  const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', a.plistPath], { encoding: 'utf8' }));
  assert.deepEqual(parsed, {
    Label: PANEL_LABEL,
    ProgramArguments: ['/pkg/bin/AgentBridge.app/Contents/MacOS/AgentBridge', 'panel', '--home', '/tmp/ab home', '--', '/opt/homebrew/bin/node', '/pkg/dist/cli.mjs'],
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },   // "Quit until next login" exits 0 and stays quit; a crash restarts
    ThrottleInterval: 10,
    ProcessType: 'Interactive',
    StandardOutPath: join(logDir, 'panel.out.log'),
    StandardErrorPath: join(logDir, 'panel.err.log'),
    EnvironmentVariables: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  assert.deepEqual(fake.calls, [['bootout', `gui/501/${PANEL_LABEL}`], ['bootstrap', 'gui/501', a.plistPath]]);
  assert.deepEqual(panelProgramArguments({ helperPath: '/h', nodePath: '/n', cliEntry: '/c' }), ['/h', 'panel', '--', '/n', '/c']);
});

test('PanelAgent.uninstall deletes the plist before the bootout (the panel may be the process asking)', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let plistAtBootout: boolean | null = null;
  const a = new PanelAgent({ launchAgentsDir: dir, uid: 501, runner: async (_f, args) => { if (args[0] === 'bootout') plistAtBootout = existsSync(a.plistPath); return res(0); } });
  writeFileSync(a.plistPath, 'x');
  await a.uninstall();
  assert.equal(plistAtBootout, false);
  assert.ok(!existsSync(a.plistPath));
  // the bridge's own manager keeps bootout-then-delete (a failed bootout leaves the plist in place)
  let bridgePlistAtBootout: boolean | null = null;
  const m = new LaunchdServiceManager({ launchAgentsDir: dir, uid: 501, runner: async (_f, args) => { if (args[0] === 'bootout') bridgePlistAtBootout = existsSync(m.plistPath); return res(0); } });
  writeFileSync(m.plistPath, 'x');
  await m.uninstall();
  assert.equal(bridgePlistAtBootout, true);
});

test('installProgram validates its log name and log dir', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = new LaunchdServiceManager({ launchAgentsDir: dir, uid: 501, runner: fakeLaunchctl(() => res(0)).runner });
  await assert.rejects(m.installProgram({ programArguments: ['/x'], logDir: 'rel', logName: 'panel' }), /logDir must be an absolute path/);
  await assert.rejects(m.installProgram({ programArguments: ['/x'], logDir: dir, logName: '../evil' }), /invalid log name/);
});
