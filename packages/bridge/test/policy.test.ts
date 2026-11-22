import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_NAMES } from '@agentbridge/protocol';
import { openDatabase } from '../src/db/db.ts';
import { Store } from '../src/db/store.ts';
import { PolicyStore, MemorySecretStore } from '../src/policy/integrity.ts';
import { DEFAULT_POLICY, applySetting, parseDuration, formatDuration, describePolicy, isSelfHostedRelay } from '../src/policy/policy.ts';
import { decide, parseRule, matchPattern } from '../src/policy/allowlist.ts';

async function fresh() {
  const store = new Store(openDatabase(':memory:')); const secrets = new MemorySecretStore();
  const ps = new PolicyStore(store, secrets); await ps.load(); return { store, secrets, ps };
}

test('policy: first run initialises signed defaults (version 1)', async () => {
  const { ps, secrets, store } = await fresh();
  const s = ps.current(); assert.ok(s.ok); assert.equal(s.version, 1); assert.deepEqual(s.policy, DEFAULT_POLICY);
  assert.equal(await secrets.get(SECRET_NAMES.policyVersion), '1');
  assert.ok(await secrets.get(SECRET_NAMES.policyHmacKey));
  // reload verifies cleanly
  const again = new PolicyStore(store, secrets); assert.ok((await again.load()).ok);
});

test('policy: change increments version and re-signs', async () => {
  const { ps, secrets, store } = await fresh();
  const v = await ps.set(applySetting(ps.policy(), 'approval.mode', 'auto'));
  assert.equal(v, 2); assert.equal(await secrets.get(SECRET_NAMES.policyVersion), '2');
  const again = new PolicyStore(store, secrets); const s = await again.load();
  assert.ok(s.ok); assert.equal(s.policy.approval.mode, 'auto');
});

test('policy: a directly edited row fails closed (hmac_mismatch) — §19.3 #4', async () => {
  const { secrets, store } = await fresh();
  store.db.run(`UPDATE policy SET value = '{"mode":"auto","timeout_ms":600000}' WHERE key = 'approval'`);
  const s = await new PolicyStore(store, secrets).load();
  assert.equal(s.ok, false); assert.equal(!s.ok && s.reason, 'hmac_mismatch');
});

test('policy: added or deleted rows fail closed', async () => {
  const { secrets, store } = await fresh();
  store.db.run(`INSERT INTO policy (key, value) VALUES ('extra', '1')`);
  assert.equal((await new PolicyStore(store, secrets).load()).ok, false);
  store.db.run(`DELETE FROM policy WHERE key = 'extra'`);
  assert.equal((await new PolicyStore(store, secrets).load()).ok, true);
  store.db.run(`DELETE FROM policy WHERE key = 'delivery'`);
  assert.equal((await new PolicyStore(store, secrets).load()).ok, false);
});

test('policy: rollback to an older signed copy is detected', async () => {
  const { ps, secrets, store } = await fresh();
  const old = store.policyRows();
  await ps.set(applySetting(ps.policy(), 'limits.turns', '50'));
  store.replacePolicy(old);
  const s = await new PolicyStore(store, secrets).load();
  assert.equal(!s.ok && s.reason, 'rollback');
});

test('policy: missing key or missing rows fail closed', async () => {
  const a = await fresh(); await a.secrets.delete(SECRET_NAMES.policyHmacKey);
  assert.equal(((await new PolicyStore(a.store, a.secrets).load()) as { reason: string }).reason, 'missing_key');
  const b = await fresh(); b.store.replacePolicy([]);
  assert.equal(((await new PolicyStore(b.store, b.secrets).load()) as { reason: string }).reason, 'missing_policy');
});

test('policy: crash between DB commit and keychain update is repaired (version = keychain + 1, valid HMAC)', async () => {
  const { ps, secrets, store } = await fresh();
  await ps.set(applySetting(ps.policy(), 'limits.turns', '40'));
  await secrets.set(SECRET_NAMES.policyVersion, '1');
  const s = await new PolicyStore(store, secrets).load();
  assert.ok(s.ok); assert.equal(await secrets.get(SECRET_NAMES.policyVersion), '2');
});

