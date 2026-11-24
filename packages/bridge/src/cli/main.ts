#!/usr/bin/env node
// agentbridge CLI (§14). Unprivileged commands talk to the bridge directly; privileged ones are sent to the bridge,
// which runs the user-presence check itself (§9.2). Global flags placed before a privileged subcommand are rejected
// so the Claude Code deny rules (`Bash(agentbridge approve:*)` …) keep matching (§11.4).
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETUP_MARKER_FILE, pidAlive, setupMarkerLive } from '@agentbridge/protocol';
import { fileURLToPath } from 'node:url';
import { IpcClient, IpcCallError } from '../ipc/client.ts';
import { resolvePaths } from '../paths.ts';
import { BRIDGE_VERSION, versionMismatch } from '../version.ts';
import { addGrokFlow, printRoundTrip, revokeGrokFlow, terminalIo, type Io } from './grok.ts';
import type { RoundTripResult } from '../grok/setup.ts';
import type { RelayRuntime as RelayRuntimeT } from '../relay/runtime.ts';

export const PRIVILEGED = new Set(['config set', 'config verify', 'approve', 'decline', 'extend', 'revoke', 'remove', 'add', 'show', 'end', 'stop', 'identity', 'purge', 'uninstall']);
export const COMMANDS = ['status', 'agents', 'conversations', 'doctor', 'logs', 'open', 'start', 'stop', 'config', 'approve', 'decline', 'extend', 'end', 'show', 'remove', 'revoke', 'add', 'identity', 'purge', 'init', 'uninstall', 'serve', 'help'];

export interface Parsed { cmd: string; args: string[]; json: boolean; home?: string }
export class UsageError extends Error {}

const GLOBAL_WITH_VALUE = new Set(['--home']);
const GLOBAL_BOOL = new Set(['--json']);

/** Parse argv. Throws UsageError for a global flag before a privileged subcommand. */
export function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = { cmd: '', args: [], json: false };
  let sawGlobalBeforeCmd = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') ? (eq > 0 ? a.slice(0, eq) : a) : null;
    if (flag && (GLOBAL_BOOL.has(flag) || GLOBAL_WITH_VALUE.has(flag))) {
      if (!out.cmd) sawGlobalBeforeCmd = true;
      if (GLOBAL_BOOL.has(flag)) out.json = true;
      else { const v = eq > 0 ? a.slice(eq + 1) : argv[++i]; if (!v) throw new UsageError(`${flag} needs a value`); out.home = v; }
      continue;
    }
    if (!out.cmd) {
      if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
      out.cmd = a; continue;
    }
    out.args.push(a);
  }
  if (!out.cmd) out.cmd = 'help';
  const key = out.cmd === 'config' ? `config ${out.args[0] ?? ''}` : out.cmd;
  if (sawGlobalBeforeCmd && PRIVILEGED.has(key)) throw new UsageError(`global options must come after the subcommand for "${key}" (e.g. agentbridge ${key} … --json)`);
  return out;
}

const HELP = `agentbridge — conversations between your Claude Code sessions, Codex CLI sessions and Grok bots

Unprivileged:
  status | agents | conversations | doctor [grok:<name>] | logs [--limit N] | open <address> | start | config get
Setup:
  init | add codex | remove codex   (add codex: connect Codex CLI sessions; edits ~/.codex/config.toml)
Privileged (Touch ID / password, checked by the bridge):
  approve <id> | decline <id> | extend <id> <n> | end <id> | end --inactive <duration> | show <id>
  config set <key> <value> | config verify [show|reapprove|restore] | remove <address> | purge [--before <duration>] | stop
  add grok | revoke grok:<name> | identity rotate (M2)
  uninstall [--purge-data]   remove the plugin, login agent and deny rules (works without a running bridge)
Global options (after the subcommand for privileged commands): --json, --home <dir>
Version: agentbridge --version   (upgrade: npm install -g @musi27/agentbridge, then agentbridge init)`;

type Print = (s: string) => void;

