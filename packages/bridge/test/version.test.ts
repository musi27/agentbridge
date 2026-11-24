// One release version everywhere (CLI, bridge, plugin, npm package) and the upgrade checks built on it (§14.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION, versionMismatch } from '../src/version.ts';
import { BRIDGE_VERSION as ENGINE_VERSION } from '../src/core/engine.ts';
import { main, versionCheck, VERSION_FIX } from '../src/cli/main.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const json = (p: string): { version: string } => JSON.parse(readFileSync(join(repo, p), 'utf8')) as { version: string };

test('release version: npm package.json = BRIDGE_VERSION = plugin.json (engine re-exports it)', () => {
  assert.equal(json('packaging/npm/package.json').version, BRIDGE_VERSION);
  assert.equal(json('adapters/claude-code/plugin/.claude-plugin/plugin.json').version, BRIDGE_VERSION);
  assert.equal(ENGINE_VERSION, BRIDGE_VERSION);
  assert.match(readFileSync(join(repo, 'README.md'), 'utf8'), new RegExp(`Status: v${BRIDGE_VERSION.replaceAll('.', '\\.')}\\b`), 'README status line names the release');
});

test('versionMismatch / versionCheck: null when equal or unknown; a fix when they differ', () => {
  assert.equal(versionMismatch('1.2.3', '1.2.3'), null);
  assert.equal(versionMismatch(null, '1.2.3'), null);
  assert.equal(versionMismatch('1.2.2', '1.2.3'), 'the running bridge is 1.2.2 but this agentbridge is 1.2.3');
  assert.deepEqual(versionCheck(BRIDGE_VERSION).ok, true);
  const bad = versionCheck('0.0.1');
  assert.equal(bad.ok, false); assert.equal(bad.id, 'bridge_version'); assert.equal(bad.fix, VERSION_FIX);
});

test('agentbridge --version / -v / version print the version without a bridge', async () => {
  const home = `/tmp/ab-ver-${process.pid}`; // never the real ~/.agentbridge
  for (const a of [['--version', '--home', home], ['-v', '--home', home], ['version', '--home', home]]) {
    const out: string[] = [];
    assert.equal(await main(a, (s) => out.push(s), (s) => out.push(`ERR ${s}`)), 0);
    assert.deepEqual(out, [`agentbridge ${BRIDGE_VERSION}`]);
  }
});
