// A fake login keychain behind a Runner: answers the helper's keychain-* subcommands, `security find-generic-password`
// (attributes only) and `codesign -d` like the real ones. Each item records which helper identities it trusts, like
// a legacy keychain item's access list: a read by an identity it doesn't trust counts as an access dialog, answered
// by `answer` (default "Always Allow"). An item may also carry a partition list (login keychain, macOS 10.12+); an
// identity outside it is untrusted too, and deleting such an item behaves as `partitionDelete` says (the owner's
// 0.2.7 upgrade: a delete of an item whose partition lacked the team failed). Optional state file + file mutex so
// several processes can share one fake keychain.
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import type { Runner, RunResult } from '../src/exec.ts';

export interface FakeItem { value: string; trusts: string[]; partition?: string[] }
/** The user's answer to an access dialog: Always Allow (trusted from now on), Allow (this once), Deny. */
export type FakeAnswer = 'always' | 'allow' | 'deny';
export interface FakeOp { sub: string; account: string; phase?: 'delete' | 'add' }

export class Killed extends Error {}

export class FakeKeychain {
  items = new Map<string, FakeItem>();
  /** Current helper identity ("team:…" or "cdhash:…"). */
  identity = 'team:67B9AY2VHJ/live.musi.agentbridge';
  /** The helper build's cdhash codesign reports for a team identity (a new release = a new cdhash). */
  cdhash = '0123abcd';
  /** Access dialogs shown (untrusted reads, and deletes when partitionDelete is "prompt"). */
  prompts: string[] = [];
  /** How the user answers a dialog for this account. */
  answer: (account: string) => FakeAnswer = () => 'always';
  /** Deleting an item whose partition list lacks the current identity: works, fails, or asks first. */
  partitionDelete: 'ok' | 'fail' | 'prompt' = 'ok';
  /** Every keychain op, in order (a set is two: delete, add). */
  ops: FakeOp[] = [];
  /** Return true to "kill" the helper right before this op (earlier ops stay applied). */
  killAt: ((op: FakeOp, index: number) => boolean) | null = null;
  readonly helperPath: string;
  readonly statePath: string | undefined;

  constructor(o: { helperPath?: string; statePath?: string } = {}) {
    this.helperPath = o.helperPath ?? '/fake/AgentBridge.app/Contents/MacOS/AgentBridge';
    this.statePath = o.statePath;
  }

  key(service: string, account: string): string { return `${service}\u0000${account}`; }
  /** Seed an item as if a helper with `trusts` identity had created it. */
  seed(service: string, account: string, value: string, trusts: string | string[] = this.identity, partition?: string[]): void {
    this.items.set(this.key(service, account), { value, trusts: [trusts].flat(), ...(partition ? { partition } : {}) });
  }
  #trusted(it: FakeItem): boolean { return it.trusts.includes(this.identity) && (!it.partition || it.partition.includes(this.identity)); }
  #partitioned(it: FakeItem): boolean { return !!it.partition && !it.partition.includes(this.identity); }
  accounts(service: string): string[] { return [...this.items.keys()].filter((k) => k.startsWith(`${service}\u0000`)).map((k) => k.split('\u0000')[1]!).sort(); }
  value(service: string, account: string): string | undefined { return this.items.get(this.key(service, account))?.value; }

  #step(op: FakeOp): void {
    const i = this.ops.length;
    if (this.killAt?.(op, i)) throw new Killed(`killed before op ${i} ${op.sub} ${op.account} ${op.phase ?? ''}`);
    this.ops.push(op);
  }

  #load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    const o = JSON.parse(readFileSync(this.statePath, 'utf8')) as { items: [string, FakeItem][] };
    this.items = new Map(o.items);
  }
  #save(): void {
    if (!this.statePath) return;
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ items: [...this.items] }));
    renameSync(tmp, this.statePath);
  }
  /** Each fake keychain call is atomic, like a SecItem call (file mutex when shared between processes). */
  #atomic<T>(fn: () => T): T {
    if (!this.statePath) return fn();
    const m = `${this.statePath}.mutex`;
    for (let n = 0; ; n++) {
      try { mkdirSync(m); break; } catch { if (n > 200_000) throw new Error('fake mutex stuck'); }
    }
    try { this.#load(); const r = fn(); this.#save(); return r; } finally { rmdirSync(m); }
  }

  handle(sub: string, req: { service?: string; account: string; value?: string }): object {
    const service = req.service ?? 'agentbridge';
    const k = this.key(service, req.account);
    if (sub === 'keychain-get') {
      return this.#atomic(() => {
        this.#step({ sub, account: req.account });
        const it = this.items.get(k);
        if (!it) return { ok: true, value: null };
        if (!this.#trusted(it)) {
          this.prompts.push(req.account);
          const a = this.answer(req.account);
          if (a === 'deny') return { ok: false, error: 'keychain', detail: 'The user name or passphrase you entered is not correct.', os_status: -25293 };
          if (a === 'always') { if (!it.trusts.includes(this.identity)) it.trusts.push(this.identity); if (it.partition && !it.partition.includes(this.identity)) it.partition.push(this.identity); }
        }
        return { ok: true, value: it.value };
      });
    }
    if (sub === 'keychain-delete') {
      return this.#atomic(() => {
        this.#step({ sub, account: req.account });
        const it = this.items.get(k);
        if (it && this.#partitioned(it) && this.partitionDelete !== 'ok') {
          const refuse = { ok: false, error: 'keychain', detail: 'UNIX[Operation not permitted]', os_status: -25244 };
          if (this.partitionDelete === 'fail') return refuse;
          this.prompts.push(`delete ${req.account}`);
          if (this.answer(req.account) === 'deny') return refuse;
        }
        return { ok: true, deleted: this.items.delete(k) };
      });
    }
    if (sub === 'keychain-set') {
      // delete-then-add: two separate keychain calls, a kill can land between them
      this.#atomic(() => { this.#step({ sub, account: req.account, phase: 'delete' }); this.items.delete(k); });
      this.#atomic(() => { this.#step({ sub, account: req.account, phase: 'add' }); this.items.set(k, { value: req.value!, trusts: [this.identity] }); });
      return { ok: true };
    }
    return { ok: false, error: 'unknown_subcommand', detail: sub };
  }

  runner: Runner = async (file, args, opts): Promise<RunResult> => {
    const res = (stdout: string, code = 0): RunResult => ({ code, signal: null, stdout, stderr: '', timedOut: false });
    if (file === '/usr/bin/security') {
      const s = args[args.indexOf('-s') + 1]!; const a = args[args.indexOf('-a') + 1]!;
      const found = this.#atomic(() => this.items.has(this.key(s, a)));
      return found ? res(`keychain: "fake"\nattributes:\n    "acct"<blob>="${a}"\n`) : { ...res(''), code: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' };
    }
    if (file === '/usr/bin/codesign') {
      const id = this.identity;
      const text = id.startsWith('team:')
        ? `Identifier=${id.split('/')[1]}\nCDHash=${this.cdhash}\nTeamIdentifier=${id.slice(5).split('/')[0]}\n`
        : `Identifier=live.musi.agentbridge\nCDHash=${id.slice(7)}\nTeamIdentifier=not set\n`;
      return { ...res(''), stderr: text };
    }
    if (file === this.helperPath) {
      try {
        return res(JSON.stringify(this.handle(args[0]!, JSON.parse(opts?.input ?? '{}'))));
      } catch (e) {
        if (e instanceof Killed) return { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: false };
        throw e;
      }
    }
    throw new Error(`fake runner: unexpected ${file}`);
  };
}