type AgentRow = { address: string; title?: string; state: string; permission_mode: string; short_id: string; folder?: string };
const UNKNOWN_MODE_NOTE = '(waiting for first prompt: messages to that session are held until someone types in it)';
/** One agent per line: address, state, mode, short id, folder, then Claude Code's session title. */
function agentLine(p: AgentRow): string {
  const mode = p.permission_mode === 'unknown' ? 'waiting for first prompt' : p.permission_mode;
  return `${p.address.padEnd(28)} ${p.state.padEnd(12)} ${mode.padEnd(24)} ${p.short_id}${p.folder ? `  ${p.folder}` : ''}${p.title ? `  "${p.title}"` : ''}`;
}

function human(cmd: string, r: unknown, print: Print): void {
  const rows = (x: unknown): Array<Record<string, unknown>> => (Array.isArray(x) ? (x as Array<Record<string, unknown>>) : []);
  if (cmd === 'status') {
    const s = r as { bridge_version: string; pid: number; policy: { ok: boolean; mode?: string; version?: number; reason?: string }; participants: Array<{ address: string; title?: string; state: string; permission_mode: string; short_id: string; folder?: string }>; conversations: Record<string, number>; queued_deliveries: number; pending_approvals: Array<{ approval_id: string; kind: string; participant: string; peer: string; expires_in_s: number | null }>; auto_mode_sessions: string[]; notifications: Array<{ at: string; title: string; body: string }> };
    print(`bridge ${s.bridge_version} (pid ${s.pid}) — policy ${s.policy.ok ? `v${s.policy.version}, mode ${s.policy.mode}` : `TAMPERED (${s.policy.reason}): run agentbridge config verify`}`);
    const vm = versionMismatch(s.bridge_version);
    if (vm) print(`warning: ${vm}; ${VERSION_FIX}`);
    print(`conversations: ${s.conversations['active']} active, ${s.conversations['pending']} pending, ${s.conversations['ended']} ended; ${s.queued_deliveries} queued deliveries`);
    for (const p of s.participants) print(`  ${agentLine(p)}`);
    if (s.participants.some((p) => p.permission_mode === 'unknown')) print(UNKNOWN_MODE_NOTE);
    for (const a of s.pending_approvals) print(`  approval ${a.approval_id} ${a.kind} ${a.participant} ↔ ${a.peer}${a.expires_in_s !== null ? ` (expires in ${a.expires_in_s}s)` : ''}`);
    if (s.auto_mode_sessions.length) print(`warning: sessions in Claude Code auto mode: ${s.auto_mode_sessions.join(', ')}`);
    for (const n of s.notifications) print(`notice ${n.at}: ${n.title} — ${n.body}`);
    return;
  }
  if (cmd === 'agents') {
    const ps = rows(r) as unknown as AgentRow[];
    for (const p of ps) print(agentLine(p));
    if (ps.some((p) => p.permission_mode === 'unknown')) print(UNKNOWN_MODE_NOTE);
    return;
  }
  if (cmd === 'conversations') { for (const c of rows(r)) print(`${c['id']}  ${String(c['state']).padEnd(7)} ${String(c['turns']).padEnd(7)} ${c['initiator']} → ${c['invitee']}  ${c['end_reason'] ?? ''}`); return; }
  if (cmd === 'doctor') {
    for (const c of rows((r as { checks: unknown }).checks)) print(`${c['ok'] ? 'ok  ' : 'FAIL'} ${c['id']}: ${c['detail']}${c['fix'] ? ` — fix: ${c['fix']}` : ''}`);
    const rt = (r as { round_trip?: RoundTripResult }).round_trip;
    if (rt) printRoundTrip({ print } as Io, rt);
    return;
  }
  if (cmd === 'logs') { for (const e of rows(r)) print(`${e['at']} ${String(e['level']).padEnd(7)} ${e['type']}${e['participant'] ? ` ${e['participant']}` : ''}${e['conversation_id'] ? ` ${e['conversation_id']}` : ''}`); return; }
  if (cmd === 'open') { const o = r as { command: string; cwd: string | null }; print(o.cwd ? `cd ${JSON.stringify(o.cwd)} && ${o.command}` : o.command); return; }
  if (cmd === 'show') {
    const t = r as { initiator: string; invitee: string; topic: string; state: string; turns: string; messages: Array<{ seq: number; from: string; body: string }> };
    print(`${t.initiator} ↔ ${t.invitee} — ${t.state}, turns ${t.turns}\ntopic (untrusted): ${t.topic}\n`);
    for (const m of t.messages) print(`#${m.seq} ${m.from}:\n${m.body}\n`);
    return;
  }
  print(JSON.stringify(r, null, 2));
}

