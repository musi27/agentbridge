import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { IPC_METHODS, ulid } from '@agentbridge/protocol';
import { BridgeClient } from '../src/bridge-client.ts';
import type { BridgeClientOptions } from '../src/bridge-client.ts';
import { FakeBridge, FakeInbox, IpcError, sleep, tempDir, waitFor } from './helpers.ts';

async function setup(t: { after: (fn: () => unknown) => void }, over: Partial<BridgeClientOptions> = {}) {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const bridge = await new FakeBridge(join(dir, 'b.sock')).listen(); t.after(() => bridge.close());
  const inbox = await new FakeInbox(join(dir, 'i.sock')).listen(); t.after(() => inbox.close());
  const client = new BridgeClient({
    socketPath: bridge.path, claudePid: 4321, tagNonce: 'abcdef01', inbox: { socket: inbox.path, token: 'tok' },
    pluginVersion: '0.4.0', cwd: '/work', backoff: { initialMs: 20, maxMs: 80 }, postSpacingMs: 30, ...over,
  });
  t.after(() => client.stop());
  return { dir, bridge, inbox, client };
}

test('registers with hello + register_session carrying pid, nonce, inbox, version, cwd', async (t) => {
  const { bridge, inbox, client } = await setup(t);
  client.start();
  await waitFor(() => client.state === 'registered', 'registered');
  assert.deepEqual(bridge.received.map((r) => r.method), ['hello', 'register_session']);
  assert.deepEqual(bridge.received[0]!.params, { protocol: 1, client: 'plugin', client_version: '0.4.0' });
  const reg = bridge.received[1]!.params;
  assert.deepEqual(reg, { claude_pid: 4321, tag_nonce: 'abcdef01', inbox: { socket: inbox.path, token: 'tok' }, plugin_version: '0.4.0', cwd: '/work' });
  IPC_METHODS.register_session.params.parse(reg);
  assert.equal(client.participant?.address, 'claude:fake-session');
});

test('tool call round trip: forwarded as tool.<name> on the registered connection', async (t) => {
  const { bridge, client } = await setup(t);
  const conv = ulid();
  bridge.handlers['tool.bridge_send'] = (p) => ({ status: 'handed_off', conversation_id: (p as { conversation_id: string }).conversation_id, message_id: ulid() });
  client.start();
  const r = await client.callTool('bridge_send', { conversation_id: conv, body: 'hi' });
  assert.equal(r.status, 'handed_off');
  assert.equal(r.conversation_id, conv);
  const call = bridge.calls('tool.bridge_send')[0]!;
  assert.deepEqual(call.params, { conversation_id: conv, body: 'hi' });
  assert.equal(call.conn, bridge.calls('register_session')[0]!.conn);
});

test('bridge error codes map to failed results; unknown codes become invalid_message', async (t) => {
  const { bridge, client } = await setup(t);
  bridge.handlers['tool.bridge_end_conversation'] = () => { throw new IpcError('unknown_conversation', 'no such conversation'); };
  bridge.handlers['tool.bridge_cancel'] = () => { throw new IpcError('internal', 'kaboom'); };
  bridge.handlers['tool.bridge_decline'] = () => ({ nonsense: true });
  client.start();
  assert.deepEqual(await client.callTool('bridge_end_conversation', { conversation_id: ulid() }), { status: 'failed', reason: 'unknown_conversation', hint: 'unknown_conversation: no such conversation' });
  assert.equal((await client.callTool('bridge_cancel', {})).reason, 'invalid_message');
  assert.equal((await client.callTool('bridge_decline', {})).reason, 'invalid_message');
});

test('no bridge: tools answer bridge_offline quickly, then work once the bridge appears', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const inbox = await new FakeInbox(join(dir, 'i.sock')).listen(); t.after(() => inbox.close());
  const sock = join(dir, 'b.sock');
  const client = new BridgeClient({ socketPath: sock, claudePid: 1, tagNonce: 'abcdef01', inbox: { socket: inbox.path, token: 't' }, pluginVersion: '0.4.0', backoff: { initialMs: 20, maxMs: 50 }, connectWaitMs: 200 });
  t.after(() => client.stop());
  client.start();
  const t0 = Date.now();
  const r = await client.callTool('bridge_list_agents', {});
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'bridge_offline');
  assert.ok(Date.now() - t0 < 10_000, 'answers instead of waiting for the 60 s tool timeout');
  const bridge = await new FakeBridge(sock).listen(); t.after(() => bridge.close());
  await waitFor(() => client.state === 'registered', 'registered after bridge start');
  assert.equal((await client.callTool('bridge_list_agents', {})).status, 'handed_off');
});

