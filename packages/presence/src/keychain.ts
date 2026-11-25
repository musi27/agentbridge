import type { SecretStore, SecretStorePrepareOptions, SecretStorePrepareResult } from '@agentbridge/protocol';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callHelper, DEFAULT_HELPER_PATH, HelperError, run, type HelperClientOptions } from './exec.ts';
import { withFileLock, withProcessLock, type FileLockOptions } from './keychain-lock.ts';
import type { HelperResponse } from './protocol.ts';

export const KEYCHAIN_SERVICE = 'agentbridge';
/** The helper accepts only "agentbridge" or a throwaway "agentbridge.test.<suffix>". */
export const TEST_SERVICE_RE = /^agentbridge\.test\.[A-Za-z0-9-]{1,64}$/;

/**
 * The one keychain item holding every secret (account under the service). The helper labels items
 * "agentbridge: <account>", and macOS names the item by that label in its access dialog ("AgentBridge wants to use your
 * confidential information stored in "agentbridge: saved keys" in your keychain") and in Keychain Access.
 */
export const COMBINED_ACCOUNT = 'saved keys';
/** Holds the next version of the combined item while it is rewritten (see MacKeychainStore). */
export const STAGING_ACCOUNT = 'saved keys (update in progress)';
/** The label the helper gives an item: what keychain dialogs and Keychain Access show. */
export const itemLabel = (account: string): string => `agentbridge: ${account}`;

/** Trust marker file in the store's state folder: which helper identity last read the keychain item(s). */
export const TRUST_FILE = 'keychain-trust.json';
export const LOCK_FILE = 'keychain.lock';

/** Combined item payloads stay well under the helper's 1 MiB request limit. */
const MAX_RECORD_BYTES = 768 * 1024;

/** Secret names: SECRET_NAMES values (e.g. "bot.<id>.token"). Restricting the alphabet keeps them safe as keychain accounts. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function assertSecretName(name: string): void {
  if (!NAME_RE.test(name)) throw new TypeError(`invalid secret name: ${JSON.stringify(name)}`);
}

export interface MacKeychainStoreOptions extends HelperClientOptions {
  /** Keychain service. Default "agentbridge"; tests use a unique "agentbridge.test.<suffix>". */
  service?: string;
  timeoutMs?: number;
  /**
   * Folder for the write lock (keychain.lock) and the trust marker (keychain-trust.json); the bridge passes
   * <agentbridge home>/run. Without it, writes are serialised within this process only and `prepare` cannot tell
   * whether macOS will ask.
   */
  stateDir?: string;
  lock?: FileLockOptions;
  /** For tests: the helper's code identity ("team:<id>/<identifier>" or "cdhash:<hash>"); default reads codesign. */
  helperIdentity?: () => Promise<string | null>;
}

interface KeysRecord { agentbridge_keys: 1; gen: number; secrets: Record<string, string> }

const emptyRecord = (): KeysRecord => ({ agentbridge_keys: 1, gen: 0, secrets: {} });

function parseRecord(raw: string, account: string): KeysRecord {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { throw new Error(`keychain item "${itemLabel(account)}" is not valid JSON; not overwriting it`); }
  const r = o as Partial<KeysRecord> | null;
  if (r && typeof r === 'object' && typeof r.agentbridge_keys === 'number' && r.agentbridge_keys > 1) {
    throw new Error(`keychain item "${itemLabel(account)}" was saved by a newer agentbridge (format ${r.agentbridge_keys}); upgrade agentbridge`);
  }
  if (!r || typeof r !== 'object' || r.agentbridge_keys !== 1 || !Number.isInteger(r.gen) || !r.secrets || typeof r.secrets !== 'object' || Array.isArray(r.secrets)
    || !Object.values(r.secrets).every((v) => typeof v === 'string')) {
    throw new Error(`keychain item "${itemLabel(account)}" has an unexpected format; not overwriting it`);
  }
  return { agentbridge_keys: 1, gen: r.gen!, secrets: { ...r.secrets } };
}

/**
 * Raw access to single keychain items through the helper (values only on its stdin/stdout), plus an existence check
 * through /usr/bin/security that reads attributes only, so it never shows a dialog and never sees a value.
 */
