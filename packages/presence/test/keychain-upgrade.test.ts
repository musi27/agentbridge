// The owner's 0.2.6 → 0.2.7 upgrade, reproduced: old one-per-secret items that trust only older ad-hoc builds (access
// list and partition list), a bridge already running during init (init copies, the bridge start deletes), dialogs
// answered "Allow" rather than "Always Allow", and deletes that fail for items whose partition lacks the team.
// The store must read each untrusted old item at most once, never ask again on later starts, and keep going when a
// delete fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allSecretNames, SECRET_NAMES } from '@agentbridge/protocol';
import { COMBINED_ACCOUNT, MacKeychainStore } from '../src/keychain.ts';
import { FakeKeychain } from './fake-keychain.ts';

const SVC = 'agentbridge.test.upgrade';
const TEAM = 'team:67B9AY2VHJ/live.musi.agentbridge';
const ADHOC1 = 'cdhash:14cc0001';
const ADHOC2 = 'cdhash:77aa0002';
const NAMES = allSecretNames(['g']); // 5 fixed + 3 for one Grok bot = 8, in this order
const SNAPSHOT = SECRET_NAMES.policySnapshot;
const WEBHOOK_KEY = SECRET_NAMES.webhookKey('g');

function tmp(t: { after(fn: () => void): void }): string {
  const d = mkdtempSync(join(tmpdir(), 'ab-kc-up-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** The owner's login keychain before the upgrade (access lists as `security dump-keychain -a` showed them). */
function ownersKeychain(): FakeKeychain {
  const fk = new FakeKeychain();
  for (const n of NAMES) {
    if (n === SNAPSHOT) fk.seed(SVC, n, `v-${n}`, [ADHOC1], [ADHOC1]); // rarely read: never got the signed helper
    else if (n === WEBHOOK_KEY) fk.seed(SVC, n, `v-${n}`, [ADHOC1, ADHOC2], [ADHOC1, ADHOC2]); // "Allow", not "Always Allow"
    else if (n.startsWith('bot.')) fk.seed(SVC, n, `v-${n}`, [TEAM, ADHOC1, ADHOC2], [TEAM, ADHOC1, ADHOC2]);
    else fk.seed(SVC, n, `v-${n}`, [TEAM], [TEAM]);
  }
  fk.answer = () => 'allow'; // they don't remember; "Allow" is the worst case (it is not remembered)
  fk.partitionDelete = 'fail';
  return fk;
}

const store = (fk: FakeKeychain, dir: string) => new MacKeychainStore({ runner: fk.runner, helperPath: fk.helperPath, service: SVC, stateDir: dir });
const prompts = (fk: FakeKeychain, from: number) => fk.prompts.slice(from);

async function run(fk: FakeKeychain, dir: string, o: { keepLegacy?: boolean; interactive?: boolean } = {}) {
  const lines: string[] = []; const before = fk.prompts.length;
  let error: string | null = null;
  let r: Awaited<ReturnType<MacKeychainStore['prepare']>> | null = null;
  try { r = await store(fk, dir).prepare({ legacyNames: NAMES, notice: (l) => lines.push(l), ...o }); } catch (e) { error = (e as Error).message; }
  return { r, error, lines, prompts: prompts(fk, before) };
}

test('owner upgrade: init (bridge running) copies, bridge start deletes; each untrusted old item read once; later starts never ask', async (t) => {
  const fk = ownersKeychain(); const dir = tmp(t);

  // init while the old bridge runs: copy only. Two old items don't trust this helper: two dialogs, warned first.
  const init = await run(fk, dir, { keepLegacy: true, interactive: true });
  assert.equal(init.error, null);
  assert.deepEqual(init.prompts.sort(), [SNAPSHOT, WEBHOOK_KEY].sort());
  assert.equal(init.r!.copied, 8);
  assert.equal(init.lines.length, 1);
  const all = JSON.parse(fk.value(SVC, COMBINED_ACCOUNT)!).secrets as Record<string, string>;
  assert.deepEqual(Object.keys(all).sort(), [...NAMES].sort());

  // the bridge starts on the new version: reads nothing old, deletes what it can, keeps going past failures
  const start1 = await run(fk, dir);
  assert.equal(start1.error, null);
  assert.deepEqual(start1.prompts, [], 'no dialog at bridge start');
  assert.equal(start1.lines.length, 0, 'no warning when nothing will be read');
  assert.deepEqual([start1.r!.copied, start1.r!.removed, start1.r!.kept], [0, 6, 2]);
  assert.deepEqual(fk.accounts(SVC).sort(), [COMBINED_ACCOUNT, SNAPSHOT, WEBHOOK_KEY].sort());

  // every later start of this build: no dialog, no retry of the failed deletes
  for (let i = 0; i < 3; i++) {
    const n = fk.ops.length;
    const s = await run(fk, dir);
    assert.equal(s.error, null);
    assert.deepEqual([s.prompts, s.lines, s.r!.removed, s.r!.kept], [[], [], 0, 2]);
    assert.ok(!fk.ops.slice(n).some((o) => o.account === SNAPSHOT || o.account === WEBHOOK_KEY), 'no read or delete of the leftovers');
  }

  // every secret still reads, silently, from the one item
  const s = store(fk, dir);
  for (const n of NAMES) assert.equal(await s.get(n), `v-${n}`);
  assert.deepEqual(prompts(fk, 2), []);
  // doctor's view: which old items are left (attributes only)
  assert.deepEqual((await s.leftovers(NAMES)).sort(), [SNAPSHOT, WEBHOOK_KEY].sort());
});

test('a delete that asks first and is denied: asked once per build, never on later starts; a new release tries once more', async (t) => {
  const fk = ownersKeychain(); const dir = tmp(t);
  fk.partitionDelete = 'prompt'; fk.answer = (a) => (a === SNAPSHOT || a === WEBHOOK_KEY ? 'allow' : 'always');
  await run(fk, dir, { keepLegacy: true, interactive: true });
  fk.answer = () => 'deny';
  const start1 = await run(fk, dir);
  assert.deepEqual(start1.prompts.sort(), [`delete ${SNAPSHOT}`, `delete ${WEBHOOK_KEY}`].sort());
  assert.deepEqual([start1.r!.removed, start1.r!.kept], [6, 2]);
  const start2 = await run(fk, dir);
  assert.deepEqual([start2.prompts, start2.r!.kept], [[], 2]);
  // the next release (new cdhash, same team): one more try each, then quiet again
  fk.cdhash = 'feed0002'; fk.answer = () => 'always';
  const next = await run(fk, dir);
  assert.deepEqual([next.prompts.length, next.r!.removed, next.r!.kept], [2, 2, 0]);
  assert.deepEqual(fk.accounts(SVC), [COMBINED_ACCOUNT]);
  assert.deepEqual(await store(fk, dir).leftovers(NAMES), []);
});

test('a refused read: other items still move; the bridge start does not ask again (same build); init retries; get never asks for it', async (t) => {
  const fk = ownersKeychain(); const dir = tmp(t);
  fk.answer = (a) => (a === SNAPSHOT ? 'deny' : 'always');
  const start1 = await run(fk, dir); // no init first: the bridge starts on the new version straight away
  assert.equal(start1.error, null);
  assert.deepEqual(start1.prompts.sort(), [SNAPSHOT, WEBHOOK_KEY].sort());
  assert.deepEqual([start1.r!.copied, start1.r!.unread], [7, 1]);
  assert.equal(fk.value(SVC, SNAPSHOT), `v-${SNAPSHOT}`, 'the refused item is kept, nothing lost');
  const start2 = await run(fk, dir);
  assert.deepEqual([start2.prompts, start2.lines, start2.r!.unread], [[], [], 1]);
  const before = fk.prompts.length;
  assert.equal(await store(fk, dir).get(SNAPSHOT), null, 'no fallback read of a refused item');
  assert.equal(fk.prompts.length, before);
  // init (a person at the terminal) asks again; refused again → init fails, says nothing was lost
  const init = await run(fk, dir, { interactive: true });
  assert.deepEqual(init.prompts, [SNAPSHOT]);
  assert.equal(init.lines.length, 1);
  assert.match(init.error!, /could not read the old keychain item "agentbridge: policy\.snapshot".*nothing was lost/);
  // allowed this time → copied, deleted, back to normal
  fk.answer = () => 'always'; fk.partitionDelete = 'ok';
  const init2 = await run(fk, dir, { interactive: true });
  assert.deepEqual([init2.error, init2.r!.copied, init2.r!.removed, init2.r!.unread], [null, 1, 1, 0]);
  assert.equal(await store(fk, dir).get(SNAPSHOT), `v-${SNAPSHOT}`);
  assert.deepEqual(fk.accounts(SVC), [COMBINED_ACCOUNT]);
});

test('no dialog possible (errSecInteractionNotAllowed): not remembered, tried again next start', async (t) => {
  const fk = new FakeKeychain(); const dir = tmp(t);
  fk.seed(SVC, SECRET_NAMES.ed25519, 'id', [ADHOC1]);
  const real = fk.runner;
  let locked = true;
  fk.runner = async (file, args, opts) => (locked && file === fk.helperPath && args[0] === 'keychain-get' && opts?.input?.includes(SECRET_NAMES.ed25519)
    ? { code: 0, signal: null, stdout: JSON.stringify({ ok: false, error: 'keychain', detail: 'User interaction is not allowed.', os_status: -25308 }), stderr: '', timedOut: false }
    : real(file, args, opts));
  const r1 = await run(fk, dir);
  assert.deepEqual([r1.error, r1.r!.copied, r1.r!.unread], [null, 0, 1]);
  locked = false;
  const r2 = await run(fk, dir);
  assert.deepEqual([r2.r!.copied, r2.r!.removed], [1, 1]);
});

test('warning counts only old items that will be read (names missing from the one item)', async (t) => {
  const fk = ownersKeychain(); const dir = tmp(t);
  fk.answer = () => 'always';
  const init = await run(fk, dir, { keepLegacy: true, interactive: true });
  assert.match(init.lines[0]!, /moving 8 saved keys .*up to 8 times, only during this move/);
  // a bot added by the old bridge after init: one new old-layout item, the rest are only deleted
  fk.seed(SVC, SECRET_NAMES.botToken('h'), 'new', [ADHOC1]);
  const r = await store(fk, dir).prepare({ legacyNames: [...NAMES, SECRET_NAMES.botToken('h')], notice: (l) => init.lines.push(l) });
  assert.equal(init.lines[1], 'AgentBridge is moving 1 saved key into one keychain item. If macOS asks for your login password (once, only during this move), enter it and choose Always Allow.');
  assert.deepEqual([r.asks, r.copied, r.removed], [1, 1, 9]);
});

test('removing a secret whose old item macOS refuses to delete: the removal still works and the old item never comes back', async (t) => {
  const fk = new FakeKeychain(); const dir = tmp(t);
  const s = store(fk, dir);
  await s.set(SECRET_NAMES.botToken('x'), 'new');
  fk.seed(SVC, SECRET_NAMES.botToken('x'), 'old', [ADHOC1], [ADHOC1]); fk.partitionDelete = 'fail';
  await s.delete(SECRET_NAMES.botToken('x'));
  const before = fk.prompts.length;
  assert.equal(await s.get(SECRET_NAMES.botToken('x')), null);
  assert.equal(fk.prompts.length, before);
  assert.deepEqual(await s.leftovers([SECRET_NAMES.botToken('x')]), [SECRET_NAMES.botToken('x')]);
});

test('purge keeps going past a refused delete, then names the manual command', async (t) => {
  const fk = ownersKeychain(); const dir = tmp(t);
  fk.answer = () => 'always';
  await run(fk, dir, { keepLegacy: true });
  // "Always Allow" added this helper to their partition lists in the fake; make two refuse again
  fk.seed(SVC, SNAPSHOT, 'x', [ADHOC1], [ADHOC1]); fk.seed(SVC, WEBHOOK_KEY, 'x', [ADHOC1], [ADHOC1]);
  await assert.rejects(store(fk, dir).purge(NAMES), /refused to delete 2 old keychain item\(s\); delete them with: security delete-generic-password -s agentbridge\.test\.upgrade -a policy\.snapshot; security delete-generic-password -s agentbridge\.test\.upgrade -a bot\.g\.webhook_key/);
  assert.deepEqual(fk.accounts(SVC).sort(), [SNAPSHOT, WEBHOOK_KEY].sort());
});
