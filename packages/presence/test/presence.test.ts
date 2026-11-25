import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacPresenceChecker } from '../src/presence.ts';
import type { Runner } from '../src/exec.ts';

/** A stub helper executable: records argv/stdin/env, replies with response.json, exits with `code`. */
function stubHelper(response: string, opts: { exitCode?: number; sleep?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ab-presence-'));
  const bin = join(dir, 'agentbridge-helper');
  writeFileSync(join(dir, 'response.json'), response);
  writeFileSync(bin, [
    '#!/bin/sh',
    'd="$(dirname "$0")"',
    'printf "%s\\n" "$@" > "$d/argv"',
    'env > "$d/env"',
    'cat > "$d/stdin"',
    opts.sleep ? `sleep ${opts.sleep}` : '',
    'cat "$d/response.json"',
    `exit ${opts.exitCode ?? 0}`,
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return {
    bin,
    argv: () => readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n'),
    stdin: () => readFileSync(join(dir, 'stdin'), 'utf8'),
    env: () => readFileSync(join(dir, 'env'), 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('approve → ok; reason travels on stdin, argv is only the subcommand, env is minimal', async (t) => {
  const s = stubHelper('{"ok":true}\n');
  t.after(s.cleanup);
  process.env.AB_TEST_SHOULD_NOT_LEAK = 'leak';
  t.after(() => { delete process.env.AB_TEST_SHOULD_NOT_LEAK; });
  const r = await new MacPresenceChecker({ helperPath: s.bin }).check('approve the conversation with "grok:researcher"');
  assert.deepEqual(r, { ok: true, method: 'biometric_or_password' });
  assert.deepEqual(s.argv(), ['presence']);
  assert.deepEqual(JSON.parse(s.stdin()), { reason: 'approve the conversation with "grok:researcher"', timeout_ms: 120_000 });
  assert.doesNotMatch(s.env(), /AB_TEST_SHOULD_NOT_LEAK/);
});

test('cancel (LAError -2) → cancelled', async (t) => {
  const s = stubHelper('{"detail":"Authentication canceled.","la_code":-2,"ok":false,"stage":"evaluate"}');
  t.after(s.cleanup);
  assert.deepEqual(await new MacPresenceChecker({ helperPath: s.bin }).check('x'), { ok: false, code: 'cancelled', detail: 'Authentication canceled.' });
});

test('canEvaluate failure (no passcode, -5) → unavailable', async (t) => {
  const s = stubHelper('{"detail":"Passcode not set.","la_code":-5,"ok":false,"stage":"can_evaluate"}');
  t.after(s.cleanup);
  const r = await new MacPresenceChecker({ helperPath: s.bin }).check('x');
  assert.equal(r.ok ? 'ok' : r.code, 'unavailable');
});

test('garbage output, non-zero exit with ok:true, missing binary → error (never ok)', async (t) => {
  const garbage = stubHelper('Segmentation fault', { exitCode: 139 });
  const lying = stubHelper('{"ok":true}', { exitCode: 1 });
  t.after(() => { garbage.cleanup(); lying.cleanup(); });
  for (const helperPath of [garbage.bin, lying.bin, '/nonexistent/agentbridge-helper']) {
    const r = await new MacPresenceChecker({ helperPath }).check('x');
    assert.equal(r.ok, false, helperPath);
    assert.equal(r.ok ? '' : r.code, 'error', helperPath);
  }
});

test('reason is sanitised: control chars removed, length capped, empty rejected without running the helper', async () => {
  const seen: string[] = [];
  const runner: Runner = async (_f, _a, o) => { seen.push(o?.input ?? ''); return { code: 0, signal: null, stdout: '{"ok":true}', stderr: '', timedOut: false }; };
  const c = new MacPresenceChecker({ runner });
  await c.check('line1\nline2\u0000\u001b[31m');
  assert.equal(JSON.parse(seen[0]!).reason, 'line1 line2 [31m');
  await c.check('x'.repeat(500));
  assert.equal(JSON.parse(seen[1]!).reason.length, 200);
  assert.deepEqual(await c.check(' \n '), { ok: false, code: 'error', detail: 'empty reason' });
  assert.equal(seen.length, 2);
});

test('timeout: the helper is asked to give up (timeout_ms) and Node kills it 5 s later as a backstop', async () => {
  const seen: { input: string | undefined; timeoutMs: number | undefined }[] = [];
  const runner: Runner = async (_f, _a, o) => {
    seen.push({ input: o?.input, timeoutMs: o?.timeoutMs });
    return { code: 0, signal: null, stdout: '{"detail":"no response within 3000 ms","la_code":-9,"ok":false,"stage":"timeout"}', stderr: '', timedOut: false };
  };
  const r = await new MacPresenceChecker({ runner, timeoutMs: 3000 }).check('x');
  assert.deepEqual(r, { ok: false, code: 'error', detail: 'timed out: no response within 3000 ms' });
  assert.equal(JSON.parse(seen[0]!.input!).timeout_ms, 3000);
  assert.equal(seen[0]!.timeoutMs, 8000);
  const killed: Runner = async () => ({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true });
  const k = await new MacPresenceChecker({ runner: killed }).check('x');
  assert.equal(k.ok ? '' : k.code, 'error');
});

test('reason truncation keeps whole code points (an emoji at the cut must not leave a lone surrogate)', async () => {
  const seen: string[] = [];
  const runner: Runner = async (_f, _a, o) => { seen.push(o?.input ?? ''); return { code: 0, signal: null, stdout: '{"ok":true}', stderr: '', timedOut: false }; };
  await new MacPresenceChecker({ runner }).check(`${'x'.repeat(199)}😀😀`);
  const reason: string = JSON.parse(seen[0]!).reason;
  assert.equal(reason, `${'x'.repeat(199)}😀`);
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(reason, loneSurrogate);
  assert.doesNotMatch(seen[0]!, loneSurrogate);
});

test('checks are serialised: one OS dialog at a time', async () => {
  let active = 0;
  let maxActive = 0;
  const runner: Runner = async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return { code: 0, signal: null, stdout: '{"ok":true}', stderr: '', timedOut: false };
  };
  const c = new MacPresenceChecker({ runner });
  const rs = await Promise.all([c.check('a'), c.check('b'), c.check('c')]);
  assert.equal(maxActive, 1);
  assert.ok(rs.every((r) => r.ok));
});

test('a thrown runner error does not wedge the queue', async () => {
  let n = 0;
  const runner: Runner = async () => { if (n++ === 0) throw new Error('spawn EACCES'); return { code: 0, signal: null, stdout: '{"ok":true}', stderr: '', timedOut: false }; };
  const c = new MacPresenceChecker({ runner });
  const first = await c.check('a');
  assert.equal(first.ok, false);
  assert.deepEqual(await c.check('b'), { ok: true, method: 'biometric_or_password' });
});

test('run(): timeout sends SIGTERM, then SIGKILL if the process ignores it', async (t) => {
  const { run } = await import('../src/exec.ts');
  const polite = await run('/bin/sleep', ['30'], { timeoutMs: 100, killGraceMs: 5000 });
  assert.equal(polite.timedOut, true);
  assert.equal(polite.signal, 'SIGTERM');
  const dir = mkdtempSync(join(tmpdir(), 'ab-term-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stubborn = join(dir, 'stubborn');
  const ready = join(dir, 'ready');
  // The marker is written only after the trap is installed. Under heavy load sh may not get that far before the
  // timeout fires; then SIGTERM legitimately kills it (no trap yet), which says nothing about the SIGKILL path.
  // So retry with a longer timeout until the process provably ignored SIGTERM, and assert on that run.
  writeFileSync(stubborn, `#!/bin/sh\ntrap "" TERM\n: > "${ready}"\nwhile :; do sleep 0.05; done\n`);
  chmodSync(stubborn, 0o755);
  let r: Awaited<ReturnType<typeof run>> | null = null;
  for (let timeoutMs = 300; timeoutMs <= 20_000 && !r; timeoutMs *= 2) {
    rmSync(ready, { force: true });
    const attempt = await run(stubborn, [], { timeoutMs, killGraceMs: 200 });
    if (existsSync(ready)) r = attempt;
  }
  assert.ok(r, 'the stubborn script never got as far as installing its trap');
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, 'SIGKILL');
});