/** `doctor` without a running bridge: bridge status + Claude Code, helper, launchd and relay reachability. */
async function offlineDoctor(home: string | undefined): Promise<Array<{ id: string; ok: boolean; detail: string; fix?: string }>> {
  const { platformDoctor } = await import('../doctor.ts');
  const presence = await import('@agentbridge/presence');
  const { ClaudeCodeAdapter } = await import('@agentbridge/adapter-claude-code');
  const { DEFAULT_POLICY, rowsToPolicy } = await import('../policy/policy.ts');
  const paths = resolvePaths(home);
  let policy = DEFAULT_POLICY;
  if (existsSync(paths.db)) {
    try {
      const { openDatabase } = await import('../db/db.ts'); const { Store } = await import('../db/store.ts');
      const db = openDatabase(paths.db); try { policy = rowsToPolicy(new Store(db).policyRows()); } finally { db.close(); }
    } catch { /* unreadable: default relay */ }
  }
  const { claudeVersionRunner, launchdProgramChecks, launchdOwner, ownerCheck } = await import('../init/launch-env.ts');
  const { pidAlive } = await import('@agentbridge/protocol');
  const claude = new ClaudeCodeAdapter(() => null, { claudeVersion: claudeVersionRunner() });
  const launchd = new presence.LaunchdServiceManager();
  return [
    { id: 'bridge', ok: false, detail: 'the bridge is not running (relay identity and session checks need it)', fix: 'agentbridge start' },
    ...await platformDoctor({ claude: () => claude.doctor(), helper: () => presence.verifyHelper(), launchd: () => launchd.status(), launchdProgram: () => launchdProgramChecks(launchd.plistPath), launchdOwner: async () => ownerCheck(await launchdOwner(launchd.serviceTarget, resolvePaths(home).lock, pidAlive)), relay: { policy: () => policy, secrets: null } }),
  ];
}

/** `agentbridge add codex` / `remove codex` (§11a): edits only the managed block in $CODEX_HOME/config.toml. */
async function codexSetup(cmd: 'add' | 'remove', print: Print): Promise<number> {
  const { addCodex, removeCodex, CODEX_NEXT_STEPS } = await import('../init/codex.ts');
  const r = cmd === 'add' ? addCodex() : removeCodex();
  print(`${r.ok ? 'ok  ' : 'FAIL'} ${r.message}`);
  if (r.ok && r.changed) print(cmd === 'add' ? `(a copy of the previous file is in ${r.path}.agentbridge-backup)\n\n${CODEX_NEXT_STEPS.join('\n')}` : 'Restart any open Codex sessions to drop the agentbridge tools.');
  return r.ok ? 0 : 1;
}

async function call(socket: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
  return (await callWithVersion(socket, method, params, timeoutMs)).result;
}

/** Like call(), plus the running bridge's version from the hello answer. */
async function callWithVersion(socket: string, method: string, params: unknown, timeoutMs?: number): Promise<{ result: unknown; bridgeVersion: string | null }> {
  let c: IpcClient;
  try { c = await IpcClient.open(socket, 'cli'); } catch { throw new Error('agentbridge is not running (start it with: agentbridge start)'); }
  try { return { result: await c.request(method, params, timeoutMs), bridgeVersion: c.bridgeVersion }; } finally { c.close(); }
}

