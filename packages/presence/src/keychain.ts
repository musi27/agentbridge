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
  /** For tests: the helper build (its cdhash; changes with every release); default reads codesign. */
  helperBuild?: () => Promise<string | null>;
}

/**
 * keychain-trust.json: per service, the helper identity that last read the item (predicts a dialog), the secret
 * NAMES the combined item held last time (never values; lets `prepare` count reads before it reads), and old items
 * that failed: a read the user refused, or a delete macOS refused, with the helper build it failed on. A failed one is
 * not tried again by the same build (no dialog loop on every start); `init` retries refused reads.
 */
interface ServiceState { identity?: string; names?: string[]; failedReads?: Record<string, string>; failedDeletes?: Record<string, string> }
interface TrustFile { v: 1; services: Record<string, string>; state?: Record<string, ServiceState> }

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

/** macOS answered and refused (denied dialog, access list, partition list), as opposed to the helper failing. */
function refusedByKeychain(e: unknown): boolean { return e instanceof HelperError && e.response?.ok === false && e.response.error === 'keychain'; }
/** errSecInteractionNotAllowed: no dialog could be shown (keychain locked, no GUI session), so trying again later can't loop dialogs. */
const remembered = (e: unknown): boolean => !(e instanceof HelperError && e.response?.ok === false && e.response.os_status === -25308);

/**
 * The line printed before macOS is likely to ask, or null. `reads`: old items that will be read (each may ask once);
 * `combined`: the combined item may ask (a helper it doesn't trust yet). "this once": an old item is read only while
 * its name is missing from the combined item, so after this run nothing reads it again.
 */
