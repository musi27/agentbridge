// Platform pieces for the real service (§9.2, §15.5). The macOS implementations live in @agentbridge/presence
// (workstream E). Until it is installed the bridge fails closed: privileged commands are refused and popups wait
// for the next `agentbridge status` (§9.1 "no notification service").
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Notifier, PresenceChecker, PresenceResult, SecretStore } from '@agentbridge/protocol';

export interface Platform { secrets: SecretStore; presence: PresenceChecker; notifier: Notifier; source: string }

/** Expected exports of @agentbridge/presence. */
interface PresenceModule {
  createSecretStore?: () => SecretStore | Promise<SecretStore>;
  createPresenceChecker?: () => PresenceChecker | Promise<PresenceChecker>;
  createNotifier?: () => Notifier | Promise<Notifier>;
}

export const unavailablePresence: PresenceChecker = {
  async check(): Promise<PresenceResult> { return { ok: false, code: 'unavailable', detail: 'the user-presence helper (@agentbridge/presence) is not installed' }; },
};
/** Throws, so popups are kept for the next CLI invocation. */
export const deferredNotifier: Notifier = { async notify() { throw new Error('no notification service'); } };

/** Development only (AGENTBRIDGE_DEV_SECRETS=1): secrets in a 0600 JSON file. Not a keychain. */
export class FileSecretStore implements SecretStore {
  private readonly path: string;
  constructor(root: string) { this.path = join(root, 'dev-secrets.json'); }
  private read(): Record<string, string> { return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>) : {}; }
  private write(o: Record<string, string>): void { writeFileSync(this.path, JSON.stringify(o), { mode: 0o600 }); chmodSync(this.path, 0o600); }
  async get(name: string): Promise<string | null> { return this.read()[name] ?? null; }
  async set(name: string, value: string): Promise<void> { const o = this.read(); o[name] = value; this.write(o); }
  async delete(name: string): Promise<void> { const o = this.read(); delete o[name]; this.write(o); }
}

export async function loadPlatform(root: string, env: NodeJS.ProcessEnv = process.env): Promise<Platform> {
  let mod: PresenceModule | null = null;
  const spec = '@agentbridge/presence';
  // development/tests: an explicit file secret store wins, so nothing touches the login keychain
  const devSecrets = env['AGENTBRIDGE_DEV_SECRETS'] === '1';
  // literal specifier so the release bundle (esbuild) includes it; absent in odd installs → fail closed below
  try { mod = (await import('@agentbridge/presence')) as PresenceModule; } catch { mod = null; }
  const presence = mod?.createPresenceChecker ? await mod.createPresenceChecker() : unavailablePresence;
  const notifier = mod?.createNotifier ? await mod.createNotifier() : deferredNotifier;
  if (mod?.createSecretStore && !devSecrets) return { secrets: await mod.createSecretStore(), presence, notifier, source: spec };
  if (devSecrets) return { secrets: new FileSecretStore(root), presence, notifier, source: 'dev-file' };
  throw new Error('no keychain available: install @agentbridge/presence (macOS), or set AGENTBRIDGE_DEV_SECRETS=1 for development');
}
