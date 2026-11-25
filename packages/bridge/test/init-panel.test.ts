// `agentbridge panel start|stop|status`, init's panel step and uninstall's panel removal, against temp folders and a
// fake launchctl (never the real ~/Library/LaunchAgents or ~/.agentbridge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PanelAgent, type RunResult } from '@agentbridge/presence';
import { initPanelStep, panelStart, panelStatus, panelStop, readPanelPref, writePanelPref, type PanelDeps } from '../src/init/panel.ts';
import { realPanelDeps } from '../src/init/deps.ts';
import { resolvePaths } from '../src/paths.ts';
import { main, parseInitArgs } from '../src/cli/main.ts';

const res = (code: number, stdout = ''): RunResult => ({ code, signal: null, stdout, stderr: '', timedOut: false });

function world(o: { missing?: string; failInstall?: boolean } = {}) {
  const root = mkdtempSync('/tmp/ab-panel-');
  const agents = join(root, 'LaunchAgents');
  const calls: string[][] = [];
  let loaded = false;
  const agent = new PanelAgent({
    launchAgentsDir: agents, uid: 501, retryDelayMs: 1,
    runner: async (_f, args) => {
      calls.push([...args]);
      if (args[0] === 'bootstrap') { if (o.failInstall) return res(122); loaded = true; return res(0); }
      if (args[0] === 'bootout') { const was = loaded; loaded = false; return res(was ? 0 : 3); }
      if (args[0] === 'print') return loaded ? res(0, '\tstate = running\n') : res(113);
      return res(0);
    },
  });
  const paths = resolvePaths(join(root, 'ab'));
  const deps: PanelDeps = {
    agent, prefPath: join(paths.root, 'panel.json'), logDir: paths.logsDir, now: () => new Date('2026-11-25T12:00:00Z'),
    program: () => (o.missing ? { missing: o.missing } : { helperPath: '/pkg/bin/AgentBridge.app/Contents/MacOS/AgentBridge', nodePath: '/opt/homebrew/bin/node', cliEntry: '/pkg/dist/cli.mjs' }),
  };
  return { root, paths, deps, agent, calls, plist: agent.plistPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('preference file: unset, on, off; unreadable counts as unset', (t) => {
  const w = world(); t.after(w.cleanup);
  assert.equal(readPanelPref(w.deps.prefPath), null);
  writePanelPref(w.deps.prefPath, false, new Date('2026-11-25T12:00:00Z'));
  assert.equal(readPanelPref(w.deps.prefPath), 'off');
  assert.deepEqual(JSON.parse(readFileSync(w.deps.prefPath, 'utf8')), { enabled: false, changed_at: '2026-11-25T12:00:00.000Z' });
  writePanelPref(w.deps.prefPath, true);
  assert.equal(readPanelPref(w.deps.prefPath), 'on');
  writeFileSync(w.deps.prefPath, '{not json');
  assert.equal(readPanelPref(w.deps.prefPath), null);
});

test('init: on by default (installs and says how to turn it off); re-running init restarts it on the new release', async (t) => {
  const w = world(); t.after(w.cleanup);
  const s = await initPanelStep(w.deps, {});
  assert.deepEqual([s.ok, s.skipped, s.detail], [true, undefined, 'Menu-bar panel started. Turn it off with: agentbridge panel stop']);
  assert.ok(existsSync(w.plist));
  assert.match(readFileSync(w.plist, 'utf8'), /<string>panel<\/string>\n {4}<string>--<\/string>\n {4}<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.equal(readPanelPref(w.deps.prefPath), null, 'init records no choice: only the user does');
  await initPanelStep(w.deps, {});
  assert.deepEqual(w.calls.map((c) => c[0]), ['bootout', 'bootstrap', 'bootout', 'bootstrap']);
});

test('panel stop sticks: a later init leaves it off; only panel start turns it on again', async (t) => {
  const w = world(); t.after(w.cleanup);
  await initPanelStep(w.deps, {});
  const stop = await panelStop(w.deps);
  assert.equal(stop.ok, true);
  assert.match(stop.detail, /^Menu-bar panel stopped; it stays off after login and agentbridge init leaves it off \(turn it on with: agentbridge panel start\)$/);
  assert.equal(existsSync(w.plist), false);
  assert.equal(readPanelPref(w.deps.prefPath), 'off');
  const again = await initPanelStep(w.deps, {});
  assert.deepEqual([again.skipped, again.detail], [true, 'menu-bar panel off (you turned it off; turn it on with: agentbridge panel start)']);
  assert.equal(existsSync(w.plist), false);
  const start = await panelStart(w.deps);
  assert.equal(start.ok, true);
  assert.match(start.detail, /Menu-bar panel started; it starts at login\. Turn it off with: agentbridge panel stop/);
  assert.equal(readPanelPref(w.deps.prefPath), 'on');
  assert.ok(existsSync(w.plist));
  assert.ok((await initPanelStep(w.deps, {})).detail.startsWith('Menu-bar panel started'));
});

test('init --skip-panel never installs it and leaves an existing one alone', async (t) => {
  const w = world(); t.after(w.cleanup);
  const s = await initPanelStep(w.deps, { skip: true });
  assert.deepEqual([s.ok, s.skipped], [true, true]);
  assert.match(s.detail, /--skip-panel/);
  assert.equal(existsSync(w.plist), false);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(parseInitArgs(['--skip-panel', '--yes']), { skipPanel: true, yes: true });
});

test('init never fails because of the panel: missing helper or a launchctl error is a skip with a fix', async (t) => {
  const missing = world({ missing: 'AgentBridge.app not found at /x' }); t.after(missing.cleanup);
  const s1 = await initPanelStep(missing.deps, {});
  assert.deepEqual([s1.ok, s1.skipped, s1.detail], [true, true, 'menu-bar panel not started: AgentBridge.app not found at /x']);
  const broken = world({ failInstall: true }); t.after(broken.cleanup);
  const s2 = await initPanelStep(broken.deps, {});
  assert.deepEqual([s2.ok, s2.skipped, s2.fix], [true, true, 'agentbridge panel start']);
  // panel start, on the other hand, reports the failure
  const r = await panelStart(missing.deps);
  assert.equal(r.ok, false);
  assert.match(r.detail, /can't start: AgentBridge\.app not found/);
});

test('panel status: not installed / running / turned off', async (t) => {
  const w = world(); t.after(w.cleanup);
  assert.match((await panelStatus(w.deps)).detail, /^menu-bar panel: not installed \(on by default\); turn it on with: agentbridge panel start$/);
  await panelStart(w.deps);
  const on = await panelStatus(w.deps);
  assert.deepEqual([on.state, on.pref], ['running', 'on']);
  assert.match(on.detail, /running \(turned on\); Turn it off with: agentbridge panel stop/);
  await panelStop(w.deps);
  assert.match((await panelStatus(w.deps)).detail, /not installed \(turned off\)/);
});

test('realPanelDeps: macOS only, needs the helper; passes --home as an absolute path', (t) => {
  const w = world(); t.after(w.cleanup);
  const linux = realPanelDeps({ paths: w.paths, agent: w.agent, helperPath: '/nope', platform: 'linux' });
  assert.deepEqual(linux.program(), { missing: 'the menu-bar panel is macOS-only' });
  const noHelper = realPanelDeps({ paths: w.paths, agent: w.agent, helperPath: join(w.root, 'missing'), platform: 'darwin' });
  assert.match(String((noHelper.program() as { missing: string }).missing), /AgentBridge\.app not found/);
  mkdirSync(join(w.root, 'h')); writeFileSync(join(w.root, 'h', 'AgentBridge'), '');
  const ok = realPanelDeps({ paths: w.paths, home: 'rel/home', agent: w.agent, helperPath: join(w.root, 'h', 'AgentBridge'), platform: 'darwin', env: { PATH: '/usr/bin', HOME: w.root } }).program();
  if ('missing' in ok) { assert.match(ok.missing, /CLI entry is missing/); return; } // dist not built in this checkout
  assert.ok(ok.home?.startsWith('/') && ok.home.endsWith('rel/home'));
  assert.match(ok.cliEntry, /(dist\/cli\/main\.js|cli\.mjs)$/);
  assert.equal(realPanelDeps({ paths: w.paths, agent: w.agent, helperPath: '/x' }).prefPath, join(w.paths.root, 'panel.json'));
});

test('agentbridge panel: usage errors', async () => {
  const err: string[] = [];
  assert.equal(await main(['panel', 'restart'], () => {}, (l) => err.push(l)), 2);
  assert.match(err.join('\n'), /usage: agentbridge panel \[start\|stop\|status\]/);
  assert.equal(await main(['panel', 'stop', 'now'], () => {}, () => {}), 2);
  const help: string[] = [];
  await main(['help'], (l) => help.push(l));
  assert.match(help.join('\n'), /panel \[start\|stop\|status\] {3}menu-bar panel/);
  assert.match(help.join('\n'), /init \[--skip-panel\]/);
});
