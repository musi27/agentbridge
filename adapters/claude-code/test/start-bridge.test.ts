import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bridgeSpawnEnv, findCli, startBridgeDetached } from '../src/start-bridge.ts';
import { tempDir, waitFor } from './helpers.ts';

test('bridgeSpawnEnv strips CLAUDE_CODE_* and CLAUDECODE* variables only', () => {
  const env = bridgeSpawnEnv({ PATH: '/bin', HOME: '/h', CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/c', AGENTBRIDGE_HOME: '/a' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', AGENTBRIDGE_HOME: '/a' });
});

test('regression: the spawned bridge runs from the home folder without the session env', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const out = join(dir, 'out');
  const cli = join(dir, 'agentbridge');
  writeFileSync(cli, `#!/bin/sh\npwd -P > "${out}.tmp"\necho "args=$*" >> "${out}.tmp"\nenv >> "${out}.tmp"\nmv "${out}.tmp" "${out}"\n`);
  chmodSync(cli, 0o755);
  assert.equal(findCli({ AGENTBRIDGE_CLI: cli }), cli);
  assert.ok(startBridgeDetached(cli, { PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CODE_MESSAGING_TOKEN: 'tok', CLAUDECODE: '1', KEEP_ME: 'yes' }));
  await waitFor(() => existsSync(out), 'fake CLI output');
  const lines = readFileSync(out, 'utf8').split('\n');
  assert.equal(lines[0], realpathSync(homedir()));
  assert.equal(lines[1], 'args=start');
  assert.ok(lines.includes('KEEP_ME=yes'));
  assert.ok(!lines.some((l) => l.startsWith('CLAUDE_CODE_') || l.startsWith('CLAUDECODE')));
});