export function promptNotice(reads: number, combined: boolean): string | null {
  const asks = reads + (combined ? 1 : 0);
  if (asks <= 0) return null;
  if (reads > 0) {
    const times = asks === 1 ? 'once' : `up to ${asks} times`;
    return `AgentBridge is moving ${reads === 1 ? '1 saved key' : `${reads} saved keys`} into one keychain item. If macOS asks for your login password (${times}, only during this move), enter it and choose Always Allow.`;
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
 * authoritative for every name it holds; an old item only fills a name the combined item lacks, so an old item whose
 * name the combined item holds is never READ again (old items may trust only an older ad-hoc build, and each read
 * can ask for the login password), only deleted. `prepare` copies missing names in, reads the combined item back to
 * verify, and only then deletes the old items, so an interrupted move loses nothing and running it again is harmless.
 * A delete that fails (macOS refuses items whose partition list lacks this helper's team) does not stop the others and
 * is not retried by the same build; `leftovers` lists what is left for `agentbridge doctor`. `get` falls back to an old
 * item only for a name the combined item lacks and that did not fail before.
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
    // Not in the combined item: an item from the old layout not moved yet? Not one that failed before: a refused read
    // would ask again on every call, and a name whose old item could not be deleted was deleted on purpose.
    const st = this.#state();
    if (st.failedDeletes?.[name] !== undefined || st.failedReads?.[name] !== undefined) return null;
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
      // and its old-layout item, so it can't come back through the fallback; if macOS refuses, remember it instead
      // (the fallback skips it, doctor lists it)
      const build = await this.#build();
      try { await this.items.delete(name); this.#updateState((st) => { delete st.failedDeletes?.[name]; delete st.failedReads?.[name]; }); }
      catch (e) { if (!refusedByKeychain(e)) throw e; if (remembered(e)) this.#updateState((st) => { (st.failedDeletes ??= {})[name] = build; }); }
    });
  }

  /**
   * Run before the first secret is read (init, service start): prints a warning through `notice` when macOS is likely
   * to ask for the login password, then moves old-layout items into the combined item and finishes an interrupted
   * write. Only names missing from the combined item are read; the old items are then deleted unless `keepLegacy`.
   * Never throws for one old item: a refused read or delete is remembered and reported (`unread`, `kept`), except
   * that an `interactive` run (init) retries refused reads and throws if one is still refused.
   */
  async prepare(o: SecretStorePrepareOptions): Promise<SecretStorePrepareResult> {
    const legacy = [...new Set(o.legacyNames)].filter((n) => NAME_RE.test(n) && n !== COMBINED_ACCOUNT && n !== STAGING_ACCOUNT);
    const present = async (a: string) => (await this.items.exists(a)) ?? null;
    const combinedExists = (await present(COMBINED_ACCOUNT)) === true || (await present(STAGING_ACCOUNT)) === true;
    const legacyState = await Promise.all(legacy.map(async (n) => [n, await present(n)] as const));
    // unknown existence (security failed): still try them, but don't warn about them
    const candidates = legacyState.filter(([, e]) => e !== false).map(([n]) => n);
    const surely = new Set(legacyState.filter(([, e]) => e === true).map(([n]) => n));

    const identity = await this.#identity();
    const build = await this.#build();
    const st0 = this.#state();
    const trusted = st0.identity !== undefined && (identity === null || st0.identity === identity);
    const sameBuild = (m: Record<string, string> | undefined, n: string) => m?.[n] !== undefined && m[n] === build;
    const skipRead = (n: string) => !o.interactive && sameBuild(st0.failedReads, n);
    const skipDelete = (n: string) => sameBuild(st0.failedDeletes, n);

    return await this.#locked(async () => {
      // A trusted helper reads the combined item silently, so the warning can count exactly; otherwise use the names
      // it held last time (or assume none) and count the combined item as one more possible dialog.
      let rec: KeysRecord | null = trusted ? await this.#load() : null;
      const known = new Set(rec ? Object.keys(rec.secrets) : (st0.names ?? []));
      const willRead = [...surely].filter((n) => !known.has(n) && !skipRead(n));
      const askCombined = !trusted && combinedExists;
      const line = promptNotice(willRead.length, askCombined);
      if (line) o.notice(line);
      rec ??= await this.#load();

      // copy: only names the combined item lacks
      let copied = 0;
      const unread: string[] = [];
      const refused: Record<string, string> = {};
      const rememberRead: string[] = [];
      for (const n of candidates) {
        if (Object.hasOwn(rec.secrets, n) || skipRead(n)) continue;
        try {
          const v = await this.items.get(n);
          if (v !== null) { rec.secrets[n] = v; copied++; }
        } catch (e) { if (!refusedByKeychain(e)) throw e; unread.push(n); refused[n] = (e as Error).message; if (remembered(e)) rememberRead.push(n); }
      }
      if (copied > 0) { await this.#write(rec); await this.#verify(rec); }

      // delete: old items whose name the combined item now holds; never read them again
      let removed = 0;
      const kept: string[] = [];
      const deleteFailed: string[] = [];
      if (!o.keepLegacy) {
        for (const n of candidates) {
          if (!Object.hasOwn(rec.secrets, n)) continue;
          if (skipDelete(n)) { if (surely.has(n)) kept.push(n); continue; }
          try { if (await this.items.delete(n)) removed++; }
          catch (e) { if (!refusedByKeychain(e)) throw e; kept.push(n); if (remembered(e)) deleteFailed.push(n); }
        }
      }

      if (this.#opts.stateDir !== undefined) {
        const names = Object.keys(rec.secrets);
        this.#updateState((st) => {
          st.identity = identity ?? 'unknown'; // everything this helper just read (or created) trusts it now
          st.names = names;
          for (const n of names) delete st.failedReads?.[n];
          for (const n of rememberRead) (st.failedReads ??= {})[n] = build;
          for (const n of deleteFailed) (st.failedDeletes ??= {})[n] = build;
          if (!o.keepLegacy) for (const n of candidates) if (Object.hasOwn(rec!.secrets, n) && !kept.includes(n)) delete st.failedDeletes?.[n];
          if (st.failedReads && Object.keys(st.failedReads).length === 0) delete st.failedReads;
          if (st.failedDeletes && Object.keys(st.failedDeletes).length === 0) delete st.failedDeletes;
        });
      }
      const stillUnread = [...unread, ...candidates.filter((n) => !Object.hasOwn(rec!.secrets, n) && skipRead(n) && surely.has(n))];
      if (o.interactive && unread.length > 0) {
        throw new Error(`could not read ${unread.length === 1 ? 'the old keychain item' : `${unread.length} old keychain items`} ${unread.map((n) => `"${itemLabel(n)}"`).join(', ')} (${Object.values(refused)[0]}); nothing was lost, they are still there`);
      }
      return { warned: line !== null, asks: willRead.length + (askCombined ? 1 : 0), copied, removed, kept: kept.length, unread: stillUnread.length };
    });
  }

  /**
   * Old-layout items still in the keychain among `legacyNames`: checks attributes only (no secret, no dialog). For
   * `agentbridge doctor`; delete them with `security delete-generic-password -s <service> -a <name>`.
   */
  async leftovers(legacyNames: readonly string[]): Promise<string[]> {
    const names = [...new Set(legacyNames)].filter((n) => NAME_RE.test(n) && n !== COMBINED_ACCOUNT && n !== STAGING_ACCOUNT);
    const found = await Promise.all(names.map(async (n) => [n, await this.items.exists(n)] as const));
    return found.filter(([, e]) => e === true).map(([n]) => n);
  }

  /** Deletes every secret: the combined item, a leftover update item and the given old-layout items. Returns how many secrets were removed. */
  async purge(legacyNames: readonly string[]): Promise<number> {
    return await this.#locked(async () => {
      let rec: KeysRecord;
      try { rec = await this.#load(); } catch { rec = emptyRecord(); }
      const gone = new Set(Object.keys(rec.secrets));
      await this.items.delete(COMBINED_ACCOUNT);
      await this.items.delete(STAGING_ACCOUNT);
      const refused: string[] = [];
      for (const n of new Set(legacyNames)) {
        if (!NAME_RE.test(n)) continue;
        try { if (await this.items.delete(n)) gone.add(n); } catch (e) { if (!refusedByKeychain(e)) throw e; refused.push(n); }
      }
      if (this.#opts.stateDir !== undefined) rmSync(join(this.#opts.stateDir, TRUST_FILE), { force: true });
      if (refused.length > 0) {
        throw new Error(`macOS refused to delete ${refused.length} old keychain item(s); delete them with: ${refused.map((n) => `security delete-generic-password -s ${this.service} -a ${n}`).join('; ')}`);
      }
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

  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const dir = this.#opts.stateDir;
    if (dir === undefined) return withProcessLock(`keychain:${this.service}`, fn);
    return withFileLock(join(dir, this.service === KEYCHAIN_SERVICE ? LOCK_FILE : `keychain-${this.service}.lock`), fn, this.#opts.lock);
  }

  async #identity(): Promise<string | null> {
    if (this.#opts.helperIdentity) return await this.#opts.helperIdentity();
    return await helperCodeIdentity(this.#opts);
  }

  async #build(): Promise<string> {
    if (this.#opts.helperBuild) return (await this.#opts.helperBuild()) ?? 'unknown';
    return (await helperCodeInfo(this.#opts))?.cdhash ?? 'unknown';
  }

  #readFile(): TrustFile | null {
    const dir = this.#opts.stateDir;
    if (dir === undefined) return null;
    try {
      const o = JSON.parse(readFileSync(join(dir, TRUST_FILE), 'utf8')) as Partial<TrustFile>;
      if (o.v !== 1 || !o.services || typeof o.services !== 'object') return null;
      return { v: 1, services: { ...o.services }, ...(o.state && typeof o.state === 'object' ? { state: { ...o.state } } : {}) };
    } catch { return null; }
  }

  #state(): ServiceState {
    const f = this.#readFile();
    if (!f) return {};
    const id = f.services[this.service];
    const st: ServiceState = { ...(f.state?.[this.service] ?? {}) };
    delete st.identity;
    if (typeof id === 'string') st.identity = id;
    return st;
  }

  #updateState(fn: (st: ServiceState) => void): void {
    const dir = this.#opts.stateDir;
    if (dir === undefined) return;
    const f = this.#readFile() ?? { v: 1 as const, services: {} };
    const st: ServiceState = { ...(f.state?.[this.service] ?? {}) };
    const before = f.services[this.service];
    if (typeof before === 'string') st.identity = before;
    fn(st);
    const { identity, ...rest } = st;
    if (identity !== undefined) f.services[this.service] = identity;
    f.state = { ...(f.state ?? {}), [this.service]: rest };
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, TRUST_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(f)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }
}

/**
 * The helper's code identity as the keychain sees it: "team:<team id>/<identifier>" for a Developer ID signature
 * (items trust that, so any later build of the team reads silently), "cdhash:<hash>" for an ad-hoc one (items trust
 * the exact build). null if codesign can't tell.
 */
export async function helperCodeIdentity(opts: HelperClientOptions = {}): Promise<string | null> {
  return (await helperCodeInfo(opts))?.identity ?? null;
}

/** The helper's code identity (see helperCodeIdentity) and its build's cdhash; null if codesign can't tell. */
export async function helperCodeInfo(opts: HelperClientOptions = {}): Promise<{ identity: string | null; cdhash: string | null } | null> {
  try {
    const r = await (opts.runner ?? run)('/usr/bin/codesign', ['-d', '--verbose=3', opts.helperPath ?? DEFAULT_HELPER_PATH], { timeoutMs: 10_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim();
    const ident = /^Identifier=(.+)$/m.exec(text)?.[1]?.trim();
    const cd = /^CDHash=([0-9a-f]+)$/m.exec(text)?.[1] ?? null;
    if (team && team !== 'not set' && ident) return { identity: `team:${team}/${ident}`, cdhash: cd };
    return { identity: cd ? `cdhash:${cd}` : null, cdhash: cd };
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