test('policy: set is refused while tampered; verify can re-approve or restore', async () => {
  const { ps, secrets, store } = await fresh();
  await ps.set(applySetting(ps.policy(), 'limits.turns', '40'));
  store.db.run(`UPDATE policy SET value = '{"inactivity_notice_ms":3600000,"turns":99}' WHERE key = 'limits'`);
  const p2 = new PolicyStore(store, secrets); await p2.load();
  await assert.rejects(p2.set(DEFAULT_POLICY));
  const insp = await p2.inspect();
  assert.equal(insp.current?.limits.turns, 99); assert.equal(insp.lastVerified?.limits.turns, 40);
  await p2.restoreLastVerified();
  assert.equal(p2.policy().limits.turns, 40);
  store.db.run(`UPDATE policy SET value = '{"inactivity_notice_ms":3600000,"turns":77}' WHERE key = 'limits'`);
  const p3 = new PolicyStore(store, secrets); assert.equal((await p3.load()).ok, false);
  await p3.reapproveCurrent(); assert.equal(p3.policy().limits.turns, 77);
  assert.ok((await new PolicyStore(store, secrets).load()).ok);
});

test('policy: settings parse and validate', () => {
  assert.equal(parseDuration('10m'), 600_000); assert.equal(parseDuration('7d'), 604_800_000); assert.equal(parseDuration('250'), 250);
  assert.throws(() => parseDuration('ten'));
  assert.equal(formatDuration(600_000), '10m');
  assert.throws(() => applySetting(DEFAULT_POLICY, 'limits.turns', '201'));
  assert.throws(() => applySetting(DEFAULT_POLICY, 'approval.mode', 'manual'));
  assert.throws(() => applySetting(DEFAULT_POLICY, 'nope', '1'));
  assert.throws(() => applySetting(DEFAULT_POLICY, 'queue.expiry', '8d'));
  const p = applySetting(applySetting(DEFAULT_POLICY, 'allowlist.add', 'allow claude:* -> grok:*'), 'allowlist.add', 'deny *  ->  grok:evil');
  assert.deepEqual(p.allowlist, ['allow claude:* -> grok:*', 'deny * -> grok:evil']);
  assert.deepEqual(applySetting(p, 'allowlist.remove', '1').allowlist, ['deny * -> grok:evil']);
  assert.equal(describePolicy(p)['approval.timeout'], '10m');
  assert.equal(isSelfHostedRelay(DEFAULT_POLICY), false);
  assert.equal(isSelfHostedRelay(applySetting(DEFAULT_POLICY, 'transport.relay_url', 'https://relay.example.org')), true);
});

test('allowlist: parse, globs and cwd prefix', () => {
  assert.throws(() => parseRule('permit a -> b'));
  assert.throws(() => parseRule('allow claude:x -> grok:y cwd relative/path'));
  assert.ok(matchPattern('grok:res*', 'grok:researcher')); assert.ok(!matchPattern('grok:res*', 'claude:researcher'));
  assert.ok(matchPattern('*', 'claude:a')); assert.ok(matchPattern('*:a', 'grok:a'));
  const r = [parseRule('allow claude:* -> grok:* cwd /Users/me/work')];
  assert.equal(decide(r, 'auto', { from: 'claude:a', to: 'grok:b', cwd: '/Users/me/work/x' }).kind, 'auto');
  assert.equal(decide(r, 'auto', { from: 'claude:a', to: 'grok:b', cwd: '/Users/me/workshop' }).kind, 'approval');
  assert.equal(decide(r, 'auto', { from: 'claude:a', to: 'grok:b', cwd: null }).kind, 'approval');
});

test('allowlist: §7.5 decision order', () => {
  const rules = [parseRule('deny * -> grok:evil'), parseRule('allow claude:* -> grok:*')];
  // deny wins in every mode
  assert.equal(decide(rules, 'auto', { from: 'claude:a', to: 'grok:evil' }).kind, 'deny');
  assert.equal(decide(rules, 'per_conversation', { from: 'claude:a', to: 'grok:evil' }).kind, 'deny');
  // allow only in auto
  assert.equal(decide(rules, 'auto', { from: 'claude:a', to: 'grok:good' }).kind, 'auto');
  assert.equal(decide(rules, 'per_conversation', { from: 'claude:a', to: 'grok:good' }).kind, 'approval');
  // empty allowlist in auto = per_conversation
  assert.equal(decide([], 'auto', { from: 'claude:a', to: 'grok:good' }).kind, 'approval');
  // relay-origin exception
  assert.equal(decide(rules, 'auto', { from: 'grok:good', to: 'claude:a' }, false).kind, 'approval');
  assert.equal(decide([parseRule('allow * -> *')], 'auto', { from: 'grok:good', to: 'claude:a' }, false).kind, 'approval');
});