test('no inbox env: never registers; tools say why', async (t) => {
  const { bridge, client } = await setup(t, { inbox: null });
  client.start();
  await sleep(50);
  assert.equal(bridge.received.length, 0);
  const r = await client.callTool('bridge_list_agents', {});
  assert.equal(r.reason, 'host_refused');
  assert.match(r.hint ?? '', /CLAUDE_CODE_MESSAGING_SOCKET/);
});

test('incompatible bridge protocol -> version_unsupported', async (t) => {
  const { bridge, client } = await setup(t);
  bridge.handlers.hello = () => ({ protocol: 99, bridge_version: 'future' });
  client.start();
  const r = await client.callTool('bridge_list_agents', {});
  assert.equal(r.reason, 'version_unsupported');
});

test('after a drop: reconnect_session with the secret; falls back to register_session when refused', async (t) => {
  const { bridge, client } = await setup(t);
  client.start();
  await waitFor(() => client.state === 'registered', 'registered');
  const pid = client.participant!.id;
  bridge.dropAll();
  await waitFor(() => bridge.calls('reconnect_session').length === 1 && client.state === 'registered', 'reconnected');
  assert.deepEqual(bridge.calls('reconnect_session')[0]!.params, { participant_id: pid, session_secret: 'secret-1', claude_pid: 4321 });
  assert.equal(client.participant!.id, pid);

  bridge.handlers.reconnect_session = () => { throw new IpcError('unauthenticated', 'unknown participant'); };
  bridge.dropAll();
  await waitFor(() => bridge.calls('register_session').length === 2 && client.state === 'registered', 're-registered');
  assert.notEqual(client.participant!.id, pid);
});

test('deliver event: posts each item into the inbox in order, spaced, then post_result per item', async (t) => {
  const { bridge, inbox, client } = await setup(t);
  client.start();
  await waitFor(() => client.state === 'registered', 'registered');
  const conn = bridge.calls('register_session')[0]!.conn;
  const items = ['one', 'two', 'three'].map((text) => ({ post_id: ulid(), text: `<ab-msg-abcdef01 id="${text}">${text}</ab-msg-abcdef01>` }));
  bridge.sendEvent(conn, 'deliver', { items });
  await waitFor(() => bridge.calls('post_result').length === 3, '3 post_results');
  await waitFor(() => inbox.texts().length === 3, 'inbox read all 3 posts'); // the fake reads after the plugin's flush
  assert.deepEqual(inbox.texts(), items.map((i) => i.text));
  for (const c of inbox.connections) assert.deepEqual(JSON.parse(c.lines[0]!), { type: 'auth', token: 'tok' });
  assert.deepEqual(bridge.calls('post_result').map((r) => r.params), items.map((i) => ({ post_id: i.post_id, ok: true })));
  for (const r of bridge.calls('post_result')) IPC_METHODS.post_result.params.parse(r.params);
  // Pacing is asserted at the poster in inbox.test.ts; accept times here jitter under suite load.
});

test('deliver event: a failed inbox write is reported ok=false with the error', async (t) => {
  const { bridge, client } = await setup(t, { post: async (_t, text) => { if (text === 'B') throw new Error('inbox: EPIPE'); } });
  client.start();
  await waitFor(() => client.state === 'registered', 'registered');
  const items = ['A', 'B', 'C'].map((text) => ({ post_id: ulid(), text }));
  bridge.sendEvent(bridge.calls('register_session')[0]!.conn, 'deliver', { items });
  await waitFor(() => bridge.calls('post_result').length === 3, 'post_results');
  assert.deepEqual(bridge.calls('post_result').map((r) => (r.params as { ok: boolean }).ok), [true, false, true]);
  assert.equal((bridge.calls('post_result')[1]!.params as { error: string }).error, 'inbox: EPIPE');
});

