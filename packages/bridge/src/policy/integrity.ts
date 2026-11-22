// Policy integrity, "detects casual tampering" (§9.3). Policy rows carry a version and an HMAC; the HMAC key,
// the latest version and a snapshot of the last verified policy live in the SecretStore (keychain on macOS).
// Any mismatch, rollback or missing piece → fail closed until `agentbridge config verify` (user presence).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SECRET_NAMES, type SecretStore } from '@agentbridge/protocol';
import type { Store } from '../db/store.ts';
import { DEFAULT_POLICY, canonicalJson, policyToRows, rowsToPolicy, zPolicy, type Policy } from './policy.ts';

const CONTEXT = 'agentbridge-policy-v1';
const VERSION_ROW = '_version';
const HMAC_ROW = '_hmac';

export type PolicyState =
  | { ok: true; policy: Policy; version: number }
  | { ok: false; reason: 'hmac_mismatch' | 'rollback' | 'missing_key' | 'missing_policy' | 'corrupt'; detail: string };

export function policyMac(key: Buffer, version: number, rows: Array<{ key: string; value: string }>): string {
  const body = rows.filter((r) => r.key !== HMAC_ROW && r.key !== VERSION_ROW).sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((r) => `${r.key}=${r.value}`).join('\n');
  return createHmac('sha256', key).update(`${CONTEXT}\n${version}\n${body}`).digest('base64');
}

export class PolicyStore {
  private state: PolicyState = { ok: false, reason: 'missing_policy', detail: 'not loaded' };
  private readonly store: Store; private readonly secrets: SecretStore;
  constructor(store: Store, secrets: SecretStore) { this.store = store; this.secrets = secrets; }

  private chain: Promise<unknown> = Promise.resolve();
  /** Changes (set / reapprove / restore) run one at a time: each reads the version the previous one wrote. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  current(): PolicyState { return this.state; }
  /** The policy in force; throws if integrity failed (callers check `current().ok` first). */
  policy(): Policy { if (!this.state.ok) throw new Error(`policy unavailable: ${this.state.reason}`); return this.state.policy; }

  /** Load and verify. First run (no key, no rows) initialises signed defaults. */
  async load(): Promise<PolicyState> {
    const keyB64 = await this.secrets.get(SECRET_NAMES.policyHmacKey);
    const rows = this.store.policyRows();
    if (!keyB64 && rows.length === 0) {
      await this.secrets.set(SECRET_NAMES.policyHmacKey, randomBytes(32).toString('base64'));
      await this.write(DEFAULT_POLICY, 1);
      return this.state;
    }
    this.state = await this.verify(keyB64, rows);
    return this.state;
  }

  private async verify(keyB64: string | null, rows: Array<{ key: string; value: string }>): Promise<PolicyState> {
    if (!keyB64) return { ok: false, reason: 'missing_key', detail: 'policy rows exist but the HMAC key is missing from the keychain' };
    if (rows.length === 0) return { ok: false, reason: 'missing_policy', detail: 'policy rows are missing from the database' };
    const vRow = rows.find((r) => r.key === VERSION_ROW); const hRow = rows.find((r) => r.key === HMAC_ROW);
    const version = vRow ? Number(vRow.value) : NaN;
    if (!hRow || !Number.isInteger(version)) return { ok: false, reason: 'corrupt', detail: 'policy version or HMAC row missing' };
    const expect = Buffer.from(policyMac(Buffer.from(keyB64, 'base64'), version, rows), 'base64');
    const got = Buffer.from(hRow.value, 'base64');
    if (expect.length !== got.length || !timingSafeEqual(expect, got)) return { ok: false, reason: 'hmac_mismatch', detail: 'policy rows do not match their HMAC (edited outside agentbridge?)' };
    const kv = Number((await this.secrets.get(SECRET_NAMES.policyVersion)) ?? NaN);
    if (!Number.isInteger(kv)) return { ok: false, reason: 'missing_key', detail: 'policy version missing from the keychain' };
    if (version < kv) return { ok: false, reason: 'rollback', detail: `policy version ${version} is older than the last signed version ${kv}` };
    let policy: Policy;
    try { policy = rowsToPolicy(rows); } catch (e) { return { ok: false, reason: 'corrupt', detail: `policy rows invalid: ${(e as Error).message}` }; }
    if (version === kv + 1) {
      // A valid HMAC needs the key, so this is a crash between the DB commit and the keychain update: repair.
      await this.secrets.set(SECRET_NAMES.policyVersion, String(version));
      await this.secrets.set(SECRET_NAMES.policySnapshot, canonicalJson(policy));
    } else if (version > kv) {
      return { ok: false, reason: 'rollback', detail: `policy version ${version} is ahead of the keychain version ${kv}` };
    }
    return { ok: true, policy, version };
  }

