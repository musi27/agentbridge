// `agentbridge uninstall`: all against temp dirs with fake claude, launchctl and keychain
// (never the real ~/.agentbridge, ~/.claude, LaunchAgents or the "agentbridge" keychain service).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECRET_NAMES, SETUP_MARKER_FILE } from '@agentbridge/protocol';
import { DENY_RULES, installDenyRules } from '@agentbridge/adapter-claude-code';
import { LaunchdServiceManager } from '@agentbridge/presence';
import { openDatabase } from '../src/db/db.ts';
import { Store } from '../src/db/store.ts';
import { MemorySecretStore } from '../src/policy/integrity.ts';
import { resolvePaths } from '../src/paths.ts';
import { PLUGIN_ID, type CommandResult } from '../src/init/init.ts';
import { runUninstall, secretNames, unsafeDataRoot, type UninstallDeps, type UninstallReport } from '../src/init/uninstall.ts';
import { realUninstallDeps } from '../src/init/deps.ts';
import { main, parseUninstallArgs, UsageError } from '../src/cli/main.ts';
import { ScriptedPresence } from './helpers.ts';

const OTHER_SETTINGS = { model: 'opus', permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm:*)'] }, hooks: { Stop: [] } };

interface World {
  deps: UninstallDeps; root: string; paths: ReturnType<typeof resolvePaths>; settingsPath: string; plist: string;
  secrets: MemorySecretStore; presence: ScriptedPresence; lines: string[]; claudeCalls: string[][]; events: string[];
  lockPid: number | null; cleanup(): void;
}

function world(o: { claude?: (args: string[]) => CommandResult | Error; bots?: string[]; stopOk?: boolean } = {}): World {
  const root = mkdtempSync('/tmp/ab-uninst-');
  const paths = resolvePaths(join(root, 'ab'));
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logsDir, { recursive: true });
  writeFileSync(join(paths.logsDir, 'bridge.log'), 'log\n');
  // a database with bots, and their keychain items
  const db = openDatabase(paths.db);
  db.run('PRAGMA foreign_keys = OFF');
  const store = new Store(db);
  for (const id of o.bots ?? ['b1', 'b2']) store.insertBot({ bot_id: id, participant_id: `p-${id}`, token_hash: 'h', created_at: 1, revoked_at: null });
  db.close();
  const secrets = new MemorySecretStore();
  for (const n of secretNames(o.bots ?? ['b1', 'b2'])) secrets.map.set(n, 'v');
  secrets.map.set('unrelated', 'keep');
  // Claude settings with other content plus init's deny rules
  const settingsPath = join(root, 'claude', 'settings.json');
  mkdirSync(join(root, 'claude'));
  writeFileSync(settingsPath, JSON.stringify(OTHER_SETTINGS, null, 2));
  installDenyRules(settingsPath);
  // launchd agent
  const plist = join(root, 'LaunchAgents', 'live.musi.agentbridge.plist');
  mkdirSync(join(root, 'LaunchAgents')); writeFileSync(plist, '<plist/>');
  const presence = new ScriptedPresence();
  const lines: string[] = []; const claudeCalls: string[][] = []; const events: string[] = [];
  const installed = { plugin: true, marketplace: true };
  const w: World = {
    root, paths, settingsPath, plist, secrets, presence, lines, claudeCalls, events, lockPid: 4242,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    deps: {
      presence, paths, claudeSettingsPath: settingsPath, homeDir: join(root, 'home'), print: (l) => lines.push(l),
      claude: async (args) => {
        claudeCalls.push(args); events.push(`claude ${args.slice(0, 2).join(' ')}`);
        if (o.claude) { const r = o.claude(args); if (r instanceof Error) throw r; return r; }
        const key = args[1] === 'uninstall' ? 'plugin' : 'marketplace';
        if (!installed[key]) return { code: 1, stdout: '', stderr: `✘ Failed: "${args.at(-1)}" not found` };
        installed[key] = false; return { code: 0, stdout: 'ok', stderr: '' };
      },
      service: {
        plistPath: plist,
        status: async () => (existsSync(plist) ? 'running' : 'not_installed'),
        uninstall: async () => { events.push('launchd uninstall'); rmSync(plist, { force: true }); },
      },
      lockPid: () => w.lockPid,
      stopForeignBridge: async (pid) => { events.push(`stop ${pid}`); if (o.stopOk === false) return false; w.lockPid = null; return true; },
      marker: {
        write: () => { events.push('marker write'); writeFileSync(join(paths.runDir, SETUP_MARKER_FILE), 'x'); },
        remove: () => { events.push('marker remove'); rmSync(join(paths.runDir, SETUP_MARKER_FILE), { force: true }); },
      },
      secrets: async () => { events.push('secrets'); return secrets; },
    },
  };
  return w;
}

