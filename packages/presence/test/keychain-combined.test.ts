// The one-item keychain store (MacKeychainStore): layout, the move from one item per secret, crash safety,
// concurrent writers, and when it warns before a macOS password prompt. All against FakeKeychain (no real keychain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { allSecretNames, SECRET_NAMES } from '@agentbridge/protocol';
import { COMBINED_ACCOUNT, STAGING_ACCOUNT, MacKeychainStore, TRUST_FILE, LOCK_FILE, helperCodeIdentity, itemLabel, promptNotice, type MacKeychainStoreOptions } from '../src/keychain.ts';
import { withFileLock, LockTimeoutError } from '../src/keychain-lock.ts';
import { FakeKeychain } from './fake-keychain.ts';

const SVC = 'agentbridge.test.unit';
const AD_HOC_OLD = 'cdhash:aaaa1111';
const TEAM = 'team:67B9AY2VHJ/live.musi.agentbridge';
const OTHER_TEAM = 'team:ZZZZZZZZZZ/live.musi.agentbridge';

function tmp(t: { after(fn: () => void): void }): string {
  const d = mkdtempSync(join(tmpdir(), 'ab-kc-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function store(fk: FakeKeychain, stateDir: string | undefined, extra: Partial<MacKeychainStoreOptions> = {}): MacKeychainStore {
  return new MacKeychainStore({ runner: fk.runner, helperPath: fk.helperPath, service: SVC, ...(stateDir === undefined ? {} : { stateDir }), ...extra });
}

/** The 0.2.6 layout: one item per secret (two Grok bots: 11 items). */
const LEGACY = Object.fromEntries(allSecretNames(['b1', 'b2']).map((n, i) => [n, `value-${i}-${n}`]));
function seedLegacy(fk: FakeKeychain, trusts: string): void { for (const [n, v] of Object.entries(LEGACY)) fk.seed(SVC, n, v, trusts); }

async function assertAllLegacyReadable(s: MacKeychainStore): Promise<void> {
  for (const [n, v] of Object.entries(LEGACY)) assert.equal(await s.get(n), v, n);
}

const notices = () => { const lines: string[] = []; return { lines, notice: (l: string) => { lines.push(l); } }; };

test('all secrets live in one item ("agentbridge: saved keys"); values only travel on stdin', async (t) => {
  const fk = new FakeKeychain();
  const inputs: string[] = []; const argv: string[] = [];
  const runner: typeof fk.runner = async (file, args, opts) => { argv.push(JSON.stringify(args)); if (file === fk.helperPath) inputs.push(opts?.input ?? ''); return fk.runner(file, args, opts); };
  const s = new MacKeychainStore({ runner, helperPath: fk.helperPath, service: SVC, stateDir: tmp(t) });
  await s.set(SECRET_NAMES.ed25519, 'TOPSECRET-1');
  await s.set(SECRET_NAMES.botToken('r'), 'TOPSECRET-2');
  await s.set(SECRET_NAMES.policyVersion, '3');
  assert.deepEqual(fk.accounts(SVC), [COMBINED_ACCOUNT]);
  assert.equal(itemLabel(COMBINED_ACCOUNT), 'agentbridge: saved keys');
  assert.equal(await s.get(SECRET_NAMES.ed25519), 'TOPSECRET-1');
  assert.equal(await s.get(SECRET_NAMES.policyHmacKey), null);
  await s.delete(SECRET_NAMES.botToken('r'));
  assert.equal(await s.get(SECRET_NAMES.botToken('r')), null);
  assert.deepEqual(Object.keys(JSON.parse(fk.value(SVC, COMBINED_ACCOUNT)!).secrets).sort(), [SECRET_NAMES.ed25519, SECRET_NAMES.policyVersion]);
  assert.ok(!argv.join().includes('TOPSECRET'));
  assert.ok(inputs.some((i) => i.includes('TOPSECRET-1')));
  // deleting the last secret removes the item
  await s.delete(SECRET_NAMES.ed25519); await s.delete(SECRET_NAMES.policyVersion);
  assert.deepEqual(fk.accounts(SVC), []);
  assert.equal(fk.prompts.length, 0);
});

test('move from one item per secret: silent when the helper is trusted, everything readable, old items gone', async (t) => {
  const fk = new FakeKeychain(); const dir = tmp(t);
  seedLegacy(fk, TEAM); // created by the signed 0.2.6 helper (or allowed after it asked)
  const s = store(fk, dir);
  const n = notices();
  const r = await s.prepare({ legacyNames: Object.keys(LEGACY), notice: n.notice });
  assert.equal(fk.prompts.length, 0, 'no dialog');
  assert.equal(r.copied, 11); assert.equal(r.removed, 11);
  assert.deepEqual(fk.accounts(SVC), [COMBINED_ACCOUNT]);
  await assertAllLegacyReadable(s);
  // No trust marker yet (0.2.6 wrote none), so this first move warns though nothing asks: see the PR / README.
  assert.equal(r.warned, true); assert.equal(n.lines.length, 1);
  // idempotent, and from now on quiet
  const n2 = notices();
  const r2 = await s.prepare({ legacyNames: Object.keys(LEGACY), notice: n2.notice });
  assert.deepEqual([r2.copied, r2.removed, r2.warned, n2.lines.length], [0, 0, false, 0]);
  await assertAllLegacyReadable(s);
});

test('move from ad-hoc items: warns first, then one dialog per old item, once; the combined item never asks again', async (t) => {
  const fk = new FakeKeychain(); const dir = tmp(t);
  seedLegacy(fk, AD_HOC_OLD); // saved by an ad-hoc helper (0.2.5 and earlier)
  const s = store(fk, dir);
  const order: string[] = [];
  const runner = fk.runner;
  fk.runner = async (file, args, opts) => { if (file === fk.helperPath && args[0] === 'keychain-get') order.push('read'); return runner(file, args, opts); };
  const s2 = new MacKeychainStore({ runner: fk.runner, helperPath: fk.helperPath, service: SVC, stateDir: dir });
  const r = await s2.prepare({ legacyNames: Object.keys(LEGACY), notice: (l) => order.push(`notice: ${l}`) });
  assert.match(order[0]!, /^notice: AgentBridge is moving its 11 saved keys into one keychain item\. If macOS asks for your login password \(up to 11 times/);
  assert.equal(r.asks, 11);
  assert.equal(fk.prompts.length, 11);
  fk.prompts = [];
  await assertAllLegacyReadable(s);
  assert.equal(fk.prompts.length, 0);
});

test('keepLegacy copies without deleting; the next prepare deletes; a stale old item never beats the combined item', async (t) => {
  const fk = new FakeKeychain(); const dir = tmp(t);
  seedLegacy(fk, TEAM);
  const s = store(fk, dir);
  const r = await s.prepare({ legacyNames: Object.keys(LEGACY), notice: () => {}, keepLegacy: true });
  assert.deepEqual([r.copied, r.removed], [11, 0]);
  assert.equal(fk.accounts(SVC).length, 12);
  await s.set(SECRET_NAMES.policyVersion, 'newer'); // the old item still says the old value
  assert.equal(await s.get(SECRET_NAMES.policyVersion), 'newer');
  const r2 = await s.prepare({ legacyNames: Object.keys(LEGACY), notice: () => {} });
  assert.deepEqual([r2.copied, r2.removed], [0, 11]);
  assert.equal(await s.get(SECRET_NAMES.policyVersion), 'newer');
  assert.deepEqual(fk.accounts(SVC), [COMBINED_ACCOUNT]);
});

test('get falls back to an old item for a name prepare was not told about', async (t) => {
  const fk = new FakeKeychain();
  fk.seed(SVC, SECRET_NAMES.botToken('unknown'), 'tok');
  fk.seed(SVC, SECRET_NAMES.ed25519, 'id');
  const s = store(fk, tmp(t));
  await s.prepare({ legacyNames: [SECRET_NAMES.ed25519], notice: () => {} });
  assert.equal(await s.get(SECRET_NAMES.botToken('unknown')), 'tok');
  assert.equal(await s.get(SECRET_NAMES.ed25519), 'id');
  await s.delete(SECRET_NAMES.botToken('unknown')); // deletes the old item too, so it can't come back
  assert.equal(await s.get(SECRET_NAMES.botToken('unknown')), null);
  assert.deepEqual(fk.accounts(SVC), [COMBINED_ACCOUNT]);
});

test('a move killed at any point: the next run recovers with nothing lost', async (t) => {
  // count the ops of an uninterrupted move first
  const probe = new FakeKeychain(); seedLegacy(probe, TEAM);
  await store(probe, tmp(t)).prepare({ legacyNames: Object.keys(LEGACY), notice: () => {} });
  const total = probe.ops.length;
  assert.ok(total > 20, `ops: ${total}`);
  for (let k = 0; k < total; k++) {
    const fk = new FakeKeychain(); const dir = tmp(t);
    seedLegacy(fk, TEAM);
    fk.killAt = (_op, i) => i === k;
    await assert.rejects(store(fk, dir).prepare({ legacyNames: Object.keys(LEGACY), notice: () => {} }), /killed by SIGKILL/, `kill at op ${k}`);
    fk.killAt = null;
    const s = store(fk, dir);
    // every secret is readable even before the next prepare runs (old items fill gaps; a half-written item is finished)
    await assertAllLegacyReadable(s);
    await s.prepare({ legacyNames: Object.keys(LEGACY), notice: () => {} });
    await assertAllLegacyReadable(s);
    assert.deepEqual(fk.accounts(SVC), [COMBINED_ACCOUNT], `kill at op ${k}`);
  }
});

test('a write killed at any point keeps every other secret and leaves the written one old or new', async (t) => {
  const base = { a: '1', b: '2', c: '3' };
  const probe = new FakeKeychain(); const pd = tmp(t);
  const ps = store(probe, pd); for (const [k, v] of Object.entries(base)) await ps.set(k, v);
  const from = probe.ops.length; await ps.set('b', 'NEW'); const total = probe.ops.length - from;
  for (let k = 0; k < total; k++) {
    const fk = new FakeKeychain(); const dir = tmp(t);
    const s = store(fk, dir); for (const [n, v] of Object.entries(base)) await s.set(n, v);
    const start = fk.ops.length;
    fk.killAt = (_op, i) => i === start + k;
    await assert.rejects(s.set('b', 'NEW'), /killed by SIGKILL/);
    fk.killAt = null;
    const s2 = store(fk, dir);
    assert.equal(await s2.get('a'), '1'); assert.equal(await s2.get('c'), '3');
    assert.ok(['2', 'NEW'].includes((await s2.get('b'))!), `kill at write op ${k}`);
    await s2.set('d', '4'); // the next write finishes or drops the interrupted one
    assert.deepEqual(fk.accounts(SVC), [COMBINED_ACCOUNT]);
    assert.equal(await s2.get('a'), '1'); assert.equal(await s2.get('d'), '4');
  }
});

test('a leftover update item wins only when newer; a corrupt or newer-format item is never overwritten', async (t) => {
  const fk = new FakeKeychain(); const dir = tmp(t);
  fk.seed(SVC, COMBINED_ACCOUNT, JSON.stringify({ agentbridge_keys: 1, gen: 5, secrets: { a: 'old' } }));
  fk.seed(SVC, STAGING_ACCOUNT, JSON.stringify({ agentbridge_keys: 1, gen: 4, secrets: { a: 'older' } }));
  const s = store(fk, dir);
  await s.set('b', 'x');
  assert.equal(await s.get('a'), 'old');
  assert.deepEqual(fk.accounts(SVC), [COMBINED_ACCOUNT]);

  fk.seed(SVC, COMBINED_ACCOUNT, JSON.stringify({ agentbridge_keys: 2, gen: 1, secrets: {} }));
  await assert.rejects(s.set('c', 'y'), /saved by a newer agentbridge/);
  await assert.rejects(s.get('a'), /newer agentbridge/);
  fk.seed(SVC, COMBINED_ACCOUNT, 'not json');
  await assert.rejects(s.set('c', 'y'), /not valid JSON; not overwriting/);
  assert.equal(fk.value(SVC, COMBINED_ACCOUNT), 'not json');
});

test('concurrent writers in one process: no lost updates', async (t) => {
  const fk = new FakeKeychain(); const dir = tmp(t);
  const a = store(fk, dir); const b = store(fk, dir);
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).set(`k${i}`, `v${i}`)));
  for (let i = 0; i < 30; i++) assert.equal(await a.get(`k${i}`), `v${i}`);
});

