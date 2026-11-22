// Paths for the launchd agent (§14.1). launchd starts the bridge with a minimal environment, so `init` decides, from
// the CLI's own PATH: a stable node path (never a versioned Homebrew Cellar path a `brew upgrade` deletes), the
// absolute path of `claude` (Claude Code's default install is ~/.local/bin, not on launchd's PATH), and the plist PATH.
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

/** Plist env var holding the absolute path of `claude` recorded by init; the bridge's doctor uses it first. */
export const CLAUDE_BIN_ENV = 'AGENTBRIDGE_CLAUDE_BIN';

const executable = (p: string): boolean => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

/** A path that a package-manager upgrade replaces: Homebrew Cellar, nvm/fnm/asdf/volta version dirs, …/node/25.9.0/… */
export function isVersionedPath(p: string): boolean {
  return /\/Cellar\//.test(p) || /\/(?:\.nvm|\.fnm|\.asdf|\.volta|\.local\/share\/fnm)\//.test(p) || /\/v?\d+\.\d+\.\d+(?:_\d+)?\//.test(p);
}

/** First `name` on PATH, like `which`, without resolving symlinks. */
export function whichOnPath(name: string, pathVar: string | undefined): string | null {
  for (const d of (pathVar ?? '').split(delimiter)) if (d && executable(join(d, name))) return join(d, name);
  return null;
}

export interface LaunchPaths {
  nodePath: string;
  /** true when only a versioned (upgrade-deleted) node path was found: init and doctor warn. */
  nodeVersioned: boolean;
  claudePath: string | null;
  /** PATH for the plist. */
  path: string;
  /** Environment for the plist (PATH, AGENTBRIDGE_CLAUDE_BIN). */
  environment: Record<string, string>;
}

export interface LaunchPathInput { pathVar: string | undefined; home: string; execPath: string; fixed?: readonly string[] }

/** Well-known stable locations, checked after PATH. */
export const STABLE_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] as const;