const status = (r: UninstallReport): Record<string, string> => Object.fromEntries(r.steps.map((s) => [s.id, s.status]));

test('uninstall: removes plugin, marketplace, launchd agent, bridge and deny rules; keeps data without --purge-data', async (t) => {
  const w = world(); t.after(w.cleanup);
  const r = await runUninstall(w.deps);
  assert.equal(r.ok, true, w.lines.join('\n'));
  assert.deepEqual(status(r), { plugin: 'removed', marketplace: 'removed', launchd: 'removed', bridge: 'removed', deny_rules: 'removed', keychain: 'left', data: 'left' });
  assert.deepEqual(w.presence.reasons, ['uninstall itself from this Mac']);
  assert.deepEqual(w.claudeCalls, [['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'], ['plugin', 'marketplace', 'remove', 'agentbridge']]);
  assert.deepEqual(w.events, ['marker write', 'claude plugin uninstall', 'claude plugin marketplace', 'launchd uninstall', 'stop 4242', 'marker remove']);
  assert.equal(existsSync(w.plist), false);
  assert.deepEqual(JSON.parse(readFileSync(w.settingsPath, 'utf8')), OTHER_SETTINGS);
  // data and keychain untouched; the setup marker is gone again
  assert.ok(existsSync(w.paths.db));
  assert.equal(existsSync(join(w.paths.runDir, SETUP_MARKER_FILE)), false);
  assert.equal(w.secrets.map.size, secretNames(['b1', 'b2']).length + 1);
  assert.ok(!w.events.includes('secrets'), 'the keychain is not opened without --purge-data');
  // prints what it removed, what it left, the Grok steps and the npm step last
  const out = w.lines.join('\n');
  assert.match(out, /removed {2}Claude Code plugin agentbridge@agentbridge/);
  assert.match(out, new RegExp(`removed {2}${DENY_RULES.length} agentbridge deny rules`));
  assert.match(out, /left {5}saved keys in the Keychain, service "agentbridge"[\s\S]*fix: agentbridge uninstall --purge-data/);
  // Grok refuses to delete its own connector (2026-11-24 reinstall): the user does it at grok.com/connectors
  assert.match(out, /In Grok: delete the agentbridge connector at https:\/\/grok\.com\/connectors .*"Inbox from agentbridge" routine.*Grok will not delete them/);
  assert.match(w.lines.at(-1)!, /npm uninstall -g @musi27\/agentbridge$/);
});

test('uninstall --purge-data: deletes the keychain items (incl. per-bot ones from the db) and the data folder; re-run is clean', async (t) => {
  const w = world(); t.after(w.cleanup);
  const r = await runUninstall(w.deps, { purgeData: true });
  assert.equal(r.ok, true, w.lines.join('\n'));
  assert.equal(status(r)['keychain'], 'removed');
  assert.equal(status(r)['data'], 'removed');
  assert.deepEqual([...w.secrets.map.keys()], ['unrelated']);
  assert.equal(existsSync(w.paths.root), false);
  assert.ok(!w.events.includes('marker remove'), 'the marker went with the folder');
  assert.deepEqual(w.presence.reasons, ['uninstall itself and delete all its data']);
  assert.match(w.lines.join('\n'), /removed {2}11 saved keys in the Keychain \(service "agentbridge"\)/);

  // second run: everything already gone, nothing fails
  w.lines.length = 0; w.events.length = 0;
  const again = await runUninstall(w.deps, { purgeData: true });
  assert.equal(again.ok, true, w.lines.join('\n'));
  assert.deepEqual(status(again), { plugin: 'absent', marketplace: 'absent', launchd: 'absent', bridge: 'absent', deny_rules: 'absent', keychain: 'absent', data: 'absent', relay: 'left' });
  assert.ok(!w.events.includes('marker write'), 'no data folder: no marker');
  assert.deepEqual(JSON.parse(readFileSync(w.settingsPath, 'utf8')), OTHER_SETTINGS);
});

