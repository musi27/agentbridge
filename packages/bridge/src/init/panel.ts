// `agentbridge panel start|stop|status` and init's panel step: the agent panel's menu-bar dropdown (AgentBridge.app
// `panel`, TODO item 14 step A), started at login by its own LaunchAgent (@agentbridge/presence PanelAgent).
//
// On by default: `init` installs it unless --skip-panel is given or the user turned it off. Turning it off sticks:
// `panel stop` (and the dropdown's "Turn off menu-bar panel", which runs it) records {"enabled": false} in
// <data folder>/panel.json, and a later init (say, after an upgrade) leaves it off. Only `panel start` turns it on
// again. `uninstall` always removes the LaunchAgent. Every external effect goes through PanelDeps, so tests use temp
// folders and a fake launchctl.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PanelProgramInput { helperPath: string; nodePath: string; cliEntry: string; home?: string }

export interface PanelDeps {
  agent: {
    install(p: PanelProgramInput, logDir: string): Promise<void>;
    uninstall(): Promise<void>;
    status(): Promise<'running' | 'stopped' | 'not_installed'>;
    readonly plistPath: string;
  };
  /** What the LaunchAgent runs, or why it can't (not macOS, helper or CLI entry missing). */
  program(): PanelProgramInput | { missing: string };
  /** <data folder>/panel.json */
  prefPath: string;
  logDir: string;
  now?: () => Date;
}

export type PanelPref = 'on' | 'off' | null;

/** The user's explicit choice; null = never chosen (init's default applies: on). An unreadable file counts as unset. */
export function readPanelPref(path: string): PanelPref {
  if (!existsSync(path)) return null;
  try {
    const v = (JSON.parse(readFileSync(path, 'utf8')) as { enabled?: unknown }).enabled;
    return v === true ? 'on' : v === false ? 'off' : null;
  } catch { return null; }
}

export function writePanelPref(path: string, enabled: boolean, now = new Date()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ enabled, changed_at: now.toISOString() })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The CLI entry the panel runs (`node <entry> status --watch --json`); null if not built. Mirrors serviceEntry(). */
export function cliEntry(): string | null {
  const here = fileURLToPath(import.meta.url);
  // release bundle (packaging/npm): dist/cli.mjs next to the chunk this module was bundled into
  const bundled = join(dirname(here), 'cli.mjs');
  if (existsSync(bundled)) return bundled;
  const built = here.endsWith('.js') ? join(dirname(here), '..', 'cli', 'main.js')
    : join(dirname(here), '..', '..', 'dist', 'cli', 'main.js'); // running from src (dev): use dist
  return existsSync(built) ? built : null;
}

export const TURN_OFF_HINT = 'Turn it off with: agentbridge panel stop';
export const TURN_ON_HINT = 'turn it on with: agentbridge panel start';

export interface PanelResult { ok: boolean; detail: string; fix?: string }

/** `agentbridge panel start`: record "on", install the LaunchAgent and start the panel now. */
export async function panelStart(d: PanelDeps): Promise<PanelResult> {
  const p = d.program();
  if ('missing' in p) return { ok: false, detail: `menu-bar panel can't start: ${p.missing}`, fix: 'npm run build (from a checkout), or reinstall: npm install -g @musi27/agentbridge' };
  writePanelPref(d.prefPath, true, d.now?.());
  try { await d.agent.install(p, d.logDir); }
  catch (e) { return { ok: false, detail: `menu-bar panel: ${(e as Error).message}`, fix: `see ${join(d.logDir, 'panel.err.log')}, then agentbridge panel start` }; }
  return { ok: true, detail: `Menu-bar panel started; it starts at login. ${TURN_OFF_HINT}` };
}

/** `agentbridge panel stop`: record "off" first (so it sticks even if the bootout ends this process), then remove the LaunchAgent. */
export async function panelStop(d: PanelDeps): Promise<PanelResult> {
  writePanelPref(d.prefPath, false, d.now?.());
  const before = await d.agent.status().catch(() => 'not_installed' as const);
  try { await d.agent.uninstall(); }
  catch (e) { return { ok: false, detail: `menu-bar panel: ${(e as Error).message}`, fix: `launchctl bootout gui/$(id -u)/live.musi.agentbridge.panel; rm ${d.agent.plistPath}` }; }
  return { ok: true, detail: `${before === 'not_installed' ? 'Menu-bar panel was not running' : 'Menu-bar panel stopped'}; it stays off after login and agentbridge init leaves it off (${TURN_ON_HINT})` };
}

/** `agentbridge panel status` / `panel`. */
export async function panelStatus(d: PanelDeps): Promise<PanelResult & { state: string; pref: PanelPref }> {
  const state = await d.agent.status().catch(() => 'unknown');
  const pref = readPanelPref(d.prefPath);
  const choice = pref === 'off' ? 'turned off' : pref === 'on' ? 'turned on' : 'on by default';
  const what = state === 'running' ? 'running' : state === 'stopped' ? 'installed but not running' : 'not installed';
  return { ok: true, state, pref, detail: `menu-bar panel: ${what} (${choice}); ${state === 'running' || state === 'stopped' ? TURN_OFF_HINT : TURN_ON_HINT}` };
}

export interface PanelInitStep { id: 'panel'; ok: boolean; skipped?: boolean; detail: string; fix?: string }

/**
 * init's panel step. Installs (and so restarts, picking up a new release) unless --skip-panel or the user turned it off.
 * A failure here never fails init: the panel is a convenience, the bridge works without it.
 */
export async function initPanelStep(d: PanelDeps, o: { skip?: boolean }): Promise<PanelInitStep> {
  if (o.skip) return { id: 'panel', ok: true, skipped: true, detail: 'menu-bar panel skipped (--skip-panel); start it any time with: agentbridge panel start' };
  if (readPanelPref(d.prefPath) === 'off') return { id: 'panel', ok: true, skipped: true, detail: `menu-bar panel off (you turned it off; ${TURN_ON_HINT})` };
  const p = d.program();
  if ('missing' in p) return { id: 'panel', ok: true, skipped: true, detail: `menu-bar panel not started: ${p.missing}` };
  try {
    await d.agent.install(p, d.logDir);
    return { id: 'panel', ok: true, detail: `Menu-bar panel started. ${TURN_OFF_HINT}` };
  } catch (e) {
    return { id: 'panel', ok: true, skipped: true, detail: `menu-bar panel not started: ${(e as Error).message}`, fix: 'agentbridge panel start' };
  }
}