test('without the lock, concurrent read-modify-writes lose updates (why the lock exists)', async () => {
  const fk = new FakeKeychain();
  // separate in-process keys = no shared lock
  const s1 = new MacKeychainStore({ runner: fk.runner, helperPath: fk.helperPath, service: 'agentbridge.test.nolock1' });
  const items = s1.items;
  const rmw = async (k: string) => { const raw = await items.get(COMBINED_ACCOUNT); const r = raw ? JSON.parse(raw) : { agentbridge_keys: 1, gen: 0, secrets: {} }; await new Promise((res) => setTimeout(res, 5)); r.secrets[k] = 'v'; await items.set(COMBINED_ACCOUNT, JSON.stringify(r)); };
  await Promise.all(['x', 'y', 'z'].map(rmw));
  assert.ok(Object.keys(JSON.parse(fk.value('agentbridge.test.nolock1', COMBINED_ACCOUNT)!).secrets).length < 3);
});

test('concurrent writers in separate processes (bridge service + CLI): no lost updates', async (t) => {
  const dir = tmp(t);
  const state = join(dir, 'fake-keychain.json');
  const child = new URL('./fixtures/keychain-writer.ts', import.meta.url).pathname;
  const run = promisify(execFile);
  await Promise.all(['p1', 'p2', 'p3', 'p4'].map((p) => run(process.execPath, ['--conditions=agentbridge-source', child, dir, state, p, '8'])));
  const fk = new FakeKeychain({ statePath: state });
  const s = new MacKeychainStore({ runner: fk.runner, helperPath: fk.helperPath, service: 'agentbridge.test.concurrent', stateDir: dir });
  for (const p of ['p1', 'p2', 'p3', 'p4']) for (let i = 0; i < 8; i++) assert.equal(await s.get(`${p}.${i}`), `v-${p}-${i}`);
  assert.equal(existsSync(join(dir, `keychain-agentbridge.test.concurrent.lock`)), false, 'lock released');
});

