import type { SecretStore } from '@agentbridge/protocol';
import { callHelper, HelperError, type HelperClientOptions } from './exec.ts';
import type { HelperResponse } from './protocol.ts';

export const KEYCHAIN_SERVICE = 'agentbridge';
/** The helper accepts only "agentbridge" or a throwaway "agentbridge.test.<suffix>". */
export const TEST_SERVICE_RE = /^agentbridge\.test\.[A-Za-z0-9-]{1,64}$/;

/** Secret names: SECRET_NAMES values (e.g. "bot.<id>.token"). Restricting the alphabet keeps them safe as keychain accounts. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function assertSecretName(name: string): void {
  if (!NAME_RE.test(name)) throw new TypeError(`invalid secret name: ${JSON.stringify(name)}`);
}

export interface MacKeychainStoreOptions extends HelperClientOptions {
  /** Keychain service. Default "agentbridge"; tests use a unique "agentbridge.test.<suffix>". */
  service?: string;
  timeoutMs?: number;
}

/**
 * §15.5 secrets in the macOS login keychain (generic passwords, service "agentbridge",
 * account = secret name). Values cross the process boundary only over the helper's stdin/stdout.
 * The legacy file-based keychain does not enforce kSecAttrAccessible: items are readable while
 * the login keychain is unlocked (normally the whole login session). See README.
 */
export class MacKeychainStore implements SecretStore {
  readonly service: string;
  readonly #opts: MacKeychainStoreOptions;

  constructor(opts: MacKeychainStoreOptions = {}) {
    this.service = opts.service ?? KEYCHAIN_SERVICE;
    if (this.service !== KEYCHAIN_SERVICE && !TEST_SERVICE_RE.test(this.service)) throw new TypeError(`keychain service must be "agentbridge" or "agentbridge.test.<suffix>": ${this.service}`);
    this.#opts = opts;
  }

  async get(name: string): Promise<string | null> {
    const res = await this.#call('keychain-get', name);
    return res.ok ? (res.value ?? null) : null;
  }

  async set(name: string, value: string): Promise<void> {
    if (typeof value !== 'string') throw new TypeError('secret value must be a string');
    await this.#call('keychain-set', name, value);
  }

  async delete(name: string): Promise<void> {
    await this.#call('keychain-delete', name);
  }

  async #call(sub: 'keychain-get' | 'keychain-set' | 'keychain-delete', name: string, value?: string): Promise<HelperResponse> {
    assertSecretName(name);
    const req: Record<string, string> = { service: this.service, account: name };
    if (value !== undefined) req.value = value;
    // Keychain may show an access prompt (e.g. after a helper update); allow time for it.
    const res = await callHelper(sub, req, { ...this.#opts, timeoutMs: this.#opts.timeoutMs ?? 60_000 });
    if (!res.ok) {
      const status = res.os_status === undefined ? '' : ` (OSStatus ${res.os_status})`;
      throw new HelperError(`keychain ${sub.slice('keychain-'.length)} ${name} failed: ${res.detail ?? res.error ?? 'unknown'}${status}`, res);
    }
    return res;
  }
}

/** In-memory SecretStore for tests and for other packages' unit tests. */
export class InMemorySecretStore implements SecretStore {
  readonly #m = new Map<string, string>();
  async get(name: string): Promise<string | null> { assertSecretName(name); return this.#m.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { assertSecretName(name); this.#m.set(name, value); }
  async delete(name: string): Promise<void> { assertSecretName(name); this.#m.delete(name); }
  /** Test helper: names currently stored. */
  names(): string[] { return [...this.#m.keys()].sort(); }
}
