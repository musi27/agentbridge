// `agentbridge init` (§14.1): idempotent, re-runnable setup on macOS. Every external effect goes through a seam
// (InitDeps) so tests run in a temp AGENTBRIDGE_HOME with fake claude, keychain, presence and launchd.
//
// Order: Claude Code → plugin → deny rules → crossSessionInbound → stop a running bridge → user presence (the one
// Touch ID check that authorises the local policy writes below) → keychain (one item; warn before a prompt) → identity → relay → approval mode →
// launchd agent → doctor → offer `add grok` → first try. Steps 6–9 hold the bridge lock (run/bridge.lock).
import { AUTO_MODE_WARNING, LIMITS, allSecretNames, type ApprovalMode, type DoctorCheck, type PresenceChecker, type SecretStore } from '@agentbridge/protocol';
import { installDenyRules, readEffectiveCrossSessionInbound, inboundFix, versionAtLeast, parseVersion, type SettingsPathOptions } from '@agentbridge/adapter-claude-code';
import type { Policy } from '../policy/policy.ts';
import type { LaunchPaths } from './launch-env.ts';
import { ensureIdentity, loadIdentity, registerIdentity, RelayHttpError } from '../relay/identity.ts';

export const PUBLIC_RELAY = 'https://relay.musi.live';
export const MARKETPLACE_NAME = 'agentbridge';
export const PLUGIN_ID = `agentbridge@${MARKETPLACE_NAME}`;

export interface CommandResult { code: number; stdout: string; stderr: string }
/** Runs `claude <args>`; never a shell. */
export type ClaudeRunner = (args: string[]) => Promise<CommandResult>;

/** Policy reads/writes for init (local DB + keychain while the bridge is stopped). */
export interface PolicyAccess {
  get(): Promise<Policy>;
  /** Re-signs exactly like `config set` (version + HMAC + snapshot via PolicyStore.set). */
  set(key: string, value: string): Promise<void>;
  close?(): void;
}

export interface ServiceControl {
  status(): Promise<'running' | 'stopped' | 'not_installed'>;
  /** `environment` goes into the plist (PATH, AGENTBRIDGE_CLAUDE_BIN). Re-running replaces the plist (idempotent). */
  install(opts: { nodePath: string; entry: string; logDir: string; environment: Record<string, string> }): Promise<void>;
  /** Stop a launchd-managed bridge (bootout) before local policy writes; the plist stays. */
  stopManaged(): Promise<void>;
  /** Start the installed plist again (bootstrap): restores a bridge init stopped. */
  startManaged(): Promise<void>;
  /** Does the installed plist already run this program with this environment? */
  plistMatches(opts: { nodePath: string; entry: string; logDir: string; environment: Record<string, string> }): Promise<boolean>;
  /** launchctl print: the job's state and pid (null when the agent is not loaded). */
  job(): Promise<{ state: string; pid: number | null } | null>;
  /** launchctl kickstart -k: (re)start the job now. */
  kickstart(): Promise<void>;
}

export interface Prompter {
  choose<T extends string>(question: string, options: ReadonlyArray<{ value: T; label: string }>, def: T): Promise<T>;
}

export interface InitDeps {
  claude: ClaudeRunner;
  secrets: SecretStore;
  presence: PresenceChecker;
  policy: () => Promise<PolicyAccess>;
  service: ServiceControl;
  /** Every secret name that may exist (SECRET_NAMES with the database's bot ids), for the keychain move. Optional. */
  secretNames?(): Promise<string[]>;
  /** Is a bridge answering on the socket? */
  bridgeRunning(): Promise<boolean>;
  /** The running bridge's version (IPC hello), or null when none answers. Optional: tests without one skip the check. */
  bridgeVersion?(): Promise<string | null>;
  /** This agentbridge's version: a running bridge on another version is restarted (upgrade, §14.1). */
  version?: string;
  /** Re-write the Codex block when `add codex` set it up before (null: not set up). Optional. */
  refreshCodex?(): { ok: boolean; changed: boolean; message: string } | null;
  /** Ask a manually started bridge to stop (IPC cli.stop; it runs its own presence check). */
  stopBridge(): Promise<void>;
  /** Start a bridge without the login service (restores a manually started bridge init stopped). */
  startBridge(): Promise<void>;
  /** A bridge another process started holds the lock: stop it if `pid` really is an agentbridge bridge. */
  stopForeignBridge(pid: number): Promise<boolean>;
  /** run/setup.lock while init changes things (on-demand starts wait). */
  marker: { write(): void; remove(): void };
  /** pid in run/bridge.lock if alive, else null. */
  lockPid(): number | null;
  sleep?: (ms: number) => Promise<void>;
  /** Wait for the launchd-started bridge to answer (true) or give up (false). */
  waitForBridge(): Promise<boolean>;
  doctor(): Promise<DoctorCheck[]>;
  /** Take the bridge's single-instance lock (run/bridge.lock); returns the release. Throws if a bridge holds it. */
  lock(): () => void;
  fetch: typeof fetch;
  prompt: Prompter;
  print(line: string): void;
  /** Folder holding .claude-plugin/marketplace.json, or a GitHub "owner/repo"; null = unknown. */
  marketplace: string | null;
  /** Claude Code user settings file for the deny rules (tests: a temp file). */
  claudeSettingsPath: string;
  settings?: SettingsPathOptions;
  home: string;
  service_entry: { entry: string | null; logDir: string };
  /** Stable node path, claude path and plist PATH, from the CLI's environment (launch-env.ts). */
  launchPaths(): LaunchPaths;
}

