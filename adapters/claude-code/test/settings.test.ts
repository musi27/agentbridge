import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DENY_RULES, bareModeConfigured, checkDenyRules, installDenyRules, removeDenyRules, readEffectiveCrossSessionInbound } from '../src/settings.ts';
import { tempDir } from './helpers.ts';

interface Layout { managed?: unknown; dropIns?: Record<string, unknown>; flag?: unknown; user?: unknown; project?: unknown; local?: unknown }

function setup(dir: string, l: Layout) {
  const managedDir = join(dir, 'managed'); const cfg = join(dir, 'cfg'); const cwd = join(dir, 'proj');
  mkdirSync(managedDir, { recursive: true }); mkdirSync(cfg, { recursive: true }); mkdirSync(join(cwd, '.claude'), { recursive: true });
  const w = (p: string, v: unknown) => writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
  if (l.managed !== undefined) w(join(managedDir, 'managed-settings.json'), l.managed);
  if (l.dropIns) { mkdirSync(join(managedDir, 'managed-settings.d')); for (const [k, v] of Object.entries(l.dropIns)) w(join(managedDir, 'managed-settings.d', k), v); }
  const flag = join(dir, 'flag.json'); if (l.flag !== undefined) w(flag, l.flag);
  if (l.user !== undefined) w(join(cfg, 'settings.json'), l.user);
  if (l.project !== undefined) w(join(cwd, '.claude', 'settings.json'), l.project);
  if (l.local !== undefined) w(join(cwd, '.claude', 'settings.local.json'), l.local);
  return readEffectiveCrossSessionInbound(cwd, { env: { CLAUDE_CONFIG_DIR: cfg }, managedDir, ...(l.flag !== undefined ? { flagSettingsPath: flag } : {}) });
}

const v = (x: string) => ({ crossSessionInbound: x });

const CASES: Array<[string, Layout, string, string]> = [
  ['nothing set -> accept (default)', {}, 'accept', 'default'],
  ['user hold', { user: v('hold') }, 'hold', 'userSettings'],
  ['user refuse', { user: v('refuse') }, 'refuse', 'userSettings'],
  ['project may tighten: user accept + project hold', { user: v('accept'), project: v('hold') }, 'hold', 'repoSettings'],
  ['refuse from local wins over user accept', { user: v('accept'), local: v('refuse') }, 'refuse', 'repoSettings'],
  ['refuse from project wins over user hold', { user: v('hold'), project: v('refuse') }, 'refuse', 'repoSettings'],
  ['project cannot loosen: user hold + project accept', { user: v('hold'), project: v('accept') }, 'hold', 'userSettings'],
  ['local cannot loosen a refuse', { user: v('refuse'), local: v('accept') }, 'refuse', 'userSettings'],
  ['project tightens the default', { project: v('hold') }, 'hold', 'repoSettings'],
  ['managed overrides user (looser)', { managed: v('accept'), user: v('refuse') }, 'accept', 'policySettings'],
  ['managed overrides user (stricter)', { managed: v('hold'), user: v('accept') }, 'hold', 'policySettings'],
  ['--settings overrides user', { flag: v('accept'), user: v('hold') }, 'accept', 'flagSettings'],
  ['managed beats --settings', { managed: v('refuse'), flag: v('accept') }, 'refuse', 'policySettings'],
  ['repo still tightens over managed accept', { managed: v('accept'), project: v('hold') }, 'hold', 'repoSettings'],
  ['repo equal to managed: managed keeps credit', { managed: v('hold'), project: v('hold') }, 'hold', 'policySettings'],
  ['repo equal to user hold: repo gets credit (Claude Code does this)', { user: v('hold'), local: v('hold') }, 'hold', 'repoSettings'],
  ['managed drop-in overrides base file', { managed: v('accept'), dropIns: { '10-a.json': v('hold') } }, 'hold', 'policySettings'],
  ['later drop-in wins', { dropIns: { '10-a.json': v('refuse'), '20-b.json': v('accept') } }, 'accept', 'policySettings'],
  ['invalid value anywhere -> hold', { user: v('accept'), project: v('maybe') }, 'hold', 'invalidSetting'],
  ['invalid value does not loosen refuse', { user: v('refuse'), local: v('nope') }, 'refuse', 'userSettings'],
  ['non-string value is invalid', { user: { crossSessionInbound: 1 } }, 'hold', 'invalidSetting'],
  ['malformed JSON file is ignored', { user: '{not json', project: v('accept') }, 'accept', 'default'],
];