test('warning: when macOS is likely to ask, and not otherwise', async (t) => {
  const legacyNames = Object.keys(LEGACY);
  const check = async (fk: FakeKeychain, dir: string) => { const n = notices(); const before = fk.prompts.length; const r = await store(fk, dir).prepare({ legacyNames, notice: n.notice }); return { warned: n.lines.length > 0, line: n.lines[0], prompted: fk.prompts.length - before, r }; };

  // fresh install: nothing saved → no warning; init then saves keys (this helper trusts its own item)
  const fk = new FakeKeychain(); const dir = tmp(t);
  assert.deepEqual((await check(fk, dir)).warned, false);
  await store(fk, dir).set(SECRET_NAMES.ed25519, 'id');
  // the next start, same helper (any later build of the same team) → quiet and silent
  let c = await check(fk, dir); assert.deepEqual([c.warned, c.prompted], [false, 0]);
  // a different team's helper (re-trust) → one warning, one dialog
  fk.identity = OTHER_TEAM;
  c = await check(fk, dir); assert.deepEqual([c.warned, c.prompted, c.r.asks], [true, 1, 1]);
  assert.equal(c.line, promptNotice(1, 0));
  assert.match(c.line!, /^macOS may ask for your login password once so AgentBridge can read its saved keys\. Enter it and choose Always Allow\.$/);
  c = await check(fk, dir); assert.deepEqual([c.warned, c.prompted], [false, 0]);
  // ad-hoc builds: each rebuild is a new identity
  fk.identity = 'cdhash:1111'; c = await check(fk, dir); assert.deepEqual([c.warned, c.prompted], [true, 1]);
  fk.identity = 'cdhash:2222'; c = await check(fk, dir); assert.deepEqual([c.warned, c.prompted], [true, 1]);
  // keychain copied to another Mac (no trust marker there) → warns
  rmSync(join(dir, TRUST_FILE)); c = await check(fk, dir); assert.equal(c.warned, true);
  // codesign can't tell the identity: quiet once a marker exists
  const fk2 = new FakeKeychain(); const d2 = tmp(t); fk2.seed(SVC, COMBINED_ACCOUNT, JSON.stringify({ agentbridge_keys: 1, gen: 1, secrets: { a: 'b' } }));
  const s2 = store(fk2, d2, { helperIdentity: async () => null });
  const n = notices(); await s2.prepare({ legacyNames, notice: n.notice }); assert.equal(n.lines.length, 1);
  const n2 = notices(); await s2.prepare({ legacyNames, notice: n2.notice }); assert.equal(n2.lines.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(d2, TRUST_FILE), 'utf8')), { v: 1, services: { [SVC]: 'unknown' } });
});