/** What to do about a CLI/bridge version mismatch (§14.1 upgrade). */
export const VERSION_FIX = 'run agentbridge init to restart the bridge on this version';

/** doctor's version check: the CLI and the running bridge should be the same release. */
export function versionCheck(bridgeVersion: string | null): { id: string; ok: boolean; detail: string; fix?: string } {
  const m = versionMismatch(bridgeVersion);
  return m ? { id: 'bridge_version', ok: false, detail: `${m} (restart it after an upgrade)`, fix: VERSION_FIX }
    : { id: 'bridge_version', ok: true, detail: `bridge ${bridgeVersion ?? '?'} matches this agentbridge ${BRIDGE_VERSION}` };
}

/** `agentbridge --version`: this CLI's version, plus the running bridge's when it differs. */
async function version(home: string | undefined, print: Print): Promise<number> {
  print(`agentbridge ${BRIDGE_VERSION}`);
  const socket = resolvePaths(home).socket;
  if (!(await ping(socket))) return 0;
  try {
    const c = await IpcClient.open(socket, 'cli');
    try { const m = versionMismatch(c.bridgeVersion); if (m) print(`note: ${m}; ${VERSION_FIX}`); } finally { c.close(); }
  } catch { /* the version line is what was asked for */ }
  return 0;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name); if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; }
  return undefined;
}

/** Map a parsed command to an IPC method + params (exported for tests). */
export function toRequest(p: Parsed): { method: string; params: unknown } {
  const a = [...p.args];
  const need = (n: number, usage: string): void => { if (a.length < n) throw new UsageError(`usage: agentbridge ${usage}`); };
  switch (p.cmd) {
    case 'status': return { method: 'cli.status', params: {} };
    case 'agents': return { method: 'cli.agents', params: {} };
    case 'conversations': return { method: 'cli.conversations', params: {} };
    case 'doctor': return { method: 'cli.doctor', params: a[0] ? { round_trip: a[0] } : {} };
    case 'logs': { const l = flagValue(a, '--limit'); return { method: 'cli.logs', params: l ? { limit: Number(l) } : {} }; }
    case 'open': need(1, 'open <address>'); return { method: 'cli.open', params: { address: a[0] } };
    case 'approve': need(1, 'approve <approval-id>'); return { method: 'cli.approve', params: { approval_id: a[0] } };
    case 'decline': need(1, 'decline <approval-id>'); return { method: 'cli.decline', params: { approval_id: a[0] } };
    case 'extend': need(2, 'extend <conversation-id> <turns>'); return { method: 'cli.extend', params: { conversation_id: a[0], add_turns: Number(a[1]) } };
    case 'show': need(1, 'show <conversation-id>'); return { method: 'cli.show', params: { conversation_id: a[0] } };
    case 'end': { const inactive = flagValue(a, '--inactive'); if (inactive) return { method: 'cli.end', params: { inactive } }; need(1, 'end <conversation-id> | end --inactive <duration>'); return { method: 'cli.end', params: { conversation_id: a[0] } }; }
    case 'remove': need(1, 'remove <address>'); return { method: 'cli.remove', params: { address: a[0] } };
    case 'purge': { const before = flagValue(a, '--before'); return { method: 'cli.purge', params: before ? { before } : {} }; }
    case 'stop': return { method: 'cli.stop', params: {} };
    case 'revoke': need(1, 'revoke grok:<name>'); return { method: 'cli.revoke', params: { address: a[0] } };
    case 'add': if (a[0] !== 'grok') throw new UsageError('usage: agentbridge add grok'); return { method: 'cli.add_grok', params: {} };
    case 'identity': if (a[0] !== 'rotate') throw new UsageError('usage: agentbridge identity rotate'); return { method: 'cli.identity_rotate', params: {} };
    case 'config': {
      const sub = a.shift();
      if (sub === 'get') return { method: 'cli.config_get', params: {} };
      if (sub === 'set') { need(2, 'config set <key> <value>'); return { method: 'cli.config_set', params: { key: a[0], value: a.slice(1).join(' ') } }; }
      if (sub === 'verify') return { method: 'cli.config_verify', params: { action: a[0] ?? 'show' } };
      throw new UsageError('usage: agentbridge config get | set <key> <value> | verify [show|reapprove|restore]');
    }
    default: throw new UsageError(`unknown command "${p.cmd}"\n\n${HELP}`);
  }
}