for (const [name, layout, value, by] of CASES) {
  test(`crossSessionInbound: ${name}`, (t) => {
    const { dir, cleanup } = tempDir(); t.after(cleanup);
    const r = setup(dir, layout);
    assert.equal(r.value, value);
    assert.equal(r.decidedBy, by);
  });
}

test('crossSessionInbound: readings report what was found, including malformed files', (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const r = setup(dir, { user: '{bad', project: v('hold') });
  assert.ok(r.readings.some((x) => x.source === 'userSettings' && x.error?.startsWith('invalid JSON')));
  assert.ok(r.readings.some((x) => x.source === 'projectSettings' && x.value === 'hold'));
});

test('deny rules: §11.4 list (13 Bash prefixes + Edit on ~/.agentbridge)', () => {
  assert.equal(DENY_RULES.length, 14);
  for (const s of ['config', 'approve', 'decline', 'extend', 'revoke', 'remove', 'add', 'purge', 'identity', 'show', 'end', 'stop', 'uninstall']) {
    assert.ok(DENY_RULES.includes(`Bash(agentbridge ${s}:*)`), s);
  }
  assert.ok(DENY_RULES.includes('Edit(~/.agentbridge/**)'));
});

test('installDenyRules: creates the file when missing (0600)', (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const p = join(dir, 'sub', 'settings.json');
  const r = installDenyRules(p);
  assert.equal(r.added.length, DENY_RULES.length);
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { permissions: { deny: [...DENY_RULES] } });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(checkDenyRules(p).missing, []);
});

test('installDenyRules: preserves other settings, existing rules and file mode; idempotent', (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const p = join(dir, 'settings.json');
  const original = { model: 'opus', env: { A: '1' }, permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm:*)', DENY_RULES[3]], defaultMode: 'default' }, hooks: { Stop: [] } };
  writeFileSync(p, JSON.stringify(original)); chmodSync(p, 0o644);
  const r1 = installDenyRules(p);
  assert.equal(r1.added.length, DENY_RULES.length - 1);
  const after = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.env, { A: '1' });
  assert.deepEqual(after.hooks, { Stop: [] });
  assert.deepEqual(after.permissions.allow, ['Bash(ls)']);
  assert.equal(after.permissions.defaultMode, 'default');
  assert.deepEqual(after.permissions.deny.slice(0, 2), ['Bash(rm:*)', DENY_RULES[3]]);
  assert.equal(new Set(after.permissions.deny).size, after.permissions.deny.length);
  assert.equal(statSync(p).mode & 0o777, 0o644);
  const before = readFileSync(p, 'utf8'); const mtime = statSync(p).mtimeMs;
  const r2 = installDenyRules(p);
  assert.deepEqual(r2.added, []);
  assert.equal(readFileSync(p, 'utf8'), before);
  assert.equal(statSync(p).mtimeMs, mtime);
  assert.ok(!existsSync(`${p}.agentbridge-${process.pid}.tmp`));
});

test('installDenyRules: refuses malformed files instead of clobbering them', (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const p = join(dir, 'settings.json');
  writeFileSync(p, '{ "model": "opus", }');
  assert.throws(() => installDenyRules(p), /cannot read/);
  assert.equal(readFileSync(p, 'utf8'), '{ "model": "opus", }');
  writeFileSync(p, JSON.stringify({ permissions: { deny: 'Bash(x)' } }));
  assert.throws(() => installDenyRules(p), /not an array/);
  writeFileSync(p, '[]');
  assert.throws(() => installDenyRules(p), /not a JSON object/);
});