test('purge deletes the combined item, a leftover update item and old items', async (t) => {
  const fk = new FakeKeychain(); const dir = tmp(t);
  const s = store(fk, dir);
  await s.set('a', '1'); await s.set('b', '2');
  fk.seed(SVC, STAGING_ACCOUNT, JSON.stringify({ agentbridge_keys: 1, gen: 1, secrets: { a: '1' } }));
  fk.seed(SVC, SECRET_NAMES.botToken('old'), 't');
  await s.prepare({ legacyNames: [], notice: () => {} });
  assert.equal(existsSync(join(dir, TRUST_FILE)), true);
  assert.equal(await s.purge([SECRET_NAMES.botToken('old'), SECRET_NAMES.ed25519]), 3);
  assert.deepEqual(fk.accounts(SVC), []);
  assert.equal(existsSync(join(dir, TRUST_FILE)), false);
  assert.equal(await s.purge([]), 0);
});

test('helperCodeIdentity: Developer ID → team + identifier; ad hoc → cdhash', async () => {
  const fk = new FakeKeychain();
  assert.equal(await helperCodeIdentity({ runner: fk.runner }), TEAM);
  fk.identity = 'cdhash:abc123';
  assert.equal(await helperCodeIdentity({ runner: fk.runner }), 'cdhash:abc123');
  assert.equal(await helperCodeIdentity({ runner: async () => { throw new Error('no codesign'); } }), null);
});

test('file lock: takes over a dead holder, times out on a live one', async (t) => {
  const dir = tmp(t); const path = join(dir, LOCK_FILE);
  writeFileSync(path, '999999 deadbeef\n');
  assert.equal(await withFileLock(path, async () => 'ran', { pidAlive: () => false }), 'ran');
  assert.equal(existsSync(path), false);
  writeFileSync(path, `${process.pid} other\n`);
  await assert.rejects(withFileLock(path, async () => 'never', { timeoutMs: 100 }), LockTimeoutError);
  // too old counts as stale whatever the pid says
  assert.equal(await withFileLock(path, async () => 'ran', { staleMs: -1 }), 'ran');
});
