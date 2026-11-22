// Real InitDeps for `agentbridge init`: claude CLI, keychain + presence helper, launchd, local policy, IPC.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { SETUP_MARKER_FILE, formatSetupMarker, pidAlive } from '@agentbridge/protocol';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { DoctorCheck, PresenceChecker, SecretStore, ServiceManager } from '@agentbridge/protocol';
import { userSettingsPath } from '@agentbridge/adapter-claude-code';
import { homedir } from 'node:os';
import { liveLockPid, parseLaunchctlJob, plistMatches, resolveLaunchPaths } from './launch-env.ts';
import { openDatabase } from '../db/db.ts';
import { Store } from '../db/store.ts';
import { PolicyStore } from '../policy/integrity.ts';
import { applySetting } from '../policy/policy.ts';
import { IpcClient } from '../ipc/client.ts';
import { acquireLock } from '../service.ts';
import type { Paths } from '../paths.ts';
import { MARKETPLACE_NAME, type ClaudeRunner, type InitDeps, type PolicyAccess, type Prompter } from './init.ts';

const launchctlAt = (bin: string) => (args: string[]): Promise<{ code: number; out: string }> => new Promise((res) => {
  execFile(bin, args, { timeout: 30_000, encoding: 'utf8' }, (e, stdout, stderr) => res({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0, out: `${stderr}${stdout}`.trim().slice(0, 4000) }));
});

/** Stop `pid` only if it is an agentbridge bridge (its command names agentbridge's CLI/service); wait up to 5 s. */
export async function stopForeignBridge(pid: number, cmdOf: (pid: number) => Promise<string> = psCommand, kill: (pid: number) => void = (p) => process.kill(p, 'SIGTERM'), alive: (pid: number) => boolean = pidAlive): Promise<boolean> {
  if (pid === process.pid) return false;
  const cmd = await cmdOf(pid);
  if (!/agentbridge|service-main\.m?js|bridge\/src\/cli\/main\.ts/.test(cmd) || !/\bserve\b|service-main/.test(cmd)) return false;
  try { kill(pid); } catch { return !alive(pid); }
  for (let n = 0; n < 50 && alive(pid); n++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}
const psCommand = (pid: number): Promise<string> => new Promise((res) => {
  execFile('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }, (e, out) => res(e ? '' : out.trim()));
});

export const claudeRunner = (bin = 'claude'): ClaudeRunner => (args) => new Promise((res, rej) => {
  execFile(bin, args, { timeout: 120_000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') { rej(new Error(`${bin} not found on PATH`)); return; }
    res({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0, stdout, stderr });
  });
});

/** Walk up from this module to the repo's .claude-plugin/marketplace.json (installs from a checkout). */
export function findMarketplace(from: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let d = resolve(from);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, '.claude-plugin', 'marketplace.json'))) return d;
    const up = dirname(d); if (up === d) break; d = up;
  }
  return null;
}

/** The built service entry launchd runs (`node <entry>`); null if the package was not built. */
export function serviceEntry(): string | null {
  const here = fileURLToPath(import.meta.url);
  // release bundle (packaging/npm): dist/cli.mjs and dist/service-main.mjs side by side
  const bundled = join(dirname(here), 'service-main.mjs');
  if (existsSync(bundled)) return bundled;
  const built = here.endsWith('.js') ? join(dirname(here), '..', 'cli', 'service-main.js')
    : join(dirname(here), '..', '..', 'dist', 'cli', 'service-main.js'); // running from src (dev): use dist
  return existsSync(built) ? built : null;
}

/** Policy through the DB + keychain directly; only while the bridge is stopped (init stops it first). */
export async function localPolicy(paths: Paths, secrets: SecretStore): Promise<PolicyAccess> {
  const db = openDatabase(paths.db);
  const store = new Store(db);
  const ps = new PolicyStore(store, secrets);
  const st = await ps.load();
  if (!st.ok) throw new Error(`policy integrity check failed (${st.reason}); run agentbridge config verify first`);
  return {
    async get() { return ps.policy(); },
    async set(key, value) { await ps.set(applySetting(ps.policy(), key, value)); },
    close() { db.close(); },
  };
}

async function ping(socket: string): Promise<boolean> {
  try { const c = await IpcClient.connect(socket, 500); try { await c.request('ping', undefined, 1000); return true; } finally { c.close(); } } catch { return false; }
}

export const readlinePrompter: Prompter = {
  async choose(question, options, def) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      options.forEach((o, i) => process.stdout.write(`  ${i + 1}) ${o.label}${o.value === def ? '  [current]' : ''}\n`));
      const a = (await rl.question(`${question} [${options.findIndex((o) => o.value === def) + 1}]: `)).trim();
      const n = Number(a);
      return a === '' ? def : (options[n - 1]?.value ?? options.find((o) => o.value === a)?.value ?? def);
    } finally { rl.close(); }
  },
};

