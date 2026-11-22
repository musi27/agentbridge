import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyHelper, createSecretStore, createPresenceChecker, createNotifier, isLaunchdContext, ContextAwareNotifier, HelperMissingError, NotificationUnavailableError } from '../src/factories.ts';
import { MacKeychainStore } from '../src/keychain.ts';
import { MacPresenceChecker } from '../src/presence.ts';
import type { Runner } from '../src/exec.ts';
import { ensureHelper } from './helpers.ts';

const reply = (stdout: string, code = 0): Runner => async () => ({ code, signal: null, stdout, stderr: '', timedOut: false });

test('missing helper → HelperMissingError telling the user to run the build', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only');
  for (const p of [verifyHelper({ helperPath: '/nonexistent/agentbridge-helper' }), createSecretStore({ helperPath: '/nonexistent/agentbridge-helper' }), createPresenceChecker({ helperPath: '/nonexistent/agentbridge-helper' })]) {
    await assert.rejects(p, (e: unknown) => e instanceof HelperMissingError && /agentbridge-helper missing at \/nonexistent.*run the build/.test(e.message));
  }
});

test('helper that does not answer or speaks another protocol → HelperMissingError', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only');
  await assert.rejects(verifyHelper({ runner: reply('garbage', 1) }), (e: unknown) => e instanceof HelperMissingError && /does not answer/.test(e.message));
  await assert.rejects(verifyHelper({ runner: reply('{"ok":true,"protocol":2,"version":"9"}') }), /unexpected protocol/);
  await assert.rejects(verifyHelper({ runner: async () => { throw new Error('spawn EACCES'); } }), /does not answer/);
});

test('factories return the macOS implementations once the real helper answers', async (t) => {
  const h = ensureHelper();
  if ('skip' in h) return t.skip(h.skip);
  assert.deepEqual(await verifyHelper(), { path: h.path, version: '0.1.0' });
  assert.ok(await createSecretStore() instanceof MacKeychainStore);
  assert.ok(await createPresenceChecker() instanceof MacPresenceChecker);
});

test('AGENTBRIDGE_KEYCHAIN_SERVICE selects a throwaway test service only', async (t) => {
  const h = ensureHelper();
  if ('skip' in h) return t.skip(h.skip);
  const s = await createSecretStore({ env: { AGENTBRIDGE_KEYCHAIN_SERVICE: 'agentbridge.test.e2e-1' } });
  assert.equal((s as MacKeychainStore).service, 'agentbridge.test.e2e-1');
  assert.equal(((await createSecretStore({ env: {} })) as MacKeychainStore).service, 'agentbridge');
  await assert.rejects(createSecretStore({ env: { AGENTBRIDGE_KEYCHAIN_SERVICE: 'login' } }), TypeError);
});

test('isLaunchdContext', () => {
  assert.equal(isLaunchdContext({}, 4242), false);
  assert.equal(isLaunchdContext({ XPC_SERVICE_NAME: '0' }, 4242), false);
  assert.equal(isLaunchdContext({ XPC_SERVICE_NAME: 'application.com.googlecode.iterm2.123.456' }, 4242), false);
  assert.equal(isLaunchdContext({ XPC_SERVICE_NAME: 'live.musi.agentbridge' }, 4242), true);
  assert.equal(isLaunchdContext({ AGENTBRIDGE_LAUNCHD: '1' }, 4242), true);
  assert.equal(isLaunchdContext({}, 1), true);
});

test('createNotifier posts via osascript under launchd by default; launchd: defer opts out (throws)', async () => {
  const sent: string[] = [];
  const inner = { async notify(n: { title: string }) { sent.push(n.title); } };
  await assert.rejects(new ContextAwareNotifier(inner, true).notify({ title: 'a', body: 'b' }), NotificationUnavailableError);
  await new ContextAwareNotifier(inner, false).notify({ title: 'c', body: 'd' });
  assert.deepEqual(sent, ['c']);
  const calls: string[] = [];
  const runner: Runner = async (file) => { calls.push(file); return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }; };
  await (await createNotifier({ env: { AGENTBRIDGE_LAUNCHD: '1' }, ppid: 1, runner })).notify({ title: 't', body: 'b' });
  await (await createNotifier({ env: {}, ppid: 4242, runner })).notify({ title: 't', body: 'b' });
  assert.deepEqual(calls, ['/usr/bin/osascript', '/usr/bin/osascript']);
  // osascript failure → reject (the bridge then keeps the popup unshown)
  const failing: Runner = async () => ({ code: 1, signal: null, stdout: '', stderr: 'execution error', timedOut: false });
  await assert.rejects((await createNotifier({ env: { AGENTBRIDGE_LAUNCHD: '1' }, ppid: 1, runner: failing })).notify({ title: 't', body: 'b' }), /exit 1/);
  // opt-out
  const deferred = await createNotifier({ env: { AGENTBRIDGE_LAUNCHD: '1' }, ppid: 4242, launchd: 'defer', runner });
  await assert.rejects(deferred.notify({ title: 't', body: 'b' }), /not shown from the launchd agent/);
  assert.equal(calls.length, 2);
});
