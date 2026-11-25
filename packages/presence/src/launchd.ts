import type { ServiceManager } from '@agentbridge/protocol';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { run, type Runner } from './exec.ts';

export const LAUNCHD_LABEL = 'live.musi.agentbridge';

export interface PlistInput {
  label: string;
  programArguments: readonly string[];
  stdoutPath: string;
  stderrPath: string;
  workingDirectory?: string;
  environment?: Readonly<Record<string, string>>;
}

export function xmlEscape(s: string): string {
  // Control characters other than tab/LF/CR are not allowed in XML 1.0 at all.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(s)) throw new TypeError('string contains characters not representable in a plist');
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const str = (s: string) => `<string>${xmlEscape(s)}</string>`;

/** Renders the launch agent plist (§14.1): RunAtLoad + KeepAlive, logs into the log dir. */
export function renderPlist(p: PlistInput): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(p.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...p.programArguments.map((a) => `    ${str(a)}`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    // Restart after crashes, but not after a clean exit (e.g. `agentbridge stop`).
    '  <key>KeepAlive</key>',
    '  <dict><key>SuccessfulExit</key><false/></dict>',
    // Restart no more than every 10 s if it crash-loops (launchd's default, made explicit).
    '  <key>ThrottleInterval</key><integer>10</integer>',
    '  <key>ProcessType</key><string>Interactive</string>',
    `  <key>StandardOutPath</key>${str(p.stdoutPath)}`,
    `  <key>StandardErrorPath</key>${str(p.stderrPath)}`,
  ];
  if (p.workingDirectory !== undefined) lines.push(`  <key>WorkingDirectory</key>${str(p.workingDirectory)}`);
  if (p.environment !== undefined && Object.keys(p.environment).length > 0) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const [k, v] of Object.entries(p.environment)) lines.push(`    <key>${xmlEscape(k)}</key>${str(v)}`);
    lines.push('  </dict>');
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

export interface LaunchdServiceManagerOptions {
  label?: string;
  /** Default ~/Library/LaunchAgents. Tests point this at a temp dir. */
  launchAgentsDir?: string;
  uid?: number;
  runner?: Runner;
  launchctlPath?: string;
  /** Extra environment for the job (never secrets). */
  environment?: Readonly<Record<string, string>>;
  /** Wait between bootstrap retries after a bootout (launchd tears jobs down asynchronously). */
  retryDelayMs?: number;
}

export type LaunchdStatus = 'running' | 'stopped' | 'not_installed';

/** Set in the job's environment so the service can tell it runs under launchd (see createNotifier). */
export const LAUNCHD_ENV_FLAG = 'AGENTBRIDGE_LAUNCHD';
/** `launchctl bootout` exit codes meaning "not loaded": ESRCH (3) and launchd's "no such service" (113). */
const NOT_LOADED = new Set([3, 113]);

/** Parses `launchctl print gui/<uid>/<label>` output. */
export function parseLaunchctlPrint(out: string): 'running' | 'stopped' {
  return /^\s*state = running\s*$/m.test(out) ? 'running' : 'stopped';
}

export class LaunchdServiceManager implements ServiceManager {
  readonly label: string;
  readonly plistPath: string;
  readonly #domain: string;
  readonly #opts: LaunchdServiceManagerOptions;

  constructor(opts: LaunchdServiceManagerOptions = {}) {
    this.#opts = opts;
    this.label = opts.label ?? LAUNCHD_LABEL;
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(this.label)) throw new TypeError(`invalid launchd label: ${this.label}`);
    const dir = opts.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents');
    this.plistPath = join(dir, `${this.label}.plist`);
    const uid = opts.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error('launchd requires a POSIX uid');
    this.#domain = `gui/${uid}`;
  }

  get serviceTarget(): string { return `${this.#domain}/${this.label}`; }

  #launchctl(...args: string[]) {
    return (this.#opts.runner ?? run)(this.#opts.launchctlPath ?? '/bin/launchctl', args, { timeoutMs: 30_000 });
  }

  async install(opts: { nodePath: string; entry: string; logDir: string }): Promise<void> {
    for (const [k, v] of Object.entries(opts)) if (!isAbsolute(v)) throw new TypeError(`${k} must be an absolute path: ${v}`);
    await this.installProgram({
      programArguments: [opts.nodePath, opts.entry], logDir: opts.logDir, logName: 'bridge',
      // launchd's default PATH is minimal; make it explicit, with node's own directory first.
      environment: { PATH: `${dirname(opts.nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`, [LAUNCHD_ENV_FLAG]: '1', ...this.#opts.environment },
    });
  }

  /**
   * Writes the plist for any program (RunAtLoad + KeepAlive on crash, logs `<logDir>/<logName>.{out,err}.log`) and
   * (re)loads it. `install` (the bridge) and the agent panel's login item both use it.
   */
  async installProgram(opts: { programArguments: readonly string[]; logDir: string; logName: string; environment?: Readonly<Record<string, string>> }): Promise<void> {
    if (!isAbsolute(opts.logDir)) throw new TypeError(`logDir must be an absolute path: ${opts.logDir}`);
    if (!/^[a-z][a-z0-9-]*$/.test(opts.logName)) throw new TypeError(`invalid log name: ${opts.logName}`);
    await mkdir(opts.logDir, { recursive: true, mode: 0o700 });
    const plist = renderPlist({
      label: this.label,
      programArguments: opts.programArguments,
      stdoutPath: join(opts.logDir, `${opts.logName}.out.log`),
      stderrPath: join(opts.logDir, `${opts.logName}.err.log`),
      ...(opts.environment ? { environment: opts.environment } : {}),
    });
    const dir = join(this.plistPath, '..');
    await mkdir(dir, { recursive: true });
    const tmp = `${this.plistPath}.${process.pid}.tmp`;
    await writeFile(tmp, plist, { mode: 0o644 });
    await rename(tmp, this.plistPath);
    // Replace a loaded older definition; "not loaded" is fine.
    await this.#bootout();
    let last = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = await this.#launchctl('bootstrap', this.#domain, this.plistPath);
      if (r.code === 0) return;
      last = `${r.stderr}${r.stdout}`.trim();
      // EIO (5) / EALREADY (37) while the previous instance is still being torn down.
      if (r.code !== 5 && r.code !== 37) break;
      await new Promise((res) => setTimeout(res, this.#opts.retryDelayMs ?? 300));
    }
    throw new Error(`launchctl bootstrap ${this.#domain} ${this.plistPath} failed: ${last}`);
  }

  /**
   * bootout + delete the plist. `fileFirst` deletes the plist before the bootout: for a job that asks to remove
   * itself (the panel's "Turn off"), whose own process tree the bootout ends, so nothing is left to load at login.
   */
  async uninstall(opts: { fileFirst?: boolean } = {}): Promise<void> {
    if (opts.fileFirst) { await rm(this.plistPath, { force: true }); await this.#bootout(); return; }
    await this.#bootout();
    await rm(this.plistPath, { force: true });
  }

  async #bootout(): Promise<void> {
    const r = await this.#launchctl('bootout', this.serviceTarget);
    if (r.code === 0 || (r.code !== null && NOT_LOADED.has(r.code))) return;
    throw new Error(`launchctl bootout ${this.serviceTarget} failed (exit ${r.code}): ${`${r.stderr}${r.stdout}`.trim()}`);
  }

  async status(): Promise<LaunchdStatus> {
    try {
      await stat(this.plistPath);
    } catch {
      return 'not_installed';
    }
    const r = await this.#launchctl('print', this.serviceTarget);
    if (r.code !== 0) return 'stopped';
    return parseLaunchctlPrint(r.stdout);
  }
}
