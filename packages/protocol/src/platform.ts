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
  /**
   * Optional (the macOS keychain store): run before the first read at init and service start. Warns through
   * `notice` when the OS is likely to ask for the login password, moves secrets saved in an older layout, and
   * finishes an interrupted write.
   */
  prepare?(o: SecretStorePrepareOptions): Promise<SecretStorePrepareResult>;
  /** Optional: delete every secret, including older-layout items named in `legacyNames`. Returns how many were removed. */
  purge?(legacyNames: readonly string[]): Promise<number>;
  /** Optional: older-layout items still present among `legacyNames` (no secret read, no OS prompt). For doctor. */
  leftovers?(legacyNames: readonly string[]): Promise<string[]>;
}

export interface SecretStorePrepareOptions {
  /** Every secret name that may exist in an older layout (SECRET_NAMES, with each known bot id). */
  legacyNames: readonly string[];
  /** One plain line for the user, shown before a likely OS password prompt. */
  notice(line: string): void;
  /** Copy older-layout items but don't delete them yet (an older bridge may still be running). */
  keepLegacy?: boolean;
  /** A person is at the terminal (init): retry items whose read was refused before, and throw if one still is. */
  interactive?: boolean;
}

export interface SecretStorePrepareResult {
  /** A notice was given. */
  warned: boolean;
  /** How many OS prompts were expected. */
  asks: number;
  /** Older-layout secrets copied into the current layout. */
  copied: number;
  /** Older-layout items deleted. */
  removed: number;
  /** Older-layout items left because the OS refused to delete them (not retried by the same helper build). */
  kept?: number;
  /** Older-layout items whose read was refused, so their secret was not copied (still in the old item). */
  unread?: number;
}

/** Every secret name the bridge may have saved, given the bot ids it knows. */
export function allSecretNames(botIds: readonly string[]): string[] {
  return [SECRET_NAMES.ed25519, SECRET_NAMES.x25519, SECRET_NAMES.policyHmacKey, SECRET_NAMES.policyVersion, SECRET_NAMES.policySnapshot,
    ...botIds.flatMap((b) => [SECRET_NAMES.botToken(b), SECRET_NAMES.webhookUrl(b), SECRET_NAMES.webhookKey(b)])];
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
