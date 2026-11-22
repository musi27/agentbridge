// Exercises the real Swift helper's request/response handling (no Touch ID, no keychain writes). Runs in CI.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { run } from '../src/exec.ts';
import { parseHelperResponse } from '../src/protocol.ts';
import { ensureHelper } from './helpers.ts';

let helper = '';
let skip: string | false = false;
before(() => {
  const h = ensureHelper();
  if ('skip' in h) skip = h.skip; else helper = h.path;
});

const call = async (args: string[], input: string) => {
  const r = await run(helper, args, { input, timeoutMs: 10_000 });
  return { code: r.code, res: parseHelperResponse(r.stdout), stderr: r.stderr };
};

test('version', async (t) => {
  if (skip) return t.skip(skip);
  const { code, res } = await call(['version'], '{}');
  assert.equal(code, 0);
  assert.deepEqual(res, { ok: true, protocol: 1, version: '0.1.0' });
});

test('universal binary (arm64 + x86_64), signed with the stable identifier', (t) => {
  if (skip) return t.skip(skip);
  const archs = execFileSync('/usr/bin/lipo', ['-archs', helper], { encoding: 'utf8' }).trim().split(/\s+/).sort();
  assert.deepEqual(archs, ['arm64', 'x86_64']);
  // codesign -dv reports on stderr.
  const r = execFileSync('/bin/sh', ['-c', '/usr/bin/codesign -dv "$1" 2>&1', 'sh', helper], { encoding: 'utf8' });
  assert.match(r, /Identifier=live\.musi\.agentbridge\.helper/);
});

test('usage and protocol errors: exit 2 with a JSON error, nothing on stderr', async (t) => {
  if (skip) return t.skip(skip);
  const cases: [string[], string, string][] = [
    [[], '{}', 'bad_request'],
    [['presence', 'extra'], '{}', 'bad_request'],
    [['bogus'], '{}', 'unknown_subcommand'],
    [['presence'], 'not json', 'bad_request'],
    [['presence'], '[1,2]', 'bad_request'],
    [['presence'], '{}', 'bad_request'],
    [['presence'], '{"reason":""}', 'bad_request'],
    [['presence'], '{"reason":5}', 'bad_request'],
    [['keychain-get'], '{"service":"agentbridge"}', 'bad_request'],
    [['keychain-set'], '{"account":"a"}', 'bad_request'],
    // The helper is not a keychain oracle: only "agentbridge" or "agentbridge.test.<suffix>".
    [['keychain-get'], '{"service":"login","account":"a"}', 'bad_request'],
    [['keychain-get'], '{"service":"com.apple.account","account":"a"}', 'bad_request'],
    [['keychain-get'], '{"service":"agentbridge.test.","account":"a"}', 'bad_request'],
    [['keychain-get'], '{"service":"agentbridge.testx","account":"a"}', 'bad_request'],
    [['keychain-get'], '{"service":"agentbridge.test.a/b","account":"a"}', 'bad_request'],
    [['keychain-set'], '{"service":"agentbridgeX","account":"a","value":"v"}', 'bad_request'],
    [['keychain-delete'], '{"service":5,"account":"a"}', 'bad_request'],
    [['presence'], '{"reason":"x","timeout_ms":0}', 'bad_request'],
    [['presence'], '{"reason":"x","timeout_ms":"5"}', 'bad_request'],
    [['presence'], '{"reason":"x","timeout_ms":600001}', 'bad_request'],
  ];
  for (const [args, input, error] of cases) {
    const { code, res, stderr } = await call(args, input);
    assert.equal(code, 2, `${args} ${input}`);
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.error, error, `${args} ${input}`);
    assert.equal(stderr, '');
  }
});

test('oversized stdin is rejected', async (t) => {
  if (skip) return t.skip(skip);
  const { code, res } = await call(['keychain-get'], JSON.stringify({ service: 'x', account: 'a', pad: 'x'.repeat(2 << 20) }));
  assert.equal(code, 2);
  assert.equal(!res.ok && res.detail, 'request too large');
});
