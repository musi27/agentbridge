// The agent panel's login item (TODO item 14, step A): a per-user LaunchAgent that runs
// `AgentBridge.app/Contents/MacOS/AgentBridge panel [--home <dir>] -- <node> <cli entry>`, the menu-bar dropdown.
//
// Why a LaunchAgent and not SMAppService: SMAppService.mainApp registers the *calling* app as a login item, and
// SMAppService.agent(plistName:) needs the plist inside the app bundle's Contents/Library/LaunchAgents. Our bundle
// lives inside the npm package (not /Applications), is committed pre-signed, and must not change per user, while the
// program arguments (node path, CLI entry, --home) differ per machine. A plain plist in ~/Library/LaunchAgents is
// what the bridge already uses, needs no bundle change, and `launchctl bootout` removes it cleanly on uninstall.
import { join } from 'node:path';
import { LaunchdServiceManager, type LaunchdServiceManagerOptions, type LaunchdStatus } from './launchd.ts';

export const PANEL_LABEL = 'live.musi.agentbridge.panel';

export interface PanelProgram {
  /** AgentBridge.app/Contents/MacOS/AgentBridge */
  helperPath: string;
  /** A stable node (launch-env.ts), and the CLI entry the panel runs `status --watch --json` / `panel stop` with. */
  nodePath: string;
  cliEntry: string;
  /** Non-default data folder (--home); passed through to the CLI. */
  home?: string;
}

/** ProgramArguments for the panel's LaunchAgent. */
export function panelProgramArguments(p: PanelProgram): string[] {
  return [p.helperPath, 'panel', ...(p.home ? ['--home', p.home] : []), '--', p.nodePath, p.cliEntry];
}

export class PanelAgent {
  readonly #m: LaunchdServiceManager;
  constructor(opts: Omit<LaunchdServiceManagerOptions, 'label' | 'environment'> = {}) {
    this.#m = new LaunchdServiceManager({ ...opts, label: PANEL_LABEL });
  }
  get plistPath(): string { return this.#m.plistPath; }
  get serviceTarget(): string { return this.#m.serviceTarget; }

  /** Writes the plist and (re)starts the panel: also how `init` restarts it on a new release. */
  async install(p: PanelProgram, logDir: string): Promise<void> {
    await this.#m.installProgram({ programArguments: panelProgramArguments(p), logDir, logName: 'panel', environment: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  }

  /** Removes the plist first, then boots the job out (the panel may be the one asking). */
  async uninstall(): Promise<void> { await this.#m.uninstall({ fileFirst: true }); }

  status(): Promise<LaunchdStatus> { return this.#m.status(); }
}

export const panelLogFiles = (logDir: string) => ({ out: join(logDir, 'panel.out.log'), err: join(logDir, 'panel.err.log') });
