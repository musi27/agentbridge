import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OsascriptNotifier, osascriptArgs, cleanNotificationText, NOTIFY_SCRIPT, NOTIFY_SCRIPT_SUBTITLE, LIMITS } from '../src/notifier.ts';
import { run, type Runner } from '../src/exec.ts';

const INJECTIONS = [
  'He said "hi"',
  'back\\slash \\" escaped quote',
  '" & (do shell script "touch /tmp/agentbridge-pwned") & "',
  '"\ndisplay dialog "pwned',
  'end run\non run argv\ndo shell script "id"',
  '¬ continuation ¬\n',
  '«data utxt0041»',
  '$(touch /tmp/agentbridge-pwned) `id`',
  // osascript option injection: without "--" these would be parsed as options.
  '-e',
  ' -e',
  '-l',
  '-l JavaScript',
  '-s',
  '--',
];

test('the AppleScript source is constant; user text only ever appears as argv items', () => {
  for (const s of INJECTIONS) {
    const a = osascriptArgs({ title: s, body: s, subtitle: s });
    assert.equal(a[0], '-e');
    assert.equal(a[1], NOTIFY_SCRIPT_SUBTITLE);
    assert.equal(a[2], '--');
    assert.equal(a.length, 6);
    assert.ok(!a[1]!.includes(s.trim()));
    const b = osascriptArgs({ title: s, body: s });
    assert.equal(b[1], NOTIFY_SCRIPT);
    assert.equal(b[2], '--');
    assert.equal(b.length, 5);
  }
});

test('cleanNotificationText strips control chars, flattens newlines, truncates by code point', () => {
  assert.equal(cleanNotificationText('a\nb\r\nc\u0000d\u001b[0m\u2028e', 100), 'a b cd[0me');
  assert.equal(cleanNotificationText('😀'.repeat(10), 5), '😀😀😀😀…');
  assert.equal([...cleanNotificationText('x'.repeat(5000), LIMITS.body)].length, LIMITS.body);
  assert.deepEqual(osascriptArgs({ title: '\n', body: 'b' }).slice(3), ['agentbridge', 'b']);
  assert.equal(osascriptArgs({ title: 't', body: 'b', subtitle: '\u0000' }).length, 5);
});

// Real osascript (no UI): the same argv mechanism returns hostile strings verbatim and runs none of them.
test('osascript round-trip: hostile strings come back verbatim and execute nothing', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only');
  const dir = mkdtempSync(join(tmpdir(), 'ab-notify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const echo = NOTIFY_SCRIPT_SUBTITLE.replace(/^display notification .*$/m, 'return (item 1 of argv) & "␞" & (item 2 of argv) & "␞" & (item 3 of argv)');
  assert.notEqual(echo, NOTIFY_SCRIPT_SUBTITLE);
  for (const s of INJECTIONS) {
    const args = osascriptArgs({ title: s, body: `${s} ${dir}`, subtitle: s });
    args[1] = echo;
    const r = await run('/usr/bin/osascript', args, { timeoutMs: 10_000 });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.stdout.replace(/\n$/, '').split('␞'), args.slice(3), s);
  }
});

// Regression (integrator repro): a title of "-e" must not turn the body into a script line.
test('osascript option injection via a leading -e in the title runs nothing', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only');
  const dir = mkdtempSync(join(tmpdir(), 'ab-optinj-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'pwned');
  const echo = NOTIFY_SCRIPT.replace(/^display notification .*$/m, 'return (item 1 of argv) & "␞" & (item 2 of argv)');
  for (const title of ['-e', ' -e']) {
    const body = `property p : (do shell script "touch ${marker}")`;
    const args = osascriptArgs({ title, body });
    args[1] = echo;
    const r = await run('/usr/bin/osascript', args, { timeoutMs: 10_000 });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.stdout.replace(/\n$/, '').split('␞'), ['-e', body]);
    assert.equal(existsSync(marker), false);
  }
});

test('the notification scripts compile (osacompile, nothing is displayed)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only');
  const dir = mkdtempSync(join(tmpdir(), 'ab-osacompile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [i, script] of [NOTIFY_SCRIPT, NOTIFY_SCRIPT_SUBTITLE].entries()) {
    const r = await run('/usr/bin/osacompile', ['-o', join(dir, `s${i}.scpt`), '-e', script], { timeoutMs: 10_000 });
    assert.equal(r.code, 0, r.stderr);
  }
});

test('OsascriptNotifier runs /usr/bin/osascript and surfaces failures', async () => {
  const seen: (readonly string[])[] = [];
  const ok: Runner = async (file, args) => { seen.push([file, ...args]); return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }; };
  await new OsascriptNotifier({ runner: ok }).notify({ title: 'T', body: 'B', subtitle: 'S' });
  assert.deepEqual(seen[0], ['/usr/bin/osascript', '-e', NOTIFY_SCRIPT_SUBTITLE, '--', 'T', 'B', 'S']);
  const bad: Runner = async () => ({ code: 1, signal: null, stdout: '', stderr: 'execution error: -1743', timedOut: false });
  await assert.rejects(new OsascriptNotifier({ runner: bad }).notify({ title: 'T', body: 'B' }), /-1743/);
});