test('checkDenyRules: reports missing and unreadable', (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const p = join(dir, 'settings.json');
  assert.equal(checkDenyRules(p).missing.length, DENY_RULES.length);
  writeFileSync(p, JSON.stringify({ permissions: { deny: DENY_RULES.slice(0, 5) } }));
  const s = checkDenyRules(p);
  assert.equal(s.present.length, 5);
  assert.equal(s.missing.length, DENY_RULES.length - 5);
  writeFileSync(p, 'nope');
  assert.ok(checkDenyRules(p).error);
});

test('bare mode detection', (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const p = join(dir, 'settings.json');
  assert.equal(bareModeConfigured({}, p).bare, false);
  assert.equal(bareModeConfigured({ CLAUDE_CODE_SIMPLE: '1' }, p).bare, true);
  assert.equal(bareModeConfigured({ CLAUDE_CODE_SIMPLE: '0' }, p).bare, false);
  writeFileSync(p, JSON.stringify({ env: { CLAUDE_CODE_SIMPLE: 'true' } }));
  assert.equal(bareModeConfigured({}, p).bare, true);
});

test('regression: installDenyRules writes through a symlinked settings.json and keeps the symlink', async (t) => {
  const { symlinkSync, lstatSync, readdirSync } = await import('node:fs');
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  mkdirSync(join(dir, 'dotfiles')); mkdirSync(join(dir, 'claude'));
  const real = join(dir, 'dotfiles', 'claude-settings.json');
  writeFileSync(real, JSON.stringify({ model: 'opus' })); chmodSync(real, 0o640);
  const link = join(dir, 'claude', 'settings.json');
  symlinkSync(real, link);
  const r = installDenyRules(link);
  assert.equal(r.added.length, DENY_RULES.length);
  assert.ok(lstatSync(link).isSymbolicLink(), 'still a symlink');
  const data = JSON.parse(readFileSync(real, 'utf8'));
  assert.equal(data.model, 'opus');
  assert.deepEqual(data.permissions.deny, [...DENY_RULES]);
  assert.equal(statSync(real).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(join(dir, 'claude')), ['settings.json'], 'no temp file left next to the link');
  assert.deepEqual(readdirSync(join(dir, 'dotfiles')), ['claude-settings.json'], 'no temp file left next to the target');
});

test('regression: a failed write leaves no temp file behind', async (t) => {
  const { readdirSync } = await import('node:fs');
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const sub = join(dir, 's'); mkdirSync(sub);
  const p = join(sub, 'settings.json');
  writeFileSync(p, '{}');
  chmodSync(sub, 0o500); // directory not writable: the temp write fails
  try { assert.throws(() => installDenyRules(p)); } finally { chmodSync(sub, 0o700); }
  assert.deepEqual(readdirSync(sub), ['settings.json']);
  assert.equal(readFileSync(p, 'utf8'), '{}');
});

test('removeDenyRules: removes only the §11.4 rules, keeps every other setting; idempotent; missing file is a no-op', (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const p = join(dir, 'settings.json');
  assert.deepEqual(removeDenyRules(p), { path: p, removed: [] });
  assert.equal(existsSync(p), false);
  const original = { model: 'opus', env: { A: '1' }, permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm:*)', 'Bash(agentbridge-other:*)'], defaultMode: 'default' }, hooks: { Stop: [] } };
  writeFileSync(p, JSON.stringify(original, null, 2)); chmodSync(p, 0o640);
  installDenyRules(p);
  const r = removeDenyRules(p);
  assert.equal(r.removed.length, DENY_RULES.length);
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), original);
  assert.equal(statSync(p).mode & 0o777, 0o640);
  assert.deepEqual(removeDenyRules(p).removed, []);
  // an older init's 13 rules (no uninstall rule) are removed too
  writeFileSync(p, JSON.stringify({ permissions: { deny: DENY_RULES.filter((x) => !x.includes('uninstall')) } }));
  assert.equal(removeDenyRules(p).removed.length, DENY_RULES.length - 1);
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { permissions: { deny: [] } });
  writeFileSync(p, '{bad');
  assert.throws(() => removeDenyRules(p));
  assert.equal(readFileSync(p, 'utf8'), '{bad');
});