async function ping(socket: string): Promise<boolean> {
  try { const c = await IpcClient.connect(socket, 500); try { await c.request('ping', undefined, 1000); return true; } finally { c.close(); } } catch { return false; }
}

/** Start the service detached (§11.5 on-demand start); waits until the socket answers. */
export async function startDetached(home: string | undefined, o: { duringSetup?: boolean } = {}): Promise<string> {
  const paths = resolvePaths(home);
  if (await ping(paths.socket)) return 'agentbridge is already running';
  // `agentbridge init` is reconfiguring (run/setup.lock): it restarts the bridge itself; only init may start it now
  if (!o.duringSetup) {
    let marker: string | null = null;
    try { marker = readFileSync(join(paths.runDir, SETUP_MARKER_FILE), 'utf8'); } catch { marker = null; }
    if (setupMarkerLive(marker, Date.now(), pidAlive)) throw new Error('agentbridge init is running; it will start the bridge when it finishes');
  }
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  const log = openSync(`${paths.logsDir}/bridge.log`, 'a', 0o600);
  // re-run the entry script that is running now (argv[1]): in the release bundle this module lives in a split chunk,
  // and `node <chunk> serve` would just load it and exit
  const self = process.argv[1] && existsSync(process.argv[1]) ? process.argv[1] : fileURLToPath(import.meta.url);
  const args = [...process.execArgv, self, 'serve', ...(home ? ['--home', home] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) { if (await ping(paths.socket)) return `agentbridge started (pid ${child.pid})`; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`agentbridge did not start; see ${paths.logsDir}/bridge.log`);
}

/**
 * Run the bridge service until stopped: storage, engine, IPC, platform doctor checks and — when an identity exists and
 * @agentbridge/relay is installed — the relay client (§13.2). Used by `agentbridge serve` and the launchd entry.
 */
export async function runService(home: string | undefined, print: Print): Promise<void> {
  const { startBridge } = await import('../service.ts');
  const { loadPlatform } = await import('../platform.ts');
  const { platformDoctor } = await import('../doctor.ts');
  const { startServiceRelay } = await import('../relay/attach.ts');
  const presence = await import('@agentbridge/presence');
  const { ClaudeCodeAdapter } = await import('@agentbridge/adapter-claude-code');
  const paths = resolvePaths(home);
  if (!existsSync(paths.root)) mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const platform = await loadPlatform(paths.root);
  const launchd = new presence.LaunchdServiceManager();
  let relay: RelayRuntimeT | null = null;
  let svc: Awaited<ReturnType<typeof startBridge>>;
  const { claudeVersionRunner, launchdProgramChecks, launchdOwner, ownerCheck } = await import('../init/launch-env.ts');
  const { pidAlive } = await import('@agentbridge/protocol');
  const claude = new ClaudeCodeAdapter(() => null, {
    claudeVersion: claudeVersionRunner(), // the absolute path init recorded in the plist (launchd's PATH lacks ~/.local/bin)
    doctorCwds: () => svc ? [...new Set(svc.store.participants().filter((p) => p.agent === 'claude' && p.state !== 'gone' && p.cwd).map((p) => p.cwd!))] : [],
  });
  const stopAll = async (): Promise<void> => { try { await relay?.stop(); } catch { /* best effort */ } await svc.stop(); };
  svc = await startBridge({
    root: paths.root, ...platform, log: (l) => print(l),
    onStopRequested: () => { void stopAll().then(() => process.exit(0)); },
    doctorExtras: () => platformDoctor({
      claude: () => claude.doctor(),
      helper: () => presence.verifyHelper(),
      launchd: () => launchd.status(),
      launchdProgram: () => launchdProgramChecks(launchd.plistPath), launchdOwner: async () => ownerCheck(await launchdOwner(launchd.serviceTarget, resolvePaths(home).lock, pidAlive)),
      relay: { policy: () => (svc.engine.policyStore.current().ok ? svc.engine.policyStore.policy() : null), secrets: platform.secrets, connected: () => relay?.client.connected ?? null },
    }),
  });
  print(`agentbridge serving on ${paths.socket} (platform: ${platform.source})`);
  // Relay (§13.2): needs identity keys (agentbridge init) and the relay client package.
  try { relay = await startServiceRelay(svc, platform.secrets, { log: print }); }
  catch (e) { print(`relay: not started (${(e as Error).message})`); }
  const shutdown = (): void => { void stopAll().then(() => process.exit(0)); };
  // one bad item must not kill the service: log and keep serving
  process.on('unhandledRejection', (e) => { try { svc.engine.event('error', 'unhandled_rejection', { error: String((e as Error)?.stack ?? e).slice(0, 500) }); } catch { /* db closed */ } print(`unhandledRejection: ${String((e as Error)?.stack ?? e)}`); });
  process.on('uncaughtException', (e) => { try { svc.engine.event('error', 'uncaught_exception', { error: String(e.stack ?? e).slice(0, 500) }); } catch { /* db closed */ } print(`uncaughtException: ${String(e.stack ?? e)}`); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

const serve = runService;

/** `agentbridge init` flags. */
export function parseInitArgs(args: readonly string[]): import('../init/init.ts').InitOptions {
  const o: import('../init/init.ts').InitOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--relay') { const v = args[++i]; if (!v) throw new UsageError('--relay needs a URL'); o.relayUrl = v; }
    else if (a === '--mode') { const v = args[++i]; if (v !== 'per_conversation' && v !== 'auto') throw new UsageError('--mode is per_conversation or auto'); o.mode = v; }
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--skip-plugin') o.skipPlugin = true;
    else if (a === '--skip-service') o.skipService = true;
    else if (a === '--skip-relay') o.skipRelay = true;
    else throw new UsageError(`unknown init option ${a}`);
  }
  if (o.relayUrl) { try { const u = new URL(o.relayUrl); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'))) throw new Error(); } catch { throw new UsageError('--relay must be an https URL (http only for localhost)'); } }
  return o;
}

async function init(home: string | undefined, args: readonly string[], print: Print): Promise<number> {
  const opts = parseInitArgs(args);
  const { runInit } = await import('../init/init.ts');
  const { realInitDeps } = await import('../init/deps.ts');
  const presence = await import('@agentbridge/presence');
  const paths = resolvePaths(home);
  if (!existsSync(paths.root)) mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  let secrets, checker;
  try { secrets = await presence.createSecretStore(); checker = await presence.createPresenceChecker(); }
  catch (e) { print(`agentbridge init: ${(e as Error).message}`); return 1; }
  const report = await runInit(realInitDeps({ paths, secrets, presence: checker, service: new presence.LaunchdServiceManager(), startBridge: async () => { await startDetached(home, { duringSetup: true }); }, serviceFor: (environment) => new presence.LaunchdServiceManager({ environment: { ...environment, ...(home ? { AGENTBRIDGE_HOME: paths.root } : {}) } }), print }), opts);
  print(report.ok ? '\nagentbridge is set up.' : '\nSome steps need attention (see FAIL lines above); fix them and run agentbridge init again.');
  return report.ok ? 0 : 1;
}

/** `agentbridge uninstall` flags. */
export function parseUninstallArgs(args: readonly string[]): import('../init/uninstall.ts').UninstallOptions {
  const o: import('../init/uninstall.ts').UninstallOptions = {};
  for (const a of args) {
    if (a === '--purge-data') o.purgeData = true;
    else throw new UsageError(`unknown uninstall option ${a} (usage: agentbridge uninstall [--purge-data])`);
  }
  return o;
}

async function uninstall(home: string | undefined, args: readonly string[], json: boolean, print: Print): Promise<number> {
  const opts = parseUninstallArgs(args);
  const { runUninstall } = await import('../init/uninstall.ts');
  const { realUninstallDeps } = await import('../init/deps.ts');
  const presence = await import('@agentbridge/presence');
  let checker;
  try { checker = await presence.createPresenceChecker(); }
  catch (e) { print(`agentbridge uninstall: ${(e as Error).message}\nThe Touch ID helper is needed to confirm it is you. To remove agentbridge by hand, follow docs/troubleshooting.md ("Uninstall").`); return 1; }
  const out: string[] = [];
  const report = await runUninstall(realUninstallDeps({ paths: resolvePaths(home), presence: checker, service: new presence.LaunchdServiceManager(), secrets: () => presence.createSecretStore(), print: json ? (l) => out.push(l) : print }), opts);
  if (json) print(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

export async function main(argv: readonly string[], print: Print = (s) => process.stdout.write(`${s}\n`), printErr: Print = (s) => process.stderr.write(`${s}\n`), io?: Io): Promise<number> {
  let p: Parsed;
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    const h = argv.indexOf('--home'); return await version(h > 0 ? argv[h + 1] : undefined, print);
  }
  try { p = parseArgs(argv); } catch (e) { printErr(`agentbridge: ${(e as Error).message}`); return 2; }
  try {
    if (p.cmd === 'help' || p.cmd === '--help') { print(HELP); return 0; }
    if (p.cmd === 'init') return await init(p.home, p.args, print);
    if (p.cmd === 'uninstall') return await uninstall(p.home, p.args, p.json, print);
    if (p.cmd === 'start') { print(await startDetached(p.home)); return 0; }
    if (p.cmd === 'serve') { await serve(p.home, print); return -1; }
    if ((p.cmd === 'add' || p.cmd === 'remove') && p.args[0] === 'codex') return await codexSetup(p.cmd, print);
    const req = toRequest(p);
    const socket = resolvePaths(p.home).socket;
    // interactive Grok flows (§12.5, §12.6); --json is not offered for them
    if (req.method === 'cli.add_grok') return await addGrokFlow((m, x, t) => call(socket, m, x, t), io ?? terminalIo());
    if (req.method === 'cli.revoke' && String(p.args[0]).startsWith('grok:')) return await revokeGrokFlow((m, x, t) => call(socket, m, x, t), io ?? terminalIo(), String(p.args[0]));
    if (req.method === 'cli.doctor' && !(req.params as { round_trip?: string }).round_trip && !(await ping(socket))) {
      // no bridge: run the platform checks locally (never touches the keychain), so doctor helps before `start`
      const checks = await offlineDoctor(p.home);
      if (p.json) print(JSON.stringify({ checks }, null, 2)); else human('doctor', { checks }, print);
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    const { result, bridgeVersion } = await callWithVersion(socket, req.method, req.params, req.method === 'cli.doctor' && (req.params as { round_trip?: string }).round_trip ? 150_000 : undefined);
    let r = result;
    if (req.method === 'cli.doctor' && r && typeof r === 'object' && Array.isArray((r as { checks?: unknown }).checks)) {
      r = { ...r, checks: [versionCheck(bridgeVersion), ...(r as { checks: unknown[] }).checks] };
    }
    if (req.method === 'cli.status' && r && typeof r === 'object') r = { ...r, cli_version: BRIDGE_VERSION };
    if (p.json) print(JSON.stringify(r, null, 2)); else human(p.cmd, r, print);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { printErr(e.message); return 2; }
    if (e instanceof IpcCallError) { printErr(`agentbridge: ${e.code}: ${e.message}`); return 1; }
    printErr(`agentbridge: ${(e as Error).message}`); return 1;
  }
}

// Run when executed directly as main.ts/main.js (the release bundle has its own bin entry, packaging/npm/src/bin.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && /[/\\]main\.(ts|js)$/.test(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => { if (code >= 0) process.exitCode = code; });
}
