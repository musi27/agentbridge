// `agentbridge uninstall` (§14.1): undo what `init` set up on this Mac. Privileged (one user-presence check, run here
// because the bridge may not be running), safe to re-run, and never depends on the bridge. Every external effect goes
// through UninstallDeps so tests run against temp dirs with fake launchctl, claude and keychain.
//
// Order: presence → setup marker (blocks on-demand starts) → plugin + marketplace → launchd agent → menu-bar panel agent → a manually started
// bridge → deny rules → (--purge-data) Keychain items, then the data folder → Grok-side and npm steps for the user.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { GROK_CONNECTORS_URL, allSecretNames, type PresenceChecker, type SecretStore } from '@agentbridge/protocol';
import { removeDenyRules } from '@agentbridge/adapter-claude-code';
import { MARKETPLACE_NAME, PLUGIN_ID, type ClaudeRunner } from './init.ts';
import type { Paths } from '../paths.ts';

export const NPM_PACKAGE = '@musi27/agentbridge';
export const KEYCHAIN_SERVICE = 'agentbridge';

export interface UninstallDeps {
  presence: PresenceChecker;
  /** The launchd login agent: uninstall = bootout + delete the plist; both are no-ops when absent. */
  service: { status(): Promise<'running' | 'stopped' | 'not_installed'>; uninstall(): Promise<void>; readonly plistPath: string };
  /** The menu-bar panel's login item (live.musi.agentbridge.panel): always removed, same shape as `service`. */
  panel?: { status(): Promise<'running' | 'stopped' | 'not_installed'>; uninstall(): Promise<void>; readonly plistPath: string };
  claude: ClaudeRunner;
  /** Claude Code user settings file holding the deny rules (tests: a temp file). */
  claudeSettingsPath: string;
  paths: Paths;
  /** pid in run/bridge.lock if alive, else null. */
  lockPid(): number | null;
  /** SIGTERM `pid` only if it really is an agentbridge bridge; true once it has exited. */
  stopForeignBridge(pid: number): Promise<boolean>;
  /** run/setup.lock: while it exists, the plugin's on-demand `agentbridge start` waits instead of starting a bridge. */
  marker: { write(): void; remove(): void };
  /** Only called with --purge-data. */
  secrets(): Promise<SecretStore>;
  /** The user's home folder: never deleted, even if --home points at it. */
  homeDir: string;
  print(line: string): void;
}

export interface UninstallOptions { purgeData?: boolean }

export type StepStatus = 'removed' | 'absent' | 'left' | 'failed';
export interface UninstallStep { id: string; status: StepStatus; detail: string; fix?: string }
export interface UninstallReport { ok: boolean; steps: UninstallStep[]; manual: string[] }

const LABEL: Record<StepStatus, string> = { removed: 'removed', absent: 'absent ', left: 'left   ', failed: 'FAIL   ' };
const shown = (a: string[]): string => `claude ${a.join(' ')}`;
const notFound = (r: { stdout: string; stderr: string }): boolean => /not found|not installed|no such|does not exist/i.test(`${r.stdout}${r.stderr}`);

/** The secret names agentbridge writes; per-bot names need the bot ids from the database. */
export function secretNames(botIds: readonly string[]): string[] { return allSecretNames(botIds); }

/** Why `root` must not be deleted, or null when it looks like an agentbridge data folder. */
export function unsafeDataRoot(root: string, homeDir: string): string | null {
  const r = resolve(root); const h = resolve(homeDir);
  if (r === sep || r === h || (h + sep).startsWith(r + sep)) return `${r} is your home folder or one of its parents`;
  if (basename(r) === '.agentbridge') return null;
  const entries = readdirSync(r);
  if (entries.length === 0 || entries.includes('agentbridge.db') || entries.includes('run')) return null;
  return `${r} does not look like an agentbridge data folder (no agentbridge.db or run/)`;
}

