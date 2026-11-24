// Plugin packaging: manifest, hooks, marketplace, versions, and that the committed bundles match the sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundlePlugin } from '../scripts/build-plugin.ts';
import { PLUGIN_VERSION, TOOL_NAME_PREFIX } from '../src/version.ts';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgDir, '..', '..');
const plugin = join(pkgDir, 'plugin');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

test('versions agree: release package.json, plugin.json, PLUGIN_VERSION (the workspace package.json version is internal)', () => {
  assert.equal(json(join(repoRoot, 'packaging', 'npm', 'package.json')).version, PLUGIN_VERSION, 'the plugin version is the release version');
  assert.equal(json(join(plugin, '.claude-plugin', 'plugin.json')).version, PLUGIN_VERSION);
});

test('plugin.json declares the MCP server inline (no .mcp.json anywhere a user might open as a project)', () => {
  const m = json(join(plugin, '.claude-plugin', 'plugin.json'));
  assert.equal(m.name, 'agentbridge');
  assert.deepEqual(m.mcpServers, { agentbridge: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/runtime/server.mjs'] } });
  assert.ok(!existsSync(join(plugin, '.mcp.json')));
  assert.ok(!existsSync(join(repoRoot, '.mcp.json')));
  assert.equal(TOOL_NAME_PREFIX, 'mcp__plugin_agentbridge_agentbridge__');
});

test('hooks.json: top-level hooks wrapper, the five events, PreToolUse limited to our tools', () => {
  const h = json(join(plugin, 'hooks', 'hooks.json'));
  assert.deepEqual(Object.keys(h.hooks).sort(), ['PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  const pre = h.hooks.PreToolUse[0];
  assert.ok(new RegExp(`^${pre.matcher}$`).test(`${TOOL_NAME_PREFIX}bridge_confirm`));
  assert.ok(!new RegExp(`^${pre.matcher}$`).test('Bash'));
  for (const ev of Object.values(h.hooks) as Array<Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>) {
    const hk = ev[0]!.hooks[0]!;
    assert.equal(hk.type, 'command');
    assert.equal(hk.command, 'node "${CLAUDE_PLUGIN_ROOT}/runtime/hook.mjs"');
    assert.ok(hk.timeout <= 5);
  }
});

test('in-repo marketplace lists the plugin folder', () => {
  const m = json(join(repoRoot, '.claude-plugin', 'marketplace.json'));
  const entry = m.plugins.find((p: { name: string }) => p.name === 'agentbridge');
  assert.equal(entry.source, './adapters/claude-code/plugin');
  assert.ok(existsSync(join(repoRoot, entry.source, '.claude-plugin', 'plugin.json')));
});

test('committed runtime bundles are up to date (run `npm run build:plugin -w @agentbridge/adapter-claude-code`)', async () => {
  const fresh = await bundlePlugin();
  assert.deepEqual([...fresh.keys()].sort(), ['hook.mjs', 'server.mjs']);
  for (const [f, text] of fresh) assert.ok(text === readFileSync(join(plugin, 'runtime', f), 'utf8'), `${f} is stale`);
});
