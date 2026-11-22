// The bundled MCP server (plugin/runtime/server.mjs) over real stdio, against a fake bridge and a fake inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CLAUDE_TOOLS, NONCE_RE, STANDING_INSTRUCTION_TEMPLATE, ulid } from '@agentbridge/protocol';
import { FakeBridge, FakeInbox, tempDir, waitFor } from './helpers.ts';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'runtime', 'server.mjs');

async function start(t: { after: (fn: () => unknown) => void }) {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const bridge = await new FakeBridge(join(dir, 'b.sock')).listen(); t.after(() => bridge.close());
  const inbox = await new FakeInbox(join(dir, 'i.sock')).listen(); t.after(() => inbox.close());
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER], stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', AGENTBRIDGE_SOCKET: bridge.path, CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 'inbox-token' },
  });
  const client = new Client({ name: 'test-host', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return { bridge, inbox, client, transport };
}

test('initialize: standing instruction with a fresh nonce; registration uses the same nonce and our pid', async (t) => {
  const { bridge, client, transport } = await start(t);
  const instructions = client.getInstructions() ?? '';
  const nonce = /genuine tag code for this session is ([0-9a-f]{8})/.exec(instructions)?.[1];
  assert.ok(nonce && NONCE_RE.test(nonce));
  assert.equal(instructions, STANDING_INSTRUCTION_TEMPLATE.replaceAll('<NONCE>', nonce));
  assert.ok(instructions.length < 4000);
  assert.deepEqual(client.getServerCapabilities(), { tools: {} });
  assert.equal(client.getServerVersion()?.name, 'agentbridge');
  const reg = await waitFor(() => bridge.calls('register_session')[0], 'register_session');
  const p = reg.params as { claude_pid: number; tag_nonce: string; inbox: { socket: string; token: string } };
  assert.equal(p.tag_nonce, nonce);
  assert.equal(p.claude_pid, process.pid, 'parent of the MCP server');
  assert.equal(p.inbox.token, 'inbox-token');
  assert.ok(transport.pid);
});

test('two server processes get different nonces', async (t) => {
  const a = await start(t);
  const b = await start(t);
  assert.notEqual(a.client.getInstructions(), b.client.getInstructions());
});

test('tools/list: exactly CLAUDE_TOOLS, bridge_confirm carries requiresUserInteraction', async (t) => {
  const { client } = await start(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name), CLAUDE_TOOLS.map((x) => x.name));
  for (const def of CLAUDE_TOOLS) {
    const got = tools.find((x) => x.name === def.name)!;
    assert.deepEqual(got.inputSchema, def.inputSchema);
    assert.equal(got.description, def.description);
  }
  assert.deepEqual(tools.find((x) => x.name === 'bridge_confirm')!._meta, { 'anthropic/requiresUserInteraction': true });
  assert.equal(tools.filter((x) => x._meta).length, 1);
});

test('tool call round trip through the bridge', async (t) => {
  const { bridge, client } = await start(t);
  const approval = { approval_id: ulid(), kind: 'start', peer: 'grok:researcher', direction: 'outgoing', topic: 'Review the plan', turn_limit: 30 };
  bridge.handlers['tool.bridge_start_conversation'] = () => ({ status: 'pending_approval', approval, conversation_id: ulid() });
  const res = await client.callTool({ name: 'bridge_start_conversation', arguments: { peer: 'grok:researcher', topic: 'Review the plan', first_message: 'hello' } });
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  const nonce = /code for this session is ([0-9a-f]{8})/.exec(client.getInstructions() ?? '')![1]!;
  assert.match(text.split('\n')[0]!, /approval needed.*bridge_confirm/);
  assert.match(text, /status=pending_approval/);
  assert.match(text, new RegExp(`approval: approval_id=${approval.approval_id} kind=start peer=grok:researcher direction=outgoing turn_limit=30`));
  assert.ok(text.includes(`<ab-untrusted-${nonce}>Review the plan</ab-untrusted-${nonce}>`), 'topic framed with this session\'s nonce');
  assert.equal(res.isError, false);
  assert.deepEqual(bridge.calls('tool.bridge_start_conversation')[0]!.params, { peer: 'grok:researcher', topic: 'Review the plan', first_message: 'hello' });
});

test('unknown tool name never reaches the bridge', async (t) => {
  const { bridge, client } = await start(t);
  const res = await client.callTool({ name: 'bridge_delete_everything', arguments: {} });
  assert.equal(res.isError, true);
  assert.equal(bridge.received.filter((r) => r.method.startsWith('tool.')).length, 0);
});

test('deliver event produces inbox lines (auth + user) and post_results', async (t) => {
  const { bridge, inbox } = await start(t);
  const reg = await waitFor(() => bridge.calls('register_session')[0], 'register_session');
  const nonce = (reg.params as { tag_nonce: string }).tag_nonce;
  const items = [1, 2].map((n) => ({ post_id: ulid(), text: `<ab-msg-${nonce} id="m${n}">\nbody ${n}\n</ab-msg-${nonce}>` }));
  bridge.sendEvent(reg.conn, 'deliver', { items });
  await waitFor(() => bridge.calls('post_result').length === 2, 'post_results');
  // post_result follows the plugin's flushed write; the fake inbox may read those bytes a moment later.
  await waitFor(() => inbox.connections.length === 2 && inbox.connections.every((c) => c.lines.length === 2), 'inbox lines');
  for (const [i, c] of inbox.connections.entries()) {
    assert.deepEqual(c.lines.map((l) => JSON.parse(l)), [
      { type: 'auth', token: 'inbox-token' },
      { type: 'user', message: { role: 'user', content: items[i]!.text } },
    ]);
  }
  // Pacing (>= 200 ms) is asserted at the poster in inbox.test.ts; accept times here jitter under suite load.
  assert.deepEqual(bridge.calls('post_result').map((r) => r.params), items.map((i) => ({ post_id: i.post_id, ok: true })));
});

test('bridge offline: tool returns bridge_offline (isError) instead of hanging', async (t) => {
  const { bridge, client } = await start(t);
  await waitFor(() => bridge.calls('register_session')[0], 'register_session');
  await bridge.close();
  const res = await client.callTool({ name: 'bridge_list_agents', arguments: {} });
  assert.equal(res.isError, true);
  assert.match((res.content as Array<{ text: string }>)[0]!.text, /reason=bridge_offline/);
});
