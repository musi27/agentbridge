import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, toRequest, main, UsageError, PRIVILEGED } from '../src/cli/main.ts';
import { ipcHarness, cleanup } from './ipc-helpers.ts';

test('§11.4: global flags before a privileged subcommand are rejected; after it they are fine', () => {
  for (const argv of [['--json', 'approve', 'X'], ['--home', '/x', 'config', 'set', 'a', 'b'], ['--home=/x', 'stop'], ['--json', 'config', 'verify'], ['--json', 'end', 'X'], ['--json', 'add', 'grok'], ['--json', 'uninstall'], ['--home', '/x', 'uninstall', '--purge-data']]) {
    assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));
  }
  assert.deepEqual(parseArgs(['approve', 'X', '--json']), { cmd: 'approve', args: ['X'], json: true });
  assert.deepEqual(parseArgs(['--json', 'status']), { cmd: 'status', args: [], json: true });
  assert.deepEqual(parseArgs(['--home', '/h', 'config', 'get']), { cmd: 'config', args: ['get'], json: false, home: '/h' });
  assert.throws(() => parseArgs(['-x', 'approve']), UsageError);
  // the CLI's privileged set matches §9.2
  assert.deepEqual([...PRIVILEGED].sort(), ['add', 'approve', 'config set', 'config verify', 'decline', 'end', 'extend', 'identity', 'purge', 'remove', 'revoke', 'show', 'stop', 'uninstall']);
  assert.deepEqual(parseArgs(['uninstall', '--purge-data', '--home', '/h', '--json']), { cmd: 'uninstall', args: ['--purge-data'], json: true, home: '/h' });
});

test('cli: commands map to IPC methods', () => {
  const r = (s: string): { method: string; params: unknown } => toRequest(parseArgs(s.split(' ')));
  assert.deepEqual(r('approve 01ABC'), { method: 'cli.approve', params: { approval_id: '01ABC' } });
  assert.deepEqual(r('extend C 5'), { method: 'cli.extend', params: { conversation_id: 'C', add_turns: 5 } });
  assert.deepEqual(r('end --inactive 2h'), { method: 'cli.end', params: { inactive: '2h' } });
  assert.deepEqual(r('config set allowlist.add allow claude:* -> grok:*'), { method: 'cli.config_set', params: { key: 'allowlist.add', value: 'allow claude:* -> grok:*' } });
  assert.deepEqual(r('config verify'), { method: 'cli.config_verify', params: { action: 'show' } });
  assert.deepEqual(r('logs --limit 5'), { method: 'cli.logs', params: { limit: 5 } });
  assert.throws(() => r('open'), UsageError);
  assert.throws(() => r('frobnicate'), UsageError);
  assert.deepEqual(r('doctor'), { method: 'cli.doctor', params: {} });
  assert.deepEqual(r('doctor grok:researcher'), { method: 'cli.doctor', params: { round_trip: 'grok:researcher' } });
  assert.deepEqual(r('add grok'), { method: 'cli.add_grok', params: {} });
  assert.deepEqual(r('revoke grok:researcher'), { method: 'cli.revoke', params: { address: 'grok:researcher' } });
  assert.throws(() => r('revoke'), UsageError);
  assert.throws(() => parseArgs(['--json', 'revoke', 'grok:x']), UsageError); // global flag before a privileged command
});

test('cli: main() against a running bridge (unprivileged, privileged with and without presence)', async () => {
  const h = await ipcHarness();
  try {
    const out: string[] = []; const err: string[] = [];
    const run = (...a: string[]): Promise<number> => main([...a, '--home', h.root], (s) => out.push(s), (s) => err.push(s));
    assert.equal(await run('status'), 0); assert.match(out.join('\n'), /policy v1, mode per_conversation/);
    assert.equal(await run('agents', '--json'), 0);
    h.presence.answer = { ok: false, code: 'cancelled' };
    assert.equal(await run('config', 'set', 'approval.mode', 'auto'), 1); assert.match(err.at(-1)!, /presence check failed \(cancelled\)/);
    h.presence.answer = { ok: true, method: 'biometric_or_password' };
    assert.equal(await run('config', 'set', 'approval.mode', 'auto'), 0);
    assert.equal(await main(['--json', 'stop', '--home', h.root], () => {}, (s) => err.push(s)), 2);
    assert.equal(await main(['status', '--home', '/tmp/ab-nonexistent-xyz'], () => {}, (s) => err.push(s)), 1);
    assert.match(err.at(-1)!, /not running/);
  } finally { await h.stop(); cleanup(h); }
});