export interface InitOptions {
  relayUrl?: string;
  mode?: ApprovalMode;
  /** Non-interactive: keep current choices, never prompt. */
  yes?: boolean;
  skipPlugin?: boolean;
  skipService?: boolean;
  skipRelay?: boolean;
}

export interface InitStep { id: string; ok: boolean; detail: string; fix?: string; skipped?: boolean }
export interface InitReport { ok: boolean; steps: InitStep[]; userId: string | null }

const step = (s: InitStep, deps: InitDeps, steps: InitStep[]): InitStep => {
  steps.push(s);
  deps.print(`${s.skipped ? 'skip' : s.ok ? ' ok ' : 'FAIL'}  ${s.detail}${s.fix ? `\n      fix: ${s.fix}` : ''}`);
  return s;
};

export async function runInit(deps: InitDeps, o: InitOptions = {}): Promise<InitReport> {
  const steps: InitStep[] = [];
  let userId: string | null = null;

  // 1. Claude Code version (§11.2)
  try {
    const r = await deps.claude(['--version']);
    const v = parseVersion(r.stdout);
    const ok = r.code === 0 && v !== null && versionAtLeast(r.stdout, LIMITS.minClaudeCodeVersion);
    step({ id: 'claude_code', ok, detail: v ? `Claude Code ${v.join('.')} (need ≥ ${LIMITS.minClaudeCodeVersion})` : 'could not read `claude --version`', ...(ok ? {} : { fix: 'install or update Claude Code: claude update' }) }, deps, steps);
  } catch (e) {
    step({ id: 'claude_code', ok: false, detail: `\`claude\` not found (${(e as Error).message})`, fix: 'install Claude Code and make sure `claude` is on PATH' }, deps, steps);
  }

  // 2. plugin from the in-repo marketplace, user scope
  const addCmd = deps.marketplace ? ['plugin', 'marketplace', 'add', deps.marketplace] : null;
  const installCmd = ['plugin', 'install', PLUGIN_ID, '--scope', 'user'];
  const shown = (a: string[]): string => `claude ${a.map((x) => (/[\s"']/.test(x) ? JSON.stringify(x) : x)).join(' ')}`;
  if (o.skipPlugin) step({ id: 'plugin', ok: true, skipped: true, detail: 'plugin install skipped (--skip-plugin)' }, deps, steps);
  else if (!addCmd) step({ id: 'plugin', ok: false, detail: 'could not find the agentbridge plugin marketplace', fix: `${shown(['plugin', 'marketplace', 'add', '<path to the agentbridge repo>'])} && ${shown(installCmd)}` }, deps, steps);
  else {
    try {
      const a = await deps.claude(addCmd);
      const already = /already/i.test(`${a.stdout}${a.stderr}`);
      if (a.code !== 0 && !already) throw new Error((a.stderr || a.stdout).trim().slice(0, 200) || `exit ${a.code}`);
      const i = await deps.claude(installCmd);
      if (i.code !== 0 && !/already/i.test(`${i.stdout}${i.stderr}`)) throw new Error((i.stderr || i.stdout).trim().slice(0, 200) || `exit ${i.code}`);
      step({ id: 'plugin', ok: true, detail: `plugin ${PLUGIN_ID} installed (user scope); restart open Claude Code sessions to load it` }, deps, steps);
    } catch (e) {
      step({ id: 'plugin', ok: false, detail: `plugin install failed: ${(e as Error).message}`, fix: `${shown(addCmd)} && ${shown(installCmd)}` }, deps, steps);
    }
  }

  // 3. deny rules in the user's Claude Code settings (§11.4; plugins cannot ship them, M0 V4)
  try {
    const r = installDenyRules(deps.claudeSettingsPath);
    step({ id: 'deny_rules', ok: true, detail: r.added.length ? `added ${r.added.length} deny rules to ${r.path}` : `deny rules already present in ${r.path}` }, deps, steps);
  } catch (e) {
    step({ id: 'deny_rules', ok: false, detail: `could not write deny rules: ${(e as Error).message}`, fix: `add the rules listed in SPEC §11.4 to ${deps.claudeSettingsPath}` }, deps, steps);
  }

  // 4. effective crossSessionInbound (§11.3): hold/refuse make our posts vanish
  const eff = readEffectiveCrossSessionInbound(deps.home, { ...deps.settings });
  step({ id: 'cross_session_inbound', ok: eff.value === 'accept', detail: `crossSessionInbound = ${eff.value} (${eff.decidedBy})`, ...(eff.value === 'accept' ? {} : { fix: inboundFix(eff) }) }, deps, steps);

  // 5. user presence (§9.2): verifies the helper works and authorises init's changes. Before anything is stopped or written.
  const pr = await deps.presence.check('finish setting up on this Mac');
  if (!pr.ok) {
    step({ id: 'presence', ok: false, detail: `user presence check failed (${pr.code}${pr.detail ? `: ${pr.detail}` : ''})`, fix: pr.code === 'unavailable' ? 'build the helper: npm run build:helper -w @agentbridge/presence' : 'run agentbridge init again and approve the Touch ID / password prompt' }, deps, steps);
    return { ok: false, steps, userId };
  }
  step({ id: 'presence', ok: true, detail: 'Touch ID / password check works' }, deps, steps);

  // 5b. keychain: all secrets live in one item. Say so before macOS is likely to ask for the login password (old
  // one-per-secret items to move, or an item this helper isn't trusted for yet). A running older bridge may still
  // read the old items, so they are only copied here; the bridge deletes them when it starts on this version.
  if (deps.secrets.prepare) {
    try {
      const r = await deps.secrets.prepare({ legacyNames: (await deps.secretNames?.()) ?? allSecretNames([]), notice: (l) => deps.print(l), keepLegacy: await deps.bridgeRunning(), interactive: true });
      if (r.copied > 0) step({ id: 'keychain', ok: true, detail: `moved ${r.copied} saved keys into one keychain item ("agentbridge: saved keys")` }, deps, steps);
      // not an init failure: the keys are already moved; doctor shows the command to delete what macOS kept
      if (r.kept) step({ id: 'keychain_old_items', ok: true, detail: `${r.kept} old keychain item(s) left (macOS refused to delete them; their keys are already moved); agentbridge doctor shows how to delete them` }, deps, steps);
    } catch (e) {
      step({ id: 'keychain', ok: false, detail: `keychain: ${(e as Error).message}`, fix: 'run agentbridge init again; if macOS asks for your login password, enter it and choose Always Allow' }, deps, steps);
      return { ok: false, steps, userId };
    }
  }

  // 6. plan from the current state (read-only; the bridge may be running)
  const policy = await deps.policy();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let markerWritten = false;
  let stopped: 'managed' | 'manual' | null = null;
  let restarted = false;
  /** Never leave things worse (§14.1): bring back what init stopped, unless the new service already runs. */
  const restore = async (): Promise<void> => {
    if (restarted || !stopped) return;
    try { if (stopped === 'managed') await deps.service.startManaged(); else await deps.startBridge(); restarted = true; step({ id: 'restore', ok: true, detail: 'restarted the bridge as it was before init' }, deps, steps); }
    catch (e) { step({ id: 'restore', ok: false, detail: `could not restart the previous bridge: ${(e as Error).message}`, fix: 'agentbridge start' }, deps, steps); }
  };
  try {
    const cur = await policy.get();
    const known = await loadIdentity(deps.secrets).catch(() => null);
    deps.print(`current: relay ${cur.transport.relay_url}, approval mode ${cur.approval.mode}, identity ${known ? known.userId : 'none yet'} — only changes are written`);
    deps.print([
      '',
      'Approval mode:',
      '  per_conversation (default): you approve every conversation in Claude Code\'s prompt.',
      '  auto: conversations matching an allow rule (agentbridge config set allowlist.add "allow claude:* -> grok:*") need no approval;',
      '        Grok-started conversations still need it on the public relay.',
      `Claude Code's own auto permission mode weakens local protection: agentbridge warns in such sessions ("${AUTO_MODE_WARNING}").`,
      'Use default mode for sessions that talk to other agents.',
    ].join('\n'));
    const mode = o.mode ?? (o.yes ? cur.approval.mode : await deps.prompt.choose('Approval mode', [{ value: 'per_conversation', label: 'per_conversation (recommended)' }, { value: 'auto', label: 'auto (allow rules)' }] as const, cur.approval.mode));
    const relayUrl = o.relayUrl ?? cur.transport.relay_url;
    const writes = [...(known ? [] : ['identity']), ...(!o.skipRelay && relayUrl !== cur.transport.relay_url ? ['relay_url'] : []), ...(mode !== cur.approval.mode ? ['approval_mode'] : [])];
    const lp = o.skipService || !deps.service_entry.entry ? null : deps.launchPaths();
    const svcOpts = lp ? { nodePath: lp.nodePath, entry: deps.service_entry.entry!, logDir: deps.service_entry.logDir, environment: lp.environment } : null;
    const serviceStatus = await deps.service.status();
    // a manually started bridge holding the lock while launchd's job can't start (it exits on AlreadyRunning) also needs fixing
    const job0 = svcOpts ? await deps.service.job() : null;
    const holder0 = deps.lockPid();
    const manualHolds = !!svcOpts && holder0 !== null && holder0 !== (job0?.pid ?? null);
    const running = await deps.bridgeRunning();
    // after `npm install -g` the plist is unchanged but the bridge still runs the old code: restart it on this version
    const runningVersion = running && deps.version && deps.bridgeVersion ? await deps.bridgeVersion().catch(() => null) : null;
    const stale = !!runningVersion && runningVersion !== deps.version;
    if (stale) deps.print(`the running bridge is ${runningVersion}; this agentbridge is ${deps.version}: init will restart it`);
    const needService = !!svcOpts && (stale || serviceStatus !== 'running' || manualHolds || !(await deps.service.plistMatches(svcOpts)));

    // 7. while init changes things, on-demand starts (plugin SessionStart hook, `agentbridge start`) must not race it
    if (writes.length || needService) { deps.marker.write(); markerWritten = true; }

    /** Wait until launchd reports `state = running` with the pid that holds the bridge lock (~10 s). */
    const handover = async (): Promise<{ ok: true; pid: number; handedOver: boolean } | { ok: false; detail: string }> => {
      let handedOver = false; let job: { state: string; pid: number | null } | null = null; let holder: number | null = null;
      for (let n = 0; n < 20; n++) {
        job = await deps.service.job(); holder = deps.lockPid();
        if (job?.state === 'running' && job.pid !== null && job.pid === holder) return { ok: true, pid: job.pid, handedOver };
        if (holder !== null && holder !== job?.pid && !handedOver) {
          // the lock belongs to a bridge launchd didn't start: stop it if it is agentbridge's, then start the job now
          if (!(await deps.stopForeignBridge(holder))) return { ok: false, detail: `the bridge lock is held by pid ${holder}, which is not an agentbridge bridge` };
          handedOver = true;
          await deps.service.kickstart();
          continue;
        }
        await sleep(500);
      }
      return { ok: false, detail: `launchd reports ${job ? `state = ${job.state}${job.pid !== null ? `, pid ${job.pid}` : ''}` : 'the agent as not loaded'}; the bridge lock is held by ${holder !== null ? `pid ${holder}` : 'nobody'}` };
    };

    const setIfChanged = async (key: string, value: string, current: string): Promise<boolean> => { if (value === current) return false; await policy.set(key, value); return true; };
    const configure = async (): Promise<boolean> => {
      // identity keys in the keychain (§13.2, §15.5)
      let identity;
      try {
        const r = await ensureIdentity(deps.secrets);
        identity = r.identity; userId = identity.userId;
        step({ id: 'identity', ok: true, detail: `${r.created ? 'created' : 'found'} identity ${identity.userId} (keys in the keychain)` }, deps, steps);
      } catch (e) {
        step({ id: 'identity', ok: false, detail: `identity: ${(e as Error).message}`, fix: 'agentbridge identity rotate' }, deps, steps);
        return false;
      }
      // relay: register the identity (idempotent) and record transport.relay_url (§13.2, §13.6)
      if (o.skipRelay) step({ id: 'relay', ok: true, skipped: true, detail: `relay registration skipped (--skip-relay); relay ${relayUrl}` }, deps, steps);
      else {
        try {
          const r = await registerIdentity(relayUrl, identity, deps.fetch);
          const changed = await setIfChanged('transport.relay_url', relayUrl, cur.transport.relay_url);
          const selfHosted = new URL(relayUrl).host !== new URL(PUBLIC_RELAY).host;
          step({ id: 'relay', ok: true, detail: `${r.created ? 'registered with' : 'already registered with'} ${relayUrl}${changed ? ' (saved as transport.relay_url)' : ''}${selfHosted ? ' — not the public relay: treated as self-hosted (§13.6)' : ''}` }, deps, steps);
        } catch (e) {
          const conflict = e instanceof RelayHttpError && e.status === 409;
          step({ id: 'relay', ok: false, detail: `relay registration with ${relayUrl} failed: ${(e as Error).message}`, fix: conflict ? 'this relay knows another key for this identity: agentbridge identity rotate' : 'check your network and run agentbridge init again' }, deps, steps);
        }
      }
      // approval mode (§7.2, §8.4)
      const changedMode = await setIfChanged('approval.mode', mode, cur.approval.mode);
      step({ id: 'approval_mode', ok: true, detail: `approval mode ${mode}${changedMode ? ' (changed)' : ''}; change later with agentbridge config set approval.mode …` }, deps, steps);
      return true;
    };

    if (writes.length === 0) {
      // 8a. nothing to write: no need to stop the bridge
      step({ id: 'plan', ok: true, detail: `identity, relay and approval mode are already set; ${stale && needService ? `the bridge is restarted on ${deps.version} below` : 'the bridge keeps running'}` }, deps, steps);
      if (!(await configure())) return { ok: false, steps, userId };
    } else {
      // 8b. stop the bridge (launchd: bootout, keeping the plist) so its in-memory state can't overwrite the writes,
      // then take its single-instance lock right away, so nothing starts mid-write
      step({ id: 'plan', ok: true, detail: `will change: ${writes.join(', ')}` }, deps, steps);
      if (running) {
        try {
          if (serviceStatus === 'running') { await deps.service.stopManaged(); stopped = 'managed'; } else { await deps.stopBridge(); stopped = 'manual'; }
          step({ id: 'stop_bridge', ok: true, detail: 'stopped the running bridge for setup' }, deps, steps);
        } catch (e) {
          step({ id: 'stop_bridge', ok: false, detail: `could not stop the running bridge: ${(e as Error).message}`, fix: 'agentbridge stop, then run agentbridge init again' }, deps, steps);
          await restore();
          return { ok: false, steps, userId };
        }
      }
      let release: (() => void) | null = null; let lastErr: unknown = null; let killedOnce = false;
      for (let attempt = 1; release === null; attempt++) {
        try { release = deps.lock(); break; } catch (e) { lastErr = e; }
        const pid = (lastErr as { pid?: unknown }).pid;
        if (typeof pid !== 'number') break; // not "already running": a filesystem problem
        if (attempt % 25 !== 0) { await sleep(200); continue; } // ~5 s: the old process may still be exiting
        if (killedOnce) break;
        killedOnce = true; // something else started a bridge: stop it if it is ours, then one more try
        if (!(await deps.stopForeignBridge(pid))) break;
      }
      if (release === null) {
        const running2 = typeof (lastErr as { pid?: unknown })?.pid === 'number';
        step({ id: 'lock', ok: false, detail: `could not take the bridge lock: ${(lastErr as Error)?.message ?? 'unknown error'}`, fix: running2 ? 'a bridge is still running and would not stop: agentbridge stop (or quit the process holding ~/.agentbridge/run/bridge.lock), then run agentbridge init again' : 'check that ~/.agentbridge/run is writable, then run agentbridge init again' }, deps, steps);
        await restore();
        return { ok: false, steps, userId };
      }
      let ok: boolean;
      try { ok = await configure(); } finally { release(); }
      if (!ok) { await restore(); return { ok: false, steps, userId }; }
    }

    // 9. login service (launchd agent): rewritten and (re)started only when its plist or state needs it
    if (o.skipService && stale && !stopped) step({ id: 'service', ok: false, detail: `launchd agent skipped (--skip-service), so the bridge still runs ${runningVersion}`, fix: 'agentbridge stop, then agentbridge start' }, deps, steps);
    else if (o.skipService) step({ id: 'service', ok: true, skipped: true, detail: 'launchd agent skipped (--skip-service); start the bridge with agentbridge start' }, deps, steps);
    else if (!svcOpts || !lp) step({ id: 'service', ok: false, detail: 'the built service entry is missing', fix: 'npm run build, then agentbridge init again' }, deps, steps);
    else if (!needService && !stopped) step({ id: 'service', ok: true, detail: `launchd agent up to date and running (node ${lp.nodePath})` }, deps, steps);
    else {
      try {
        await deps.service.install(svcOpts);
        restarted = true;
        // success only when launchd's own job runs the bridge: hand over from a manually started bridge (ours) if needed
        const h = await handover();
        const up = h.ok && await deps.waitForBridge();
        const notes = [`node ${lp.nodePath}`, lp.claudePath ? `claude ${lp.claudePath}` : 'claude not found (doctor will report it)'];
        step({ id: 'service', ok: up, detail: up ? `launchd agent installed; launchd runs the bridge (pid ${h.pid}; ${notes.join(', ')})${h.handedOver ? ' — took over from a manually started bridge' : ''}${stale ? ` — restarted on ${deps.version} (was ${runningVersion})` : ''}` : `launchd agent installed but ${h.ok ? 'the bridge did not answer' : h.detail}`, ...(up ? {} : { fix: `see ${deps.service_entry.logDir}/bridge.err.log, then agentbridge init again` }) }, deps, steps);
      } catch (e) {
        step({ id: 'service', ok: false, detail: `launchd agent: ${(e as Error).message}`, fix: 'agentbridge start (runs the bridge without the login service)' }, deps, steps);
      }
    }
    if (lp?.nodeVersioned) step({ id: 'service_node', ok: false, detail: `only a versioned node was found (${lp.nodePath}); an upgrade will delete it and the bridge will stop starting at login`, fix: 'put a stable node first on PATH (e.g. /opt/homebrew/bin/node), then agentbridge init again' }, deps, steps);
    await restore(); // e.g. a manual bridge stopped with --skip-service, or a failed install
  } catch (e) {
    await restore();
    throw e;
  } finally {
    if (markerWritten) { try { deps.marker.remove(); } catch { /* best effort */ } }
    try { policy.close?.(); } catch { /* closing */ }
  }

  // 10. Codex CLI: refresh the managed block when `add codex` set it up (paths or hooks may change between releases)
  if (deps.refreshCodex) {
    try {
      const c = deps.refreshCodex();
      if (c) step({ id: 'codex', ok: c.ok, detail: c.changed ? `${c.message}; restart open Codex sessions to load it` : c.message, ...(c.ok ? {} : { fix: 'agentbridge add codex' }) }, deps, steps);
    } catch (e) {
      step({ id: 'codex', ok: false, detail: `could not refresh the Codex setup: ${(e as Error).message}`, fix: 'agentbridge add codex' }, deps, steps);
    }
  }

  // 11. doctor (needs the running bridge)
  if (!(await deps.bridgeRunning())) step({ id: 'doctor', ok: true, skipped: true, detail: 'doctor skipped: the bridge is not running', fix: 'agentbridge start, then agentbridge doctor' }, deps, steps);
  else try {
    const checks = await deps.doctor();
    const bad = checks.filter((c) => !c.ok);
    step({ id: 'doctor', ok: bad.length === 0, detail: bad.length === 0 ? `doctor: ${checks.length} checks ok` : `doctor: ${bad.length} of ${checks.length} checks need attention (${bad.map((c) => c.id).join(', ')})`, ...(bad.length ? { fix: 'agentbridge doctor' } : {}) }, deps, steps);
  } catch (e) {
    step({ id: 'doctor', ok: false, detail: `doctor could not run: ${(e as Error).message}`, fix: 'agentbridge doctor' }, deps, steps);
  }

  // 12. offer Grok, 13. first try
  deps.print([
    '',
    'Connect a Grok bot (about 4 minutes): agentbridge add grok',
    'First try: open a Claude Code session (restart it if it was open) and ask:',
    '  "use agentbridge to list the agents you can talk to"',
  ].join('\n'));
  return { ok: steps.every((s) => s.ok), steps, userId };
}