export function resolveLaunchPaths(i: LaunchPathInput): LaunchPaths {
  const fixed = i.fixed ?? STABLE_BIN_DIRS;
  const localBin = join(i.home, '.local', 'bin');
  // node: PATH's first stable node, then well-known stable dirs, then whatever runs us (warn if versioned)
  const pathDirs = (i.pathVar ?? '').split(delimiter).filter(Boolean);
  const candidates = [...pathDirs, ...fixed].map((d) => join(d, 'node')).filter(executable);
  const stable = candidates.find((p) => !isVersionedPath(p));
  const nodePath = stable ?? candidates[0] ?? i.execPath;
  const nodeVersioned = isVersionedPath(nodePath);
  const claudePath = whichOnPath('claude', i.pathVar) ?? [localBin, ...fixed].map((d) => join(d, 'claude')).find(executable) ?? null;
  const dirs = [dirname(nodePath), ...(claudePath ? [dirname(claudePath)] : []), localBin, ...fixed, '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const path = [...new Set(dirs)].join(delimiter);
  return { nodePath, nodeVersioned, claudePath, path, environment: { PATH: path, ...(claudePath ? { [CLAUDE_BIN_ENV]: claudePath } : {}) } };
}

/** `claude --version` with the path init recorded (plist env), falling back to `claude` on PATH. */
export function claudeVersionRunner(env: NodeJS.ProcessEnv = process.env): () => Promise<string> {
  const bin = env[CLAUDE_BIN_ENV] && existsSync(env[CLAUDE_BIN_ENV]!) ? env[CLAUDE_BIN_ENV]! : 'claude';
  return () => new Promise((resolve, reject) => {
    execFile(bin, ['--version'], { timeout: 10_000, env }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** ProgramArguments of a launchd plist (our renderer writes one <string> per line). */
export function plistProgram(plistPath: string): string[] | null {
  if (!existsSync(plistPath)) return null;
  const xml = readFileSync(plistPath, 'utf8');
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (!m) return [];
  const unescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return [...m[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((x) => unescape(x[1]!));
}

/** EnvironmentVariables of a launchd plist. */
export function plistEnvironment(plistPath: string): Record<string, string> | null {
  if (!existsSync(plistPath)) return null;
  const m = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(readFileSync(plistPath, 'utf8'));
  const out: Record<string, string> = {};
  if (m) for (const x of m[1]!.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) out[unescapeXml(x[1]!)] = unescapeXml(x[2]!);
  return out;
}
const unescapeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Does the installed plist already run node + entry with (at least) this environment? */
export function plistMatches(plistPath: string, o: { nodePath: string; entry: string; environment: Record<string, string> }): boolean {
  const prog = plistProgram(plistPath); const env = plistEnvironment(plistPath);
  if (!prog || !env || prog[0] !== o.nodePath || prog[1] !== o.entry) return false;
  return Object.entries(o.environment).every(([k, v]) => env[k] === v);
}

/** Doctor: the plist's node and entry exist, node runs, and node is not a versioned path. */
export async function launchdProgramChecks(plistPath: string, runNode: (node: string) => Promise<string> = nodeVersion): Promise<Array<{ id: string; ok: boolean; detail: string; fix?: string }>> {
  const prog = plistProgram(plistPath);
  if (prog === null) return []; // not installed: the launchd status check already says so
  const [node, entry] = prog;
  const fix = 'agentbridge init (rewrites the login service with current paths)';
  if (!node || !entry) return [{ id: 'launchd_program', ok: false, detail: `launchd plist ${plistPath} has no program`, fix }];
  if (!existsSync(node)) return [{ id: 'launchd_program', ok: false, detail: `launchd runs ${node}, which no longer exists (node upgraded?)`, fix }];
  if (!existsSync(entry)) return [{ id: 'launchd_program', ok: false, detail: `launchd runs ${entry}, which no longer exists (agentbridge moved or reinstalled?)`, fix }];
  let v: string;
  try { v = (await runNode(node)).trim(); } catch (e) { return [{ id: 'launchd_program', ok: false, detail: `${node} does not run: ${(e as Error).message}`, fix }]; }
  const out: Array<{ id: string; ok: boolean; detail: string; fix?: string }> = [{ id: 'launchd_program', ok: true, detail: `launchd runs ${node} (${v}) ${entry}` }];
  if (isVersionedPath(node)) out.push({ id: 'launchd_node_stable', ok: false, detail: `${node} is a versioned path; an upgrade will delete it and the bridge will stop starting at login`, fix: 'make a stable node (e.g. /opt/homebrew/bin/node) the first on PATH, then agentbridge init' });
  return out;
}

const nodeVersion = (node: string): Promise<string> => new Promise((resolve, reject) => {
  execFile(node, ['--version'], { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

/** `launchctl print gui/<uid>/<label>` → the job's state ("running", "spawn scheduled", …) and pid if it has one. */
export function parseLaunchctlJob(out: string): { state: string; pid: number | null } {
  const state = /^\s*state = (.+?)\s*$/m.exec(out)?.[1] ?? 'unknown';
  const pid = /^\s*pid = (\d+)\s*$/m.exec(out)?.[1];
  return { state, pid: pid ? Number(pid) : null };
}

/** The pid in run/bridge.lock if that process is alive (a stale lock counts as none). */
export function liveLockPid(lockPath: string, alive: (pid: number) => boolean): number | null {
  try { const pid = Number(readFileSync(lockPath, 'utf8').trim()); return Number.isInteger(pid) && pid > 1 && alive(pid) ? pid : null; } catch { return null; }
}

export interface LaunchdOwner { jobState: string | null; jobPid: number | null; lockPid: number | null }
/** Doctor: is the running bridge the launchd job, or a manually started one holding the lock instead? */
export function ownerCheck(o: LaunchdOwner): { id: string; ok: boolean; detail: string; fix?: string } | null {
  if (o.jobState === null) return null; // agent not loaded: the launchd status check reports it
  if (o.lockPid !== null && o.lockPid !== o.jobPid) {
    return { id: 'launchd_owner', ok: false, detail: `a manually started bridge is running instead of the launchd agent — run agentbridge init (manual bridge pid ${o.lockPid}; launchd job: ${o.jobState})`, fix: 'agentbridge init (hands the bridge over to launchd)' };
  }
  return o.jobPid !== null ? { id: 'launchd_owner', ok: true, detail: `the launchd agent runs the bridge (pid ${o.jobPid})` } : null;
}

/** Who runs the bridge: launchctl print of the job + the live lock pid. */
export function launchdOwner(serviceTarget: string, lockPath: string, alive: (pid: number) => boolean, launchctlPath = '/bin/launchctl'): Promise<LaunchdOwner> {
  return new Promise((resolve) => {
    execFile(launchctlPath, ['print', serviceTarget], { timeout: 10_000, encoding: 'utf8' }, (e, out) => {
      const job = e ? null : parseLaunchctlJob(String(out));
      resolve({ jobState: job?.state ?? null, jobPid: job?.pid ?? null, lockPid: liveLockPid(lockPath, alive) });
    });
  });
}