  private async write(policy: Policy, version: number): Promise<void> {
    const p = zPolicy.parse(policy);
    const keyB64 = await this.secrets.get(SECRET_NAMES.policyHmacKey);
    if (!keyB64) throw new Error('policy HMAC key missing');
    const rows = [...policyToRows(p), { key: VERSION_ROW, value: String(version) }];
    rows.push({ key: HMAC_ROW, value: policyMac(Buffer.from(keyB64, 'base64'), version, rows) });
    this.store.replacePolicy(rows);
    await this.secrets.set(SECRET_NAMES.policyVersion, String(version));
    await this.secrets.set(SECRET_NAMES.policySnapshot, canonicalJson(p));
    this.state = { ok: true, policy: p, version };
  }

  /** Change policy (caller has already done the user-presence check). Refused while tampered. */
  set(next: Policy): Promise<number> { return this.serial(() => this.setNow(next)); }
  private async setNow(next: Policy): Promise<number> {
    if (!this.state.ok) throw new Error(`policy integrity failed (${this.state.reason}); run agentbridge config verify`);
    const v = this.state.version + 1; await this.write(next, v); return v;
  }

  /** For `config verify`: what is in the DB now vs the last verified snapshot. */
  async inspect(): Promise<{ state: PolicyState; current: Policy | null; lastVerified: Policy | null }> {
    let current: Policy | null = null;
    try { current = rowsToPolicy(this.store.policyRows()); } catch { current = null; }
    const snap = await this.secrets.get(SECRET_NAMES.policySnapshot);
    let lastVerified: Policy | null = null;
    try { lastVerified = snap ? zPolicy.parse(JSON.parse(snap)) : null; } catch { lastVerified = null; }
    return { state: this.state, current, lastVerified };
  }

  private async nextVersion(): Promise<number> {
    const kv = Number((await this.secrets.get(SECRET_NAMES.policyVersion)) ?? 0) || 0;
    const dbv = Number(this.store.policyRows().find((r) => r.key === VERSION_ROW)?.value ?? 0) || 0;
    return Math.max(kv, dbv) + 1;
  }

  /** `config verify` → re-approve: sign what is in the DB now (must still be a valid policy). */
  reapproveCurrent(): Promise<number> { return this.serial(() => this.reapproveNow()); }
  private async reapproveNow(): Promise<number> {
    const { current } = await this.inspect();
    if (!current) throw new Error('current policy rows are not a valid policy; restore the last verified one instead');
    if (!(await this.secrets.get(SECRET_NAMES.policyHmacKey))) await this.secrets.set(SECRET_NAMES.policyHmacKey, randomBytes(32).toString('base64'));
    const v = await this.nextVersion(); await this.write(current, v); return v;
  }

  /** `config verify` → restore: write back the last verified snapshot (or defaults if there is none). */
  restoreLastVerified(): Promise<number> { return this.serial(() => this.restoreNow()); }
  private async restoreNow(): Promise<number> {
    const { lastVerified } = await this.inspect();
    if (!(await this.secrets.get(SECRET_NAMES.policyHmacKey))) await this.secrets.set(SECRET_NAMES.policyHmacKey, randomBytes(32).toString('base64'));
    const v = await this.nextVersion(); await this.write(lastVerified ?? DEFAULT_POLICY, v); return v;
  }
}

/** In-memory SecretStore for tests and development. */
export class MemorySecretStore implements SecretStore {
  readonly map = new Map<string, string>();
  async get(name: string): Promise<string | null> { return this.map.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { this.map.set(name, value); }
  async delete(name: string): Promise<void> { this.map.delete(name); }
}
