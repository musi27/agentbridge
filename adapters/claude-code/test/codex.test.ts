// Codex host support in the plugin runtime (§11a).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IPC_METHODS, renderStandingInstruction } from '@agentbridge/protocol';
import { CodexQueuePoster, codexBinary, codexConfirmGuard, hostFrom } from '../src/codex.ts';
import { buildSessionEvent, runHook } from '../src/hook.ts';
import { createMcpServer } from '../src/mcp-server.ts';
import { FakeBridge, tempDir } from './helpers.ts';
import { join } from 'node:path';

const APPROVAL = '01JABCDEFGHJKMNPQRSTVWXYZ0';

test('hostFrom: --host=codex or AGENTBRIDGE_HOST=codex; Claude Code otherwise', () => {
  assert.equal(hostFrom(['node', 'server.mjs', '--host=codex'], {}), 'codex');
  assert.equal(hostFrom(['node', 'server.mjs'], { AGENTBRIDGE_HOST: 'codex' }), 'codex');
  assert.equal(hostFrom(['node', 'server.mjs'], {}), 'claude');
  assert.equal(hostFrom(['node', 'server.mjs', '--host=other'], {}), 'claude');
});

test('codexBinary: override, then the parent process when it is codex, else codex on PATH', () => {
  assert.equal(codexBinary(1, { AGENTBRIDGE_CODEX_BIN: '/x/codex' }, () => '/y/codex'), '/x/codex');
  assert.equal(codexBinary(1, {}, () => '/bin/sh'), 'codex'); // executable, but not codex
  assert.equal(codexBinary(1, {}, () => 'codex'), 'codex'); // not absolute
  assert.equal(codexBinary(1, {}, () => null), 'codex');
  assert.equal(codexBinary(1, {}, () => '/nonexistent/codex'), 'codex');
});

test('CodexQueuePoster: codex queue --thread <id> --message <text>, serialised and spaced; no thread id fails', async () => {
  const calls: Array<{ bin: string; args: string[]; at: number }> = [];
  const p = new CodexQueuePoster('/bin/codex', { spacingMs: 40, run: async (bin, args) => { calls.push({ bin, args, at: performance.now() }); } });
  await Promise.all([p.post('one', 't-1'), p.post('two', 't-1')]);
  assert.deepEqual(calls.map((c) => c.args), [['queue', '--thread', 't-1', '--message', 'one'], ['queue', '--thread', 't-1', '--message', 'two']]);
  assert.ok(calls[1]!.at - calls[0]!.at >= 39);
  await assert.rejects(p.post('three'), /no Codex session id/);
  const failing = new CodexQueuePoster('/bin/codex', { spacingMs: 0, run: async () => { throw new Error('codex queue: thread not found'); } });
  await assert.rejects(failing.post('x', 't'), /thread not found/);
});

test('codexConfirmGuard: only auto_review_enabled === false passes; refusals point at agentbridge approve', () => {
  assert.equal(codexConfirmGuard({ 'x-codex-turn-metadata': { auto_review_enabled: false } }, APPROVAL), null);
  for (const meta of [{ 'x-codex-turn-metadata': { auto_review_enabled: true } }, { 'x-codex-turn-metadata': {} }, {}, undefined, 'junk']) {
    const r = codexConfirmGuard(meta, APPROVAL)!;
    assert.equal(r.status, 'failed'); assert.equal(r.reason, 'host_refused');
    assert.ok(r.hint!.includes(`agentbridge approve ${APPROVAL}`));
  }
  assert.ok(codexConfirmGuard({}, 'not-an-id; rm -rf')!.hint!.includes('agentbridge approve <approval_id>'));
});

test('MCP server (codex): bridge_confirm under auto-review never reaches the bridge; other tools do', async () => {
  const seen: string[] = [];
  const server = createMcpServer({ nonce: '1a2b3c4d', version: 't', host: 'codex', caller: { callTool: async (name) => { seen.push(name); return { status: 'delivered' }; } } });
  const handler = (server as unknown as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>> })._requestHandlers.get('tools/call')!;
  const call = (name: string, meta: unknown) => handler({ method: 'tools/call', params: { name, arguments: { approval_id: APPROVAL }, _meta: meta } }, {});
  const refused = await call('bridge_confirm', { 'x-codex-turn-metadata': { auto_review_enabled: true } });
  assert.ok(refused.isError); assert.match(refused.content[0]!.text, /auto-review/);
  assert.equal(seen.length, 0);
  await call('bridge_confirm', { 'x-codex-turn-metadata': { auto_review_enabled: false } });
  await call('bridge_list_agents', undefined);
  assert.deepEqual(seen, ['bridge_confirm', 'bridge_list_agents']);
  // Claude Code is unaffected by Codex metadata
  const claude = createMcpServer({ nonce: '1a2b3c4d', version: 't', caller: { callTool: async (name) => { seen.push(`claude:${name}`); return { status: 'delivered' }; } } });
  const ch = (claude as unknown as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> })._requestHandlers.get('tools/call')!;
  await ch({ method: 'tools/call', params: { name: 'bridge_confirm', arguments: { approval_id: APPROVAL } } }, {});
  assert.equal(seen.at(-1), 'claude:bridge_confirm');
});

test('hook (codex): session events carry host; SessionStart prints the returned instruction as additionalContext', async () => {
  const p = buildSessionEvent({ hook_event_name: 'SessionStart', session_id: 'th-1', source: 'startup', permission_mode: 'default', cwd: '/w' }, 42, 'codex');
  assert.deepEqual(p, { event: 'start', claude_pid: 42, session_id: 'th-1', host: 'codex', source: 'startup', permission_mode: 'default', cwd: '/w' });
  IPC_METHODS.session_event.params.parse(p);
  const { dir, cleanup } = tempDir('abcxh-');
  const bridge = await new FakeBridge(join(dir, 'b.sock')).listen();
  const context = renderStandingInstruction('1a2b3c4d', 'codex');
  bridge.handlers.session_event = (params) => ((params as { host?: string }).host === 'codex' ? { ok: true, context } : { ok: true });
  try {
    const env = { AGENTBRIDGE_SOCKET: bridge.path };
    const out = await runHook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'th-1', source: 'startup' }), { env, ppid: 42, host: 'codex' });
    assert.deepEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
    assert.equal(await runHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'th-1', permission_mode: 'default' }), { env, ppid: 42, host: 'codex' }), '');
    assert.equal(await runHook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'c-1', source: 'startup' }), { env, ppid: 43 }), '');
    // bridge offline + no CLI: the message uses Codex's output format
    const off = await runHook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'th-2', source: 'startup' }), { env: { AGENTBRIDGE_SOCKET: join(dir, 'none.sock') }, ppid: 44, host: 'codex', findCli: () => null, setupInProgress: () => false });
    assert.match(JSON.parse(off).hookSpecificOutput.additionalContext, /bridge is not running/);
  } finally { await bridge.close(); cleanup(); }
});