test('deliver event: malformed events are ignored', async (t) => {
  const { bridge, inbox, client } = await setup(t);
  client.start();
  await waitFor(() => client.state === 'registered', 'registered');
  const conn = bridge.calls('register_session')[0]!.conn;
  bridge.sendEvent(conn, 'deliver', { items: [] });
  bridge.sendEvent(conn, 'deliver', { items: [{ post_id: 'not-a-ulid', text: 'x' }] });
  bridge.sendEvent(conn, 'something_else', {});
  await sleep(100);
  assert.equal(inbox.connections.length, 0);
  assert.equal(client.state, 'registered');
});

test('regression: a deliver event in the same read as the register_session answer is not lost', async (t) => {
  const { bridge, inbox, client } = await setup(t);
  const items = [{ post_id: ulid(), text: 'early-1' }, { post_id: ulid(), text: 'early-2' }];
  bridge.piggyback.register_session = () => [{ method: 'deliver', params: { items } }];
  client.start();
  await waitFor(() => bridge.calls('post_result').length === 2, 'post_results for the early deliver');
  await waitFor(() => inbox.texts().length === 2, 'inbox read both posts');
  assert.deepEqual(inbox.texts(), ['early-1', 'early-2']);
  assert.deepEqual(bridge.calls('post_result').map((r) => (r.params as { post_id: string }).post_id), items.map((i) => i.post_id));
});

test('regression: two deliver events in one read are processed in order, not interleaved', async (t) => {
  const { bridge, inbox, client } = await setup(t);
  client.start();
  await waitFor(() => client.state === 'registered', 'registered');
  bridge.handlers['tool.bridge_list_agents'] = () => ({ status: 'delivered' });
  bridge.piggyback['tool.bridge_list_agents'] = () => [
    { method: 'deliver', params: { items: [{ post_id: ulid(), text: 'A1' }, { post_id: ulid(), text: 'A2' }] } },
    { method: 'deliver', params: { items: [{ post_id: ulid(), text: 'B1' }] } },
  ];
  await client.callTool('bridge_list_agents', {});
  await waitFor(() => inbox.texts().length === 3, '3 posts');
  assert.deepEqual(inbox.texts(), ['A1', 'A2', 'B1']);
});

test('replaced: stops reconnecting and logs; an explicit tool call may reconnect', async (t) => {
  const logs: string[] = [];
  const retries: number[] = [];
  const { bridge, client } = await setup(t, { log: (m) => logs.push(m), onRetryScheduled: (ms) => retries.push(ms) });
  client.start();
  await waitFor(() => client.state === 'registered', 'registered');
  const conn = bridge.calls('register_session')[0]!.conn;
  bridge.sendEvent(conn, 'replaced', { reason: 'newer registration for claude_pid 4321' });
  await waitFor(() => client.state === 'replaced', 'replaced');
  await waitFor(() => bridge.sockets.every((s) => s.destroyed || s.readableEnded), 'old connection closed');
  await sleep(100); // a retry would be scheduled synchronously on close; give the close event a moment
  assert.deepEqual(retries, [], 'no automatic reconnect scheduled');
  assert.equal(bridge.calls('register_session').length + bridge.calls('reconnect_session').length, 1, 'no automatic reconnect');
  assert.ok(logs.some((l) => l.includes('replaced') && l.includes('newer registration for claude_pid 4321')));
  const r = await client.callTool('bridge_list_agents', {});
  assert.equal(r.status, 'handed_off');
  assert.equal(client.state, 'registered');
});

test('backoff keeps growing when the bridge closes right after each registration', async (t) => {
  // Asserts the delays the client schedules (jitter 0.8-1.2x), not wall-clock gaps, so machine load can't skew it.
  const delays: number[] = [];
  const { bridge, client } = await setup(t, { backoff: { initialMs: 20, maxMs: 320, stableMs: 10_000 }, onRetryScheduled: (ms) => delays.push(ms) });
  bridge.closeAfter.add('register_session');
  bridge.closeAfter.add('reconnect_session');
  client.start();
  await waitFor(() => delays.length >= 6, '6 scheduled retries');
  client.stop();
  assert.ok(bridge.calls('register_session').length + bridge.calls('reconnect_session').length >= 5, 'each retry re-registered');
  const nominal = [20, 40, 80, 160, 320, 320];
  nominal.forEach((n, i) => assert.ok(delays[i]! >= n * 0.8 - 0.001 && delays[i]! <= n * 1.2 + 0.001, `retry ${i + 1}: ${delays[i]} ms, expected ~${n} (all: ${delays.map(Math.round).join(',')})`));
});