export async function runUninstall(deps: UninstallDeps, o: UninstallOptions = {}): Promise<UninstallReport> {
  const steps: UninstallStep[] = [];
  const step = (s: UninstallStep): void => {
    steps.push(s);
    deps.print(`${LABEL[s.status]}  ${s.detail}${s.fix ? `\n         fix: ${s.fix}` : ''}`);
  };
  const manual = [
    `In Grok: delete the agentbridge connector at ${GROK_CONNECTORS_URL} (signed in: open the connector, then Remove) and the "Inbox from agentbridge" routine for each bot you added. Do it yourself: agentbridge cannot reach them and Grok will not delete them. If you reinstall later, a leftover connector keeps sending Grok's replies to an address no bridge reads.`,
    `Last: npm uninstall -g ${NPM_PACKAGE}`,
  ];

  // 1. user presence (§9.2): nothing changes without the human
  const pr = await deps.presence.check(o.purgeData ? 'uninstall itself and delete all its data' : 'uninstall itself from this Mac');
  if (!pr.ok) {
    step({ id: 'presence', status: 'failed', detail: `user presence check failed (${pr.code}${pr.detail ? `: ${pr.detail}` : ''}); nothing was changed`, fix: pr.code === 'unavailable' ? 'the Touch ID helper is missing; follow the manual steps in docs/troubleshooting.md ("Uninstall")' : 'run agentbridge uninstall again and approve the Touch ID / password prompt' });
    return { ok: false, steps, manual: [] };
  }

  // 2. keep the plugin's SessionStart hook from starting a bridge on demand while we take things apart
  let marker = false;
  if (existsSync(deps.paths.root)) { try { deps.marker.write(); marker = true; } catch { /* best effort */ } }

  try {
    // 3. Claude Code plugin, then its marketplace
    const uninstallCmd = ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'];
    const removeCmd = ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME];
    for (const [id, cmd, what] of [['plugin', uninstallCmd, `Claude Code plugin ${PLUGIN_ID}`], ['marketplace', removeCmd, `Claude Code marketplace ${MARKETPLACE_NAME}`]] as const) {
      try {
        const r = await deps.claude([...cmd]);
        if (r.code === 0) step({ id, status: 'removed', detail: what });
        else if (notFound(r)) step({ id, status: 'absent', detail: `${what} (not installed)` });
        else step({ id, status: 'failed', detail: `${what}: ${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}`, fix: shown([...cmd]) });
      } catch (e) {
        step({ id, status: 'failed', detail: `${what}: ${(e as Error).message}`, fix: shown([...cmd]) });
      }
    }

    // 4. launchd login agent (bootout stops a launchd-run bridge; the plist is deleted)
    try {
      const before = await deps.service.status();
      await deps.service.uninstall();
      step(before === 'not_installed' ? { id: 'launchd', status: 'absent', detail: `launchd agent (${deps.service.plistPath} not present)` } : { id: 'launchd', status: 'removed', detail: `launchd agent and ${deps.service.plistPath}` });
    } catch (e) {
      step({ id: 'launchd', status: 'failed', detail: `launchd agent: ${(e as Error).message}`, fix: `launchctl bootout gui/$(id -u)/live.musi.agentbridge; rm ${deps.service.plistPath}` });
    }

    // 4b. the menu-bar panel's login agent (bootout quits the panel; the plist is deleted)
    if (deps.panel) {
      try {
        const before = await deps.panel.status();
        await deps.panel.uninstall();
        step(before === 'not_installed' ? { id: 'panel', status: 'absent', detail: `menu-bar panel (${deps.panel.plistPath} not present)` } : { id: 'panel', status: 'removed', detail: `menu-bar panel and ${deps.panel.plistPath}` });
      } catch (e) {
        step({ id: 'panel', status: 'failed', detail: `menu-bar panel: ${(e as Error).message}`, fix: `launchctl bootout gui/$(id -u)/live.musi.agentbridge.panel; rm ${deps.panel.plistPath}` });
      }
    }

    // 5. a bridge still holding the lock (started by hand or by the plugin, or the launchd one still exiting)
    const pid = deps.lockPid();
    if (pid === null) step({ id: 'bridge', status: 'absent', detail: 'running bridge (none)' });
    else if (await deps.stopForeignBridge(pid)) step({ id: 'bridge', status: 'removed', detail: `running bridge (stopped pid ${pid})` });
    else step({ id: 'bridge', status: 'failed', detail: `could not stop the process holding the bridge lock (pid ${pid})`, fix: `check it with: ps -p ${pid} -o command=; then kill ${pid}` });

    // 6. the §11.4 deny rules init wrote; everything else in the settings file stays as it is
    try {
      const r = removeDenyRules(deps.claudeSettingsPath);
      step(r.removed.length ? { id: 'deny_rules', status: 'removed', detail: `${r.removed.length} agentbridge deny rules from ${r.path}` } : { id: 'deny_rules', status: 'absent', detail: `agentbridge deny rules (none in ${r.path})` });
    } catch (e) {
      step({ id: 'deny_rules', status: 'failed', detail: `deny rules: ${(e as Error).message}`, fix: `remove the "Bash(agentbridge …)" and "Edit(~/.agentbridge/**)" entries from permissions.deny in ${deps.claudeSettingsPath}` });
    }

    // 7. data: only with --purge-data
    const root = deps.paths.root;
    if (!o.purgeData) {
      step({ id: 'keychain', status: 'left', detail: `saved keys in the Keychain, service "${KEYCHAIN_SERVICE}" (identity keys, policy key, bot tokens)`, fix: 'agentbridge uninstall --purge-data' });
      if (existsSync(root)) step({ id: 'data', status: 'left', detail: `${root} (conversation history, policy, logs)`, fix: 'agentbridge uninstall --purge-data' });
      else step({ id: 'data', status: 'absent', detail: `${root} (not present)` });
    } else {
      // bot ids live in the database: read them before the folder goes
      const { knownBotIds } = await import('./secret-names.ts');
      const botIds = await knownBotIds(deps.paths.db);
      const unsafe = existsSync(root) ? unsafeDataRoot(root, deps.homeDir) : null;
      try {
        const secrets = await deps.secrets();
        let deleted = 0;
        // the keychain store deletes its one item (all secrets) plus any items left from the old one-per-secret layout
        if (secrets.purge) deleted = await secrets.purge(secretNames(botIds ?? []));
        else for (const n of secretNames(botIds ?? [])) { if ((await secrets.get(n)) !== null) { await secrets.delete(n); deleted++; } }
        const tail = botIds === null && !secrets.purge ? '; the database was unreadable, so per-bot items may remain' : botIds === null ? '; the database was unreadable, so old one-per-secret items of Grok bots may remain' : '';
        step({ id: 'keychain', status: deleted ? 'removed' : 'absent', detail: deleted ? `${deleted} saved keys in the Keychain (service "${KEYCHAIN_SERVICE}")${tail}` : `saved keys in the Keychain (service "${KEYCHAIN_SERVICE}"; none found${tail})`, ...(botIds === null ? { fix: `security delete-generic-password -s ${KEYCHAIN_SERVICE} (repeat until it reports that the item could not be found)` } : {}) });
      } catch (e) {
        step({ id: 'keychain', status: 'failed', detail: `Keychain items: ${(e as Error).message}`, fix: `security delete-generic-password -s ${KEYCHAIN_SERVICE} (repeat until it reports that the item could not be found)` });
      }
      if (!existsSync(root)) step({ id: 'data', status: 'absent', detail: `${root} (not present)` });
      else if (unsafe) step({ id: 'data', status: 'failed', detail: `refusing to delete ${root}: ${unsafe}`, fix: 'delete the agentbridge files there yourself' });
      else if (!statSync(root).isDirectory()) step({ id: 'data', status: 'failed', detail: `${root} is not a folder`, fix: `rm ${root}` });
      else {
        try { rmSync(root, { recursive: true, force: true }); marker = false; step({ id: 'data', status: 'removed', detail: `${root} (conversation history, policy, logs)` }); }
        catch (e) { step({ id: 'data', status: 'failed', detail: `${root}: ${(e as Error).message}`, fix: `rm -rf ${root}` }); }
      }
      step({ id: 'relay', status: 'left', detail: 'your registration on the relay (unusable without the deleted identity keys)' });
    }
  } finally {
    if (marker) { try { deps.marker.remove(); } catch { /* best effort */ } }
  }

  const ok = steps.every((s) => s.status !== 'failed');
  deps.print(ok ? '\nagentbridge is removed from this Mac. What is left for you to do:' : '\nSome steps failed (see FAIL lines above); fix them or run agentbridge uninstall again. Then:');
  for (const m of manual) deps.print(`  - ${m}`);
  return { ok, steps, manual };
}