export class KeychainItems {
  readonly service: string;
  readonly #opts: MacKeychainStoreOptions;
  constructor(service: string, opts: MacKeychainStoreOptions) { this.service = service; this.#opts = opts; }

  async get(account: string): Promise<string | null> {
    const res = await this.#call('keychain-get', account);
    return res.ok ? (res.value ?? null) : null;
  }
  async set(account: string, value: string): Promise<void> { await this.#call('keychain-set', account, value); }
  /** True when an item was deleted. Deleting never needs the item's access list, so it never shows a dialog. */
  async delete(account: string): Promise<boolean> { const r = await this.#call('keychain-delete', account); return r.ok && r.deleted === true; }

  /** Does the item exist? null when it cannot be told (security failed). */
  async exists(account: string): Promise<boolean | null> {
    try {
      const r = await (this.#opts.runner ?? run)('/usr/bin/security', ['find-generic-password', '-s', this.service, '-a', account], { timeoutMs: 10_000 });
      if (r.code === 0) return true;
      if (r.code === 44) return false;
      return null;
    } catch { return null; }
  }

  async #call(sub: 'keychain-get' | 'keychain-set' | 'keychain-delete', account: string, value?: string): Promise<HelperResponse> {
    const req: Record<string, string> = { service: this.service, account };
    if (value !== undefined) req.value = value;
    // Keychain may show an access prompt (e.g. after a helper update); allow time for it.
    const res = await callHelper(sub, req, { ...this.#opts, timeoutMs: this.#opts.timeoutMs ?? 60_000 });
    if (!res.ok) {
      const status = res.os_status === undefined ? '' : ` (OSStatus ${res.os_status})`;
      throw new HelperError(`keychain ${sub.slice('keychain-'.length)} "${itemLabel(account)}" failed: ${res.detail ?? res.error ?? 'unknown'}${status}`, res);
    }
    return res;
  }
}

/** The line printed before macOS is likely to ask, or null. */
export function promptNotice(asks: number, legacy: number): string | null {
  if (asks <= 0) return null;
  if (legacy > 0) {
    return `AgentBridge is moving its ${legacy} saved keys into one keychain item. If macOS asks for your login password (up to ${asks} times, this once), enter it and choose Always Allow.`;
  }
  return 'macOS may ask for your login password once so AgentBridge can read its saved keys. Enter it and choose Always Allow.';
}

/**
 * §15.5 secrets in the macOS login keychain, all in ONE generic-password item (service "agentbridge", account
 * "saved keys"): a JSON map name → value. One item means one access dialog when macOS re-checks trust, not one per
 * secret. Values cross the process boundary only over the helper's stdin/stdout.
 *
 * Writes: read-modify-write under a lock file (the bridge service and the CLI both write). The helper's set is
 * delete-then-add, so a crash between the two would lose the item; each write therefore first saves the new version
 * as a second item ("saved keys (update in progress)"), then replaces "saved keys", then deletes the second item.
 * Whoever next takes the lock finds a leftover second item and finishes the write with it (it carries a higher
 * generation number). Reads need no lock unless "saved keys" is missing (mid-write), then they wait for the lock.
 *
 * Old layout (0.2.6 and earlier): one item per secret, account = secret name. Rule: the combined item is
 * authoritative for every name it holds; an old item only fills a name the combined item lacks. `prepare` copies
 * the old items in, reads the combined item back to verify, and only then deletes the old ones, so an interrupted
 * move loses nothing and running it again is harmless. `get` also falls back to an old item for a missing name.
 *
 * The legacy file-based keychain does not enforce kSecAttrAccessible: the item is readable while the login keychain
 * is unlocked (normally the whole login session). See README.
 */
export class MacKeychainStore implements SecretStore {
  readonly service: string;
  readonly items: KeychainItems;
  readonly #opts: MacKeychainStoreOptions;

  constructor(opts: MacKeychainStoreOptions = {}) {
    this.service = opts.service ?? KEYCHAIN_SERVICE;
    if (this.service !== KEYCHAIN_SERVICE && !TEST_SERVICE_RE.test(this.service)) throw new TypeError(`keychain service must be "agentbridge" or "agentbridge.test.<suffix>": ${this.service}`);
    this.#opts = opts;
    this.items = new KeychainItems(this.service, opts);
  }

  async get(name: string): Promise<string | null> {
    assertSecretName(name);
    const raw = await this.items.get(COMBINED_ACCOUNT);
    const rec = raw !== null ? parseRecord(raw, COMBINED_ACCOUNT) : await this.#locked(() => this.#load());
    if (Object.hasOwn(rec.secrets, name)) return rec.secrets[name]!;
    // Not in the combined item: an item from the old layout not moved yet?
    return await this.items.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    if (typeof value !== 'string') throw new TypeError('secret value must be a string');
    await this.#locked(async () => {
      const rec = await this.#load();
      rec.secrets[name] = value;
      await this.#write(rec);
    });
  }

  async delete(name: string): Promise<void> {
    assertSecretName(name);
    await this.#locked(async () => {
      const rec = await this.#load();
      if (Object.hasOwn(rec.secrets, name)) { delete rec.secrets[name]; await this.#write(rec); }
      await this.items.delete(name); // and its old-layout item, so it can't come back through the fallback
    });
  }

  /**
   * Run before the first secret is read (init, service start): prints a warning through `notice` when macOS is likely
   * to ask for the login password, then moves old-layout items into the combined item (verify, then delete them
   * unless `keepLegacy`), and finishes an interrupted write.
   */
  async prepare(o: SecretStorePrepareOptions): Promise<SecretStorePrepareResult> {
    const legacy = [...new Set(o.legacyNames)].filter((n) => NAME_RE.test(n));
    const present = async (a: string) => (await this.items.exists(a)) ?? null;
    const combined = (await present(COMBINED_ACCOUNT)) === true || (await present(STAGING_ACCOUNT)) === true;
    const legacyState = await Promise.all(legacy.map(async (n) => [n, await present(n)] as const));
    const legacyFound = legacyState.filter(([, e]) => e === true).map(([n]) => n);
    // unknown existence: still try to move them, but don't warn about them
    const toMove = legacyState.filter(([, e]) => e !== false).map(([n]) => n);

    const identity = await this.#identity();
    const marker = this.#readTrust();
    const trusted = marker !== undefined && (identity === null || marker === identity);
    const asks = trusted ? 0 : (combined ? 1 : 0) + legacyFound.length;
    const line = promptNotice(asks, trusted ? 0 : legacyFound.length);
    if (line) o.notice(line);

    const r = await this.#locked(async () => {
      const rec = await this.#load();
      return await this.#moveLegacy(rec, toMove, !o.keepLegacy);
    });
    // Everything this helper just read (or will create) is trusted for it from now on.
    if (this.#opts.stateDir !== undefined) this.#writeTrust(identity ?? 'unknown');
    return { warned: line !== null, asks, copied: r.copied, removed: r.removed };
  }

  /** Deletes every secret: the combined item, a leftover update item and the given old-layout items. Returns how many secrets were removed. */
  async purge(legacyNames: readonly string[]): Promise<number> {
    return await this.#locked(async () => {
      let rec: KeysRecord;
      try { rec = await this.#load(); } catch { rec = emptyRecord(); }
      const gone = new Set(Object.keys(rec.secrets));
      await this.items.delete(COMBINED_ACCOUNT);
      await this.items.delete(STAGING_ACCOUNT);
      for (const n of new Set(legacyNames)) { if (NAME_RE.test(n) && await this.items.delete(n)) gone.add(n); }
      if (this.#opts.stateDir !== undefined) rmSync(join(this.#opts.stateDir, TRUST_FILE), { force: true });
      return gone.size;
    });
  }

  // --- internals (call only inside #locked) ---

  /** Reads the combined item, first finishing an interrupted write (a leftover update item wins if newer). */
  async #load(): Promise<KeysRecord> {
    const stagedRaw = await this.items.get(STAGING_ACCOUNT);
    const primaryRaw = await this.items.get(COMBINED_ACCOUNT);
    const primary = primaryRaw === null ? null : parseRecord(primaryRaw, COMBINED_ACCOUNT);
    if (stagedRaw === null) return primary ?? emptyRecord();
    const staged = parseRecord(stagedRaw, STAGING_ACCOUNT);
    if (primary === null || staged.gen > primary.gen) {
      await this.items.set(COMBINED_ACCOUNT, stagedRaw);
      await this.#verify(staged);
      await this.items.delete(STAGING_ACCOUNT);
      return staged;
    }
    await this.items.delete(STAGING_ACCOUNT);
    return primary;
  }

