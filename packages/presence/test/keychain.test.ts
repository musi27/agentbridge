import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SECRET_NAMES } from '@agentbridge/protocol';
import { MacKeychainStore, InMemorySecretStore, assertSecretName } from '../src/keychain.ts';
import { HelperError, type Runner, type RunOptions } from '../src/exec.ts';
import { ensureHelper } from './helpers.ts';

test('InMemorySecretStore get/set/delete', async () => {
  const s = new InMemorySecretStore();
  assert.equal(await s.get('a'), null);
  await s.set('a', 'v1');
  await s.set('a', 'v2');
  assert.equal(await s.get('a'), 'v2');
  await s.delete('a');
  await s.delete('a');
  assert.equal(await s.get('a'), null);
  assert.deepEqual(s.names(), []);
});

test('every SECRET_NAMES value is a valid name; junk is rejected', () => {
  for (const n of [SECRET_NAMES.ed25519, SECRET_NAMES.x25519, SECRET_NAMES.policyHmacKey, SECRET_NAMES.policyVersion,
    SECRET_NAMES.botToken('researcher'), SECRET_NAMES.webhookUrl('b-1'), SECRET_NAMES.webhookKey('b_2')]) assertSecretName(n);
  for (const bad of ['', '.hidden', 'a b', 'a/b', 'a\nb', 'x'.repeat(201), 'ä']) assert.throws(() => assertSecretName(bad), TypeError, bad);
});

test('MacKeychainStore: the secret value travels only on stdin, never argv/env', async () => {
  const calls: { file: string; args: readonly string[]; opts: RunOptions | undefined }[] = [];
  const runner: Runner = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const sub = args[0];
    const stdout = sub === 'keychain-get' ? '{"ok":true,"value":"s3cret"}' : sub === 'keychain-delete' ? '{"deleted":true,"ok":true}' : '{"ok":true}';
    return { code: 0, signal: null, stdout, stderr: '', timedOut: false };
  };
  const s = new MacKeychainStore({ runner, helperPath: '/x/agentbridge-helper', service: 'agentbridge.test.svc' });
  await s.set('bot.r.token', 'TOPSECRET-123');
  assert.equal(await s.get('bot.r.token'), 's3cret');
  await s.delete('bot.r.token');
  assert.deepEqual(calls.map((c) => c.args), [['keychain-set'], ['keychain-get'], ['keychain-delete']]);
  for (const c of calls) {
    assert.equal(c.file, '/x/agentbridge-helper');
    assert.ok(!JSON.stringify(c.args).includes('TOPSECRET'));
    assert.ok(!JSON.stringify(c.opts?.env).includes('TOPSECRET'));
  }
  assert.deepEqual(JSON.parse(calls[0]!.opts!.input!), { service: 'agentbridge.test.svc', account: 'bot.r.token', value: 'TOPSECRET-123' });
  assert.deepEqual(JSON.parse(calls[1]!.opts!.input!), { service: 'agentbridge.test.svc', account: 'bot.r.token' });
});

test('MacKeychainStore only accepts the production service or agentbridge.test.<suffix>', () => {
  for (const service of ['login', '', 'agentbridge.test.', 'agentbridge-test-x', 'agentbridge.test.a b']) assert.throws(() => new MacKeychainStore({ service }), TypeError, service);
  assert.equal(new MacKeychainStore().service, 'agentbridge');
  assert.equal(new MacKeychainStore({ service: 'agentbridge.test.abc-1' }).service, 'agentbridge.test.abc-1');
});

test('MacKeychainStore: keychain errors throw HelperError with the OSStatus; invalid names never reach the helper', async () => {
  let n = 0;
  const runner: Runner = async () => { n++; return { code: 0, signal: null, stdout: '{"detail":"User interaction is not allowed.","error":"keychain","ok":false,"os_status":-25308}', stderr: '', timedOut: false }; };
  const s = new MacKeychainStore({ runner });
  await assert.rejects(s.get('a'), (e: unknown) => e instanceof HelperError && /-25308/.test(e.message));
  await assert.rejects(s.set('a/b', 'v'), TypeError);
  assert.equal(n, 1);
});

// Real login keychain, unique throwaway service, always cleaned up. Skipped in CI (locked/absent keychain).
test('MacKeychainStore against the real keychain (throwaway service)', async (t) => {
  if (process.env.CI === 'true') return t.skip('CI=true');
  const h = ensureHelper();
  if ('skip' in h) return t.skip(h.skip);
  const service = `agentbridge.test.${randomBytes(6).toString('hex')}`;
  const s = new MacKeychainStore({ service });
  const names = [SECRET_NAMES.ed25519, SECRET_NAMES.botToken('t1')];
  t.after(async () => { for (const n of names) await s.delete(n).catch(() => {}); });

  assert.equal(await s.get(names[0]!), null);
  const value = `quote" backslash\\ newline\n unicode ✓ ${randomBytes(32).toString('base64')}`;
  await s.set(names[0]!, value);
  assert.equal(await s.get(names[0]!), value);
  await s.set(names[0]!, 'updated');
  assert.equal(await s.get(names[0]!), 'updated');
  await s.set(names[1]!, '');
  assert.equal(await s.get(names[1]!), '');
  // Isolation: the production service never sees the throwaway items.
  assert.equal(await new MacKeychainStore({ service: `${service}-other` }).get(names[0]!), null);
  await s.delete(names[0]!);
  await s.delete(names[0]!); // idempotent
  assert.equal(await s.get(names[0]!), null);
});

// Regression: keychain-set is delete-then-add, so an item pre-created by another process (its own
// ACL and attributes) is replaced rather than updated in place.
test('keychain-set replaces a pre-created foreign item (fresh attributes)', async (t) => {
  if (process.env.CI === 'true') return t.skip('CI=true');
  const h = ensureHelper();
  if ('skip' in h) return t.skip(h.skip);
  const service = `agentbridge.test.${randomBytes(6).toString('hex')}`;
  const s = new MacKeychainStore({ service });
  t.after(async () => { await s.delete('preseeded').catch(() => {}); });
  // Dummy value (not a secret); -A avoids an access prompt when the helper deletes it.
  execFileSync('/usr/bin/security', ['add-generic-password', '-s', service, '-a', 'preseeded', '-l', 'foreign label', '-w', 'dummy', '-A']);
  const label = () => /0x00000007 <blob>="([^"]*)"/.exec(execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', 'preseeded'], { encoding: 'utf8' }))?.[1];
  assert.equal(label(), 'foreign label');
  await s.set('preseeded', 'mine');
  assert.equal(label(), 'agentbridge: preseeded');
  assert.equal(await s.get('preseeded'), 'mine');
});