export interface RealDepsInput {
  paths: Paths; secrets: SecretStore; presence: PresenceChecker;
  service: ServiceManager & { uninstall(): Promise<void>; readonly plistPath: string; readonly serviceTarget: string };
  /** `agentbridge start` that ignores init's own setup marker (restores a manually started bridge). */
  startBridge(): Promise<void>;
  /** A launchd manager whose plist carries `environment` (PATH, AGENTBRIDGE_CLAUDE_BIN). */
  serviceFor(environment: Record<string, string>): ServiceManager;
  print(line: string): void; env?: NodeJS.ProcessEnv;
  /** Tests: a fake launchctl. */
  launchctlPath?: string;
}

export function realInitDeps(i: RealDepsInput): InitDeps {
  const env = i.env ?? process.env;
  const launchctl = launchctlAt(i.launchctlPath ?? '/bin/launchctl');
  return {
    claude: claudeRunner(),
    secrets: i.secrets, presence: i.presence,
    policy: () => localPolicy(i.paths, i.secrets),
    service: {
      status: () => i.service.status(),
      // a fresh manager per install so the plist gets this run's environment; install replaces any older plist
      // the plist environment goes to the manager; install() itself takes only the three absolute paths
      install: (o) => i.serviceFor(o.environment).install({ nodePath: o.nodePath, entry: o.entry, logDir: o.logDir }),
      // bootout only: the plist stays, so an abort can bootstrap it again (never leave things worse)
      stopManaged: async () => { const r = await launchctl(['bootout', i.service.serviceTarget]); if (r.code !== 0 && r.code !== 3 && r.code !== 113) throw new Error(`launchctl bootout failed (${r.code}): ${r.out}`); },
      startManaged: async () => {
        for (let n = 0; n < 10; n++) {
          const r = await launchctl(['bootstrap', i.service.serviceTarget.slice(0, i.service.serviceTarget.lastIndexOf('/')), i.service.plistPath]);
          if (r.code === 0) return;
          if (r.code !== 5 && r.code !== 37) throw new Error(`launchctl bootstrap failed (${r.code}): ${r.out}`);
          await new Promise((res) => setTimeout(res, 300));
        }
      },
      plistMatches: async (o) => plistMatches(i.service.plistPath, o),
      job: async () => { const r = await launchctl(['print', i.service.serviceTarget]); return r.code === 0 ? parseLaunchctlJob(r.out) : null; },
      kickstart: async () => { const r = await launchctl(['kickstart', '-k', i.service.serviceTarget]); if (r.code !== 0) throw new Error(`launchctl kickstart failed (${r.code}): ${r.out}`); },
    },
    startBridge: () => i.startBridge(),
    stopForeignBridge: (pid) => stopForeignBridge(pid),
    lockPid: () => liveLockPid(i.paths.lock, pidAlive),
    marker: {
      write: () => { mkdirSync(i.paths.runDir, { recursive: true, mode: 0o700 }); writeFileSync(join(i.paths.runDir, SETUP_MARKER_FILE), formatSetupMarker(process.pid, Date.now()), { mode: 0o600 }); },
      remove: () => { rmSync(join(i.paths.runDir, SETUP_MARKER_FILE), { force: true }); },
    },
    bridgeRunning: () => ping(i.paths.socket),
    async stopBridge() {
      const c = await IpcClient.open(i.paths.socket, 'cli');
      try { await c.request('cli.stop', {}); } finally { c.close(); }
      for (let n = 0; n < 50 && (await ping(i.paths.socket)); n++) await new Promise((r) => setTimeout(r, 100));
    },
    async waitForBridge() {
      for (let n = 0; n < 100; n++) { if (await ping(i.paths.socket)) return true; await new Promise((r) => setTimeout(r, 100)); }
      return false;
    },
    async doctor(): Promise<DoctorCheck[]> {
      const c = await IpcClient.open(i.paths.socket, 'cli');
      try { return (await c.request<{ checks: DoctorCheck[] }>('cli.doctor', {})).checks; } finally { c.close(); }
    },
    lock: () => { mkdirSync(i.paths.runDir, { recursive: true, mode: 0o700 }); return acquireLock(i.paths.lock); },
    fetch,
    prompt: readlinePrompter,
    print: i.print,
    marketplace: findMarketplace() ?? null,
    claudeSettingsPath: userSettingsPath(env),
    settings: { env },
    home: env['HOME'] ?? process.env['HOME'] ?? '/',
    service_entry: { entry: serviceEntry(), logDir: i.paths.logsDir },
    launchPaths: () => resolveLaunchPaths({ pathVar: env['PATH'], home: env['HOME'] ?? homedir(), execPath: process.execPath }),
  };
}

export { MARKETPLACE_NAME };
