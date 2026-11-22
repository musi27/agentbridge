// Platform interfaces (§9, §14.1, §15.5). The bridge core depends on these; packages/presence implements them for macOS.
export type PresenceResult =
  | { ok: true; method: 'biometric_or_password' }
  | { ok: false; code: 'cancelled' | 'failed' | 'system_cancel' | 'unavailable' | 'error'; detail?: string };

/** Bridge-run user-presence check (§9.2). `reason` is shown in the OS dialog. */
export interface PresenceChecker { check(reason: string): Promise<PresenceResult> }

/** Secrets (§15.5): never passed via argv or env; values are opaque strings (base64 for binary). */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface Notifier { notify(n: { title: string; body: string; subtitle?: string }): Promise<void> }

export interface ServiceManager {
  install(opts: { nodePath: string; entry: string; logDir: string }): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<'running' | 'stopped' | 'not_installed'>;
}

/** Secret names used by the bridge (keychain service "agentbridge"). */
export const SECRET_NAMES = {
  ed25519: 'identity.ed25519',
  x25519: 'identity.x25519',
  policyHmacKey: 'policy.hmac_key',
  policyVersion: 'policy.version',
  /** Canonical JSON of the last verified policy, for `config verify` restore (§9.3). */
  policySnapshot: 'policy.snapshot',
  botToken: (botId: string) => `bot.${botId}.token`,
  webhookUrl: (botId: string) => `bot.${botId}.webhook_url`,
  webhookKey: (botId: string) => `bot.${botId}.webhook_key`,
} as const;
