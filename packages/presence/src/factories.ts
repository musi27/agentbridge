// Entry points the bridge loads (packages/bridge/src/platform.ts): createSecretStore,
// createPresenceChecker, createNotifier.
import type { Notifier, PresenceChecker, SecretStore } from '@agentbridge/protocol';
import { existsSync } from 'node:fs';
import { callHelper, DEFAULT_HELPER_PATH, HelperError, type HelperClientOptions, type Runner } from './exec.ts';
import { KEYCHAIN_SERVICE, MacKeychainStore, TEST_SERVICE_RE } from './keychain.ts';
import { LAUNCHD_ENV_FLAG } from './launchd.ts';
import { OsascriptNotifier } from './notifier.ts';
import { MacPresenceChecker } from './presence.ts';

export const HELPER_PROTOCOL = 1;
export const BUILD_HINT = 'run the build: npm run build:helper -w @agentbridge/presence';

export class HelperMissingError extends Error {
  override name = 'HelperMissingError';
}

/** Checks the helper exists and answers `version` with the expected protocol. Throws HelperMissingError (message suits `doctor`). */
export async function verifyHelper(opts: HelperClientOptions = {}): Promise<{ path: string; version: string }> {
  const path = opts.helperPath ?? DEFAULT_HELPER_PATH;
  if (process.platform !== 'darwin') throw new HelperMissingError('the AgentBridge helper is macOS-only');
  if (opts.runner === undefined && !existsSync(path)) throw new HelperMissingError(`AgentBridge helper missing at ${path}; ${BUILD_HINT}`);
  let res;
  try {
    res = await callHelper('version', {}, { ...opts, timeoutMs: 10_000 });
  } catch (e) {
    throw new HelperMissingError(`AgentBridge helper at ${path} does not answer (${e instanceof HelperError ? e.message : String(e)}); ${BUILD_HINT}`);
  }
  if (!res.ok || res.protocol !== HELPER_PROTOCOL || res.version === undefined) {
    throw new HelperMissingError(`AgentBridge helper at ${path} speaks an unexpected protocol (${JSON.stringify(res)}); ${BUILD_HINT}`);
  }
  return { path, version: res.version };
}

/** Test/e2e only: a throwaway keychain service "agentbridge.test.<suffix>" (anything else is refused). */
export const KEYCHAIN_SERVICE_ENV = 'AGENTBRIDGE_KEYCHAIN_SERVICE';

export interface CreateSecretStoreOptions extends HelperClientOptions {
  env?: NodeJS.ProcessEnv;
  /** Folder for the keychain write lock and trust marker: <agentbridge home>/run. */
  stateDir?: string;
}

export async function createSecretStore(opts: CreateSecretStoreOptions = {}): Promise<SecretStore> {
  const { env = process.env, stateDir, ...helper } = opts;
  const override = env[KEYCHAIN_SERVICE_ENV];
  if (override !== undefined && override !== KEYCHAIN_SERVICE && !TEST_SERVICE_RE.test(override)) {
    throw new TypeError(`${KEYCHAIN_SERVICE_ENV} may only name a throwaway "agentbridge.test.<suffix>" service`);
  }
  await verifyHelper(helper);
  return new MacKeychainStore({ ...helper, ...(stateDir === undefined ? {} : { stateDir }), ...(override === undefined ? {} : { service: override }) });
}

export async function createPresenceChecker(opts: HelperClientOptions = {}): Promise<PresenceChecker> {
  await verifyHelper(opts);
  return new MacPresenceChecker(opts);
}

/**
 * True when this process most likely runs as a launchd agent rather than under a GUI app or
 * terminal: our plist's flag, a parent of launchd (ppid 1), or an XPC service name that is not an
 * app's (GUI apps and their terminals set "application.<bundle id>…" or "0").
 */
export function isLaunchdContext(env: NodeJS.ProcessEnv = process.env, ppid: number = process.ppid): boolean {
  if (env[LAUNCHD_ENV_FLAG] === '1' || ppid === 1) return true;
  const xpc = env.XPC_SERVICE_NAME;
  return xpc !== undefined && xpc !== '' && xpc !== '0' && !xpc.startsWith('application.');
}

export class NotificationUnavailableError extends Error {
  override name = 'NotificationUnavailableError';
}

/**
 * Notifier with an optional launchd opt-out. By default (`launchd: 'show'`) it posts via osascript
 * in every context: the 2026-11-22 re-probe showed banners from the launchd agent. It rejects only
 * when osascript fails (non-zero exit / timeout), which the bridge treats as "unshown". Exit 0 is
 * not proof the user saw it (Focus, Script Editor notifications off), so the bridge also keeps
 * must-act popups for the next CLI call. `launchd: 'defer'` restores the old behaviour (throw under
 * launchd). The guaranteed-delivery design is docs/notifications.md.
 */
export class ContextAwareNotifier implements Notifier {
  readonly #inner: Notifier;
  readonly #launchd: boolean;
  constructor(inner: Notifier = new OsascriptNotifier(), launchd: boolean = isLaunchdContext()) {
    this.#inner = inner;
    this.#launchd = launchd;
  }
  async notify(n: { title: string; body: string; subtitle?: string }): Promise<void> {
    if (this.#launchd) throw new NotificationUnavailableError('desktop notifications are not shown from the launchd agent (osascript cannot confirm display); see docs/notifications.md');
    await this.#inner.notify(n);
  }
}

export interface CreateNotifierOptions {
  env?: NodeJS.ProcessEnv;
  ppid?: number;
  /** Under launchd: 'show' (default) posts via osascript; 'defer' throws so the popup waits for the next CLI call. */
  launchd?: 'defer' | 'show';
  /** For tests: replaces the osascript process runner. */
  runner?: Runner;
}

export async function createNotifier(opts: CreateNotifierOptions = {}): Promise<Notifier> {
  const inLaunchd = isLaunchdContext(opts.env ?? process.env, opts.ppid ?? process.ppid);
  return new ContextAwareNotifier(new OsascriptNotifier(opts.runner === undefined ? {} : { runner: opts.runner }), inLaunchd && (opts.launchd ?? 'show') === 'defer');
}