test('uninstall --purge-data: a store with purge (the one-item keychain) gets every known name, including per-bot ones', async (t) => {
  const w = world(); t.after(w.cleanup);
  const asked: string[][] = [];
  (w.secrets as MemorySecretStore & { purge?: (n: readonly string[]) => Promise<number> }).purge = async (names) => { asked.push([...names]); return 4; };
  const r = await runUninstall(w.deps, { purgeData: true });
  assert.equal(r.ok, true, w.lines.join('\n'));
  assert.equal(asked.length, 1);
  assert.ok(asked[0]!.includes(SECRET_NAMES.webhookKey('b2')) && asked[0]!.includes(SECRET_NAMES.ed25519));
  assert.match(w.lines.join('\n'), /removed {2}4 saved keys in the Keychain/);
});

test('uninstall: a failed presence check changes nothing', async (t) => {
  const w = world(); t.after(w.cleanup);
  w.presence.answer = { ok: false, code: 'cancelled' };
  const before = readFileSync(w.settingsPath, 'utf8');
  const r = await runUninstall(w.deps, { purgeData: true });
  assert.equal(r.ok, false);
  assert.deepEqual(status(r), { presence: 'failed' });
  assert.deepEqual(w.events, []);
  assert.equal(readFileSync(w.settingsPath, 'utf8'), before);
  assert.ok(existsSync(w.plist)); assert.ok(existsSync(w.paths.db));
  assert.match(w.lines.join('\n'), /nothing was changed/);
});

test('uninstall: claude missing and an unstoppable lock holder fail with fixes, the other steps still run', async (t) => {
  const w = world({ claude: () => new Error('claude not found on PATH'), stopOk: false }); t.after(w.cleanup);
  const r = await runUninstall(w.deps);
  assert.equal(r.ok, false);
  assert.deepEqual(status(r), { plugin: 'failed', marketplace: 'failed', launchd: 'removed', bridge: 'failed', deny_rules: 'removed', keychain: 'left', data: 'left' });
  const out = w.lines.join('\n');
  assert.match(out, /fix: claude plugin uninstall agentbridge@agentbridge --scope user/);
  assert.match(out, /fix: claude plugin marketplace remove agentbridge/);
  assert.match(out, /pid 4242/);
  assert.match(w.lines.at(-1)!, /npm uninstall -g/);
  assert.equal(existsSync(join(w.paths.runDir, SETUP_MARKER_FILE)), false);
});

test('uninstall: an unreadable settings file is left alone and reported', async (t) => {
  const w = world(); t.after(w.cleanup);
  writeFileSync(w.settingsPath, '{bad');
  const r = await runUninstall(w.deps);
  assert.equal(status(r)['deny_rules'], 'failed');
  assert.equal(readFileSync(w.settingsPath, 'utf8'), '{bad');
});