  /** Saves `rec` as the next generation: update item, then the combined item, then drop the update item. */
  async #write(rec: KeysRecord): Promise<void> {
    if (Object.keys(rec.secrets).length === 0) {
      await this.items.delete(COMBINED_ACCOUNT);
      await this.items.delete(STAGING_ACCOUNT);
      rec.gen = 0;
      return;
    }
    rec.gen += 1;
    const raw = JSON.stringify(rec);
    if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) throw new Error(`the saved keys would exceed ${MAX_RECORD_BYTES} bytes`);
    await this.items.set(STAGING_ACCOUNT, raw);
    await this.items.set(COMBINED_ACCOUNT, raw);
    await this.items.delete(STAGING_ACCOUNT);
  }

  /** Reads the combined item back and checks it holds exactly `rec`'s secrets. */
  async #verify(rec: KeysRecord): Promise<void> {
    const back = await this.items.get(COMBINED_ACCOUNT);
    const got = back === null ? null : parseRecord(back, COMBINED_ACCOUNT);
    const want = Object.entries(rec.secrets);
    if (got === null || got.gen !== rec.gen || Object.keys(got.secrets).length !== want.length || want.some(([k, v]) => got.secrets[k] !== v)) {
      throw new Error(`keychain item "${itemLabel(COMBINED_ACCOUNT)}" did not read back as written; old items were kept`);
    }
  }

  async #moveLegacy(rec: KeysRecord, names: readonly string[], deleteOld: boolean): Promise<{ found: number; copied: number; removed: number }> {
    const found: string[] = [];
    let copied = 0;
    for (const n of names) {
      const v = await this.items.get(n);
      if (v === null) continue;
      found.push(n);
      if (!Object.hasOwn(rec.secrets, n)) { rec.secrets[n] = v; copied++; }
    }
    if (copied > 0) { await this.#write(rec); await this.#verify(rec); }
    let removed = 0;
    if (deleteOld) for (const n of found) { if (await this.items.delete(n)) removed++; }
    return { found: found.length, copied, removed };
  }

  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const dir = this.#opts.stateDir;
    if (dir === undefined) return withProcessLock(`keychain:${this.service}`, fn);
    return withFileLock(join(dir, this.service === KEYCHAIN_SERVICE ? LOCK_FILE : `keychain-${this.service}.lock`), fn, this.#opts.lock);
  }

  async #identity(): Promise<string | null> {
    if (this.#opts.helperIdentity) return await this.#opts.helperIdentity();
    return await helperCodeIdentity(this.#opts);
  }

  #readTrust(): string | undefined {
    const dir = this.#opts.stateDir;
    if (dir === undefined) return undefined;
    try {
      const o = JSON.parse(readFileSync(join(dir, TRUST_FILE), 'utf8')) as { v?: number; services?: Record<string, unknown> };
      const id = o.v === 1 ? o.services?.[this.service] : undefined;
      return typeof id === 'string' ? id : undefined;
    } catch { return undefined; }
  }

  #writeTrust(identity: string): void {
    const dir = this.#opts.stateDir!;
    const path = join(dir, TRUST_FILE);
    let services: Record<string, string> = {};
    try {
      const o = JSON.parse(readFileSync(path, 'utf8')) as { v?: number; services?: Record<string, string> };
      if (o.v === 1 && o.services && typeof o.services === 'object') services = { ...o.services };
    } catch { /* new file */ }
    services[this.service] = identity;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, services })}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }
}

/**
 * The helper's code identity as the keychain sees it: "team:<team id>/<identifier>" for a Developer ID signature
 * (items trust that, so any later build of the team reads silently), "cdhash:<hash>" for an ad-hoc one (items trust
 * the exact build). null if codesign can't tell.
 */
export async function helperCodeIdentity(opts: HelperClientOptions = {}): Promise<string | null> {
  try {
    const r = await (opts.runner ?? run)('/usr/bin/codesign', ['-d', '--verbose=3', opts.helperPath ?? DEFAULT_HELPER_PATH], { timeoutMs: 10_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim();
    const ident = /^Identifier=(.+)$/m.exec(text)?.[1]?.trim();
    if (team && team !== 'not set' && ident) return `team:${team}/${ident}`;
    const cd = /^CDHash=([0-9a-f]+)$/m.exec(text)?.[1];
    return cd ? `cdhash:${cd}` : null;
  } catch { return null; }
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