test('uninstall --purge-data: refuses to delete a --home that is not an agentbridge folder', async (t) => {
  const root = mkdtempSync('/tmp/ab-uninst-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(join(home, 'Documents'), { recursive: true });
  assert.match(unsafeDataRoot(home, home)!, /home folder/);
  assert.match(unsafeDataRoot(root, home)!, /home folder or one of its parents/);
  assert.match(unsafeDataRoot('/', home)!, /home folder/);
  assert.match(unsafeDataRoot(join(home, 'Documents'), home) ?? '', /^$/, 'an empty folder is fine');
  writeFileSync(join(home, 'Documents', 'thesis.txt'), 'x');
  assert.match(unsafeDataRoot(join(home, 'Documents'), home)!, /does not look like an agentbridge data folder/);
  assert.equal(unsafeDataRoot(join(home, '.agentbridge'), home), null);

  const w = world(); t.after(w.cleanup);
  writeFileSync(join(w.root, 'notes.txt'), 'mine');
  const deps = { ...w.deps, paths: resolvePaths(w.root), homeDir: home };
  const r = await runUninstall(deps, { purgeData: true });
  assert.equal(status(r)['data'], 'failed');
  assert.ok(existsSync(join(w.root, 'notes.txt')));
});

test('uninstall: secret names cover identity, policy and per-bot items', () => {
  const n = secretNames(['x']);
  for (const s of [SECRET_NAMES.ed25519, SECRET_NAMES.x25519, SECRET_NAMES.policyHmacKey, SECRET_NAMES.policyVersion, SECRET_NAMES.policySnapshot, SECRET_NAMES.botToken('x'), SECRET_NAMES.webhookUrl('x'), SECRET_NAMES.webhookKey('x')]) assert.ok(n.includes(s), s);
});

test('uninstall: CLI flags', async () => {
  assert.deepEqual(parseUninstallArgs([]), {});
  assert.deepEqual(parseUninstallArgs(['--purge-data']), { purgeData: true });
  assert.throws(() => parseUninstallArgs(['--force']), UsageError);
  const err: string[] = [];
  assert.equal(await main(['uninstall', '--force', '--home', '/tmp/ab-none'], () => {}, (s) => err.push(s)), 2);
  assert.equal(await main(['--json', 'uninstall'], () => {}, (s) => err.push(s)), 2);
  assert.match(err.join('\n'), /global options must come after the subcommand for "uninstall"/);
});

test('uninstall: real deps wiring with a fake claude and launchctl in temp dirs', async (t) => {
  const root = mkdtempSync('/tmp/ab-uninst-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'calls.log');
  const bin = join(root, 'bin'); mkdirSync(bin);
  const fake = (name: string, body: string): string => { const p = join(bin, name); writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`); chmodSync(p, 0o755); return p; };
  const claudeBin = fake('claude', 'exit 0');
  const launchctl = fake('launchctl', 'case "$1" in print) exit 113;; *) exit 0;; esac');
  const agents = join(root, 'LaunchAgents'); mkdirSync(agents);
  const service = new LaunchdServiceManager({ launchAgentsDir: agents, launchctlPath: launchctl, uid: 501 });
  writeFileSync(service.plistPath, '<plist/>');
  const env = { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude') };
  mkdirSync(env.HOME); mkdirSync(env.CLAUDE_CONFIG_DIR);
  installDenyRules(join(env.CLAUDE_CONFIG_DIR, 'settings.json'));
  const paths = resolvePaths(join(root, 'ab')); mkdirSync(paths.root);
  const secrets = new MemorySecretStore(); secrets.map.set(SECRET_NAMES.ed25519, 'k');
  const presence = new ScriptedPresence();
  const lines: string[] = [];
  const deps = realUninstallDeps({ paths, presence, service, secrets: async () => secrets, print: (l) => lines.push(l), env, claudeBin });
  assert.equal(deps.claudeSettingsPath, join(env.CLAUDE_CONFIG_DIR, 'settings.json'));
  const r = await runUninstall(deps, { purgeData: true });
  assert.equal(r.ok, true, lines.join('\n'));
  assert.equal(existsSync(service.plistPath), false);
  assert.equal(existsSync(paths.root), false);
  assert.equal(secrets.map.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(deps.claudeSettingsPath, 'utf8')), { permissions: { deny: [] } });
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(calls, [
    `claude plugin uninstall ${PLUGIN_ID} --scope user`,
    'claude plugin marketplace remove agentbridge',
    'launchctl print gui/501/live.musi.agentbridge',
    'launchctl bootout gui/501/live.musi.agentbridge',
  ]);
});
