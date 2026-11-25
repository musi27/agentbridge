// IPC server (§10) over a real Unix socket, with simulated plugins and hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { IpcClient, IpcCallError } from '../src/ipc/client.ts';
import { AlreadyRunningError, acquireLock } from '../src/service.ts';
import { LsofPeerResolver, isDescendant } from '../src/ipc/peer.ts';
import { ipcHarness, cleanup, FakePlugin, hookEvent, inviteFacts, sleep, until } from './ipc-helpers.ts';

const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'ok'; } catch (e) { return e instanceof IpcCallError ? e.code : (e as Error).message; } };

test('ipc: socket 0600 in a 0700 dir, db 0600; single instance lock; stale lock replaced', async () => {
  const h = await ipcHarness();
  try {
    assert.equal(statSync(h.svc.paths.socket).mode & 0o777, 0o600);
    assert.equal(statSync(h.svc.paths.runDir).mode & 0o777, 0o700);
    assert.equal(statSync(h.svc.paths.db).mode & 0o777, 0o600);
    assert.equal(statSync(h.root).mode & 0o777, 0o700);
    assert.throws(() => acquireLock(h.svc.paths.lock), AlreadyRunningError);
    const stale = `${h.root}/stale.lock`; writeFileSync(stale, '999999');
    const release = acquireLock(stale); release();
  } finally { await h.stop(); cleanup(h); }
});

test('ipc: hello first, version check, unknown methods, malformed and oversized frames', async () => {
  const h = await ipcHarness();
  try {
    const c = await IpcClient.connect(h.svc.paths.socket);
    assert.equal(await code(c.request('register_session', {})), 'unauthenticated');
    assert.equal(typeof (await c.request<{ t: number }>('ping')).t, 'number');
    assert.equal(await code(c.request('hello', { protocol: 99, client: 'cli', client_version: '1' })), 'version_unsupported');
    assert.deepEqual(Object.keys(await c.request('hello', { protocol: 1, client: 'cli', client_version: '1' })).sort(), ['bridge_version', 'protocol']);
    assert.equal(await code(c.request('tool.bridge_wat', {})), 'method_not_found');
    c.close();
    const bad = await IpcClient.connect(h.svc.paths.socket);
    const closed = new Promise<void>((r) => bad.on('close', () => r()));
    bad.writeRaw('{not json\n'); await closed;
    const big = await IpcClient.connect(h.svc.paths.socket);
    const closed2 = new Promise<void>((r) => big.on('close', () => r()));
    big.writeRaw('x'.repeat(300 * 1024)); await closed2;
  } finally { await h.stop(); cleanup(h); }
});

test('§19.3 #5: unauthenticated connections cannot register as another client type, send, or confirm', async () => {
  const h = await ipcHarness();
  try {
    const anon = await IpcClient.open(h.svc.paths.socket, 'plugin');
    assert.equal(await code(anon.request('tool.bridge_send', { conversation_id: '01JD0000000000000000000000', body: 'x' })), 'unauthenticated');
    assert.equal(await code(anon.request('tool.bridge_confirm', { approval_id: '01JD0000000000000000000000', kind: 'start', peer: 'claude:x', direction: 'outgoing', topic: 't', turn_limit: 30 })), 'unauthenticated');
    assert.equal(await code(anon.request('post_result', { post_id: '01JD0000000000000000000000', ok: true })), 'unauthenticated');
    assert.equal(await code(anon.request('cli.status', {})), 'unauthenticated');
    const cli = await IpcClient.open(h.svc.paths.socket, 'cli');
    assert.equal(await code(cli.request('register_session', { claude_pid: 5, tag_nonce: 'abcdef01', inbox: { socket: 's', token: 't' }, plugin_version: '1' })), 'unauthenticated');
    assert.equal(await code(cli.request('tool.bridge_list_agents', {})), 'unauthenticated');
    // a process that is not a child of claude_pid cannot register or send hook events
    h.peer.queue.push(4242); h.peer.child(4242, 1);
    const impostor = await IpcClient.open(h.svc.paths.socket, 'plugin');
    assert.equal(await code(impostor.request('register_session', { claude_pid: 777, tag_nonce: 'abcdef01', inbox: { socket: 's', token: 't' }, plugin_version: '1' })), 'unauthenticated');
    assert.equal(await code(impostor.request('session_event', { event: 'start', claude_pid: 777, session_id: 's1', source: 'startup' })), 'unauthenticated');
    // a peer with another uid is refused at hello
    h.peer.queue.push(4343); h.peer.child(4343, 777, process.getuid!() + 1);
    const other = await IpcClient.connect(h.svc.paths.socket);
    assert.equal(await code(other.request('hello', { protocol: 1, client: 'plugin', client_version: '1' })), 'unauthenticated');
    for (const x of [anon, cli, impostor]) x.close();
  } finally { await h.stop(); cleanup(h); }
});

test('§10: registration via claude_pid; /clear links the new session id; resume maps by session id; fork → new participant', async () => {
  const h = await ipcHarness();
  try {
    h.peer.queue.push(501); h.peer.child(501, 100);
    await hookEvent(h, { event: 'start', claude_pid: 100, session_id: 'sess-1', source: 'startup', cwd: '/w/api', transcript_path: '/nonexistent/t1.jsonl' });
    h.peer.queue.push(502); h.peer.child(502, 100);
    const p = await FakePlugin.connect(h, 100);
    assert.equal(p.reg.address, 'claude:api'); assert.equal(p.reg.epoch, 1);
    const pid1 = p.reg.participant_id;
    assert.equal(h.svc.store.participant(pid1)!.session_id, 'sess-1');
    // /clear: new session id, same Claude process → same participant, link history kept
    await hookEvent(h, { event: 'end', claude_pid: 100, session_id: 'sess-1' });
    await hookEvent(h, { event: 'start', claude_pid: 100, session_id: 'sess-2', source: 'clear' });
    assert.equal(h.svc.store.session('sess-2')!.participant_id, pid1);
    assert.equal(h.svc.store.session('sess-2')!.linked_from, 'sess-1');
    assert.equal(h.svc.store.participant(pid1)!.state, 'live');
    // compaction: same id, same participant
    await hookEvent(h, { event: 'start', claude_pid: 100, session_id: 'sess-2', source: 'compact' });
    assert.equal(h.svc.store.participant(pid1)!.session_id, 'sess-2');
    // exit, then resume in a new Claude process → same participant (new epoch)
    p.close(); await until(() => h.svc.store.participant(pid1)!.state === 'closed', 'participant closed');
    await hookEvent(h, { event: 'start', claude_pid: 200, session_id: 'sess-2', source: 'resume' });
    const p2 = await FakePlugin.connect(h, 200);
    assert.equal(p2.reg.participant_id, pid1); assert.equal(p2.reg.epoch, 2);
    // fork → new participant
    await hookEvent(h, { event: 'start', claude_pid: 300, session_id: 'sess-3', source: 'fork', cwd: '/w/api' });
    const p3 = await FakePlugin.connect(h, 300);
    assert.notEqual(p3.reg.participant_id, pid1); assert.equal(p3.reg.address, 'claude:api-2');
    // MCP server registers before the resume hook: provisional participant is adopted
    p2.close(); await until(() => h.svc.store.participant(pid1)!.state === 'closed', 'participant closed');
    const p4 = await FakePlugin.connect(h, 400);
    assert.notEqual(p4.reg.participant_id, pid1);
    await hookEvent(h, { event: 'start', claude_pid: 400, session_id: 'sess-2', source: 'resume' });
    assert.equal(h.svc.store.participant(p4.reg.participant_id), undefined);
    assert.equal(h.svc.store.participant(pid1)!.state, 'live');
    assert.equal(h.svc.store.participant(pid1)!.claude_pid, 400);
    // the adopted connection keeps working (binding follows the adoption)
    assert.equal((await p4.tool('bridge_list_agents', {})).status, 'delivered');
    p3.close(); p4.close();
  } finally { await h.stop(); cleanup(h); }
});

test('§10: one live connection per participant; reconnect with session_secret keeps the epoch', async () => {
  const h = await ipcHarness();
  try {
    const p = await FakePlugin.connect(h, 100, { cwd: '/w/a' });
    const closed = new Promise<void>((r) => p.client.on('close', () => r()));
    const dup = await FakePlugin.connect(h, 100, { cwd: '/w/a' });
    await closed; // the old connection is closed
    assert.equal(dup.reg.participant_id, p.reg.participant_id); assert.equal(dup.reg.epoch, p.reg.epoch + 1);
    dup.close(); await until(() => h.svc.store.participant(dup.reg.participant_id)!.state === 'closed', 'participant closed');
    const re = await IpcClient.open(h.svc.paths.socket, 'plugin');
    assert.equal(await code(re.request('reconnect_session', { participant_id: dup.reg.participant_id, session_secret: 'nope', claude_pid: 100 })), 'unauthenticated');
    assert.equal(await code(re.request('reconnect_session', { participant_id: dup.reg.participant_id, session_secret: dup.reg.session_secret, claude_pid: 101 })), 'unauthenticated');
    const r = await re.request<{ epoch: number }>('reconnect_session', { participant_id: dup.reg.participant_id, session_secret: dup.reg.session_secret, claude_pid: 100 });
    assert.equal(r.epoch, dup.reg.epoch);
    assert.equal((await re.request<{ status: string }>('tool.bridge_list_agents', {})).status, 'delivered');
    re.close();
  } finally { await h.stop(); cleanup(h); }
});

test('ipc e2e: two Claude sessions converse through framed inbox posts; unknown mode holds until a hook reports it', async () => {
  const h = await ipcHarness();
  try {
    const a = await FakePlugin.connect(h, 100, { cwd: '/w/alice' });
    const b = await FakePlugin.connect(h, 200, { cwd: '/w/bob' });
    await hookEvent(h, { event: 'state', claude_pid: 100, session_id: 'sa', permission_mode: 'default' });
    const r = await a.tool('bridge_start_conversation', { peer: 'claude:bob', topic: 'review', first_message: 'please review' });
    assert.equal(r.status, 'pending_approval');
    const c = await a.tool('bridge_confirm', r.approval);
    assert.equal(c.status, 'awaiting_local_approval');
    await sleep(50);
    assert.equal(b.posts.length, 0); // bob's mode is unknown (SessionStart carries none): invite held
    await hookEvent(h, { event: 'state', claude_pid: 200, session_id: 'sb', permission_mode: 'acceptEdits' });
    const invite = await b.waitPost(/code="invite"/);
    assert.ok(invite.startsWith(`<ab-notice-${b.nonce} code="invite"`));
    assert.match(invite, new RegExp(`<ab-untrusted-${b.nonce}>review</ab-untrusted-${b.nonce}>`));
    const acc = await b.tool('bridge_confirm', inviteFacts(invite));
    assert.equal(acc.status, 'handed_off'); // inbox writes never confirm delivery (§11.3)
    const msg = await b.waitPost(/please review/);
    assert.match(msg, new RegExp(`^<ab-msg-${b.nonce} conversation="${c.conversation_id}" from="claude:alice" turn="1/30" id="[0-9A-Z]{26}">\\nplease review\\n</ab-msg-${b.nonce}>$`));
    assert.equal((await b.tool('bridge_send', { conversation_id: c.conversation_id, body: 'LGTM' })).status, 'handed_off');
    const back = await a.waitPost(/LGTM/);
    assert.ok(back.includes(`<ab-notice-${a.nonce} code="accepted"`)); // acceptance rides along with the first delivery
    // failed inbox write → retried, then reported
    b.failPosts = true;
    const f = await a.tool('bridge_send', { conversation_id: c.conversation_id, body: 'will fail first' });
    assert.equal(f.status, 'queued');
    b.failPosts = false;
    await b.waitPost(/will fail first/); // the pipeline's retry (≈2 s) delivers it
    // disconnect → queued; reconnect → delivered
    b.close(); await until(() => h.svc.store.participant(b.reg.participant_id)!.state === 'closed', 'participant closed');
    const q = await a.tool('bridge_send', { conversation_id: c.conversation_id, body: 'while away' });
    assert.equal(q.status, 'queued');
    const b2 = await FakePlugin.connect(h, 200, { cwd: '/w/bob' });
    await hookEvent(h, { event: 'state', claude_pid: 200, session_id: 'sb', permission_mode: 'default' });
    await b2.waitPost(/while away/);
    a.close(); b2.close();
  } finally { await h.stop(); cleanup(h); }
});

test('cli over ipc: unprivileged methods answer; privileged ones need the bridge-run presence check', async () => {
  const h = await ipcHarness();
  try {
    const cli = await IpcClient.open(h.svc.paths.socket, 'cli');
    const st = await cli.request<{ policy: { ok: boolean }; bridge_version: string }>('cli.status', {});
    assert.equal(st.policy.ok, true);
    h.presence.answer = { ok: false, code: 'cancelled' };
    assert.equal(await code(cli.request('cli.config_set', { key: 'approval.mode', value: 'auto' })), 'unauthenticated');
    assert.match(h.presence.reasons.at(-1)!, /^change its setting approval.mode$/);
    h.presence.answer = { ok: true, method: 'biometric_or_password' };
    const set = await cli.request<{ version: number }>('cli.config_set', { key: 'approval.mode', value: 'auto' });
    assert.equal(set.version, 2);
    assert.equal(await code(cli.request('cli.config_set', { key: 'limits.turns', value: '500' })), 'invalid_message');
    assert.equal(await code(cli.request('cli.add_grok', {})), 'invalid_message');
    assert.equal(await code(cli.request('cli.add_grok', { step: 'begin', name: 'researcher' })), 'bridge_offline'); // no relay configured
    assert.equal(await code(cli.request('cli.add_grok', { step: 'check', setup_id: 'forged' })), 'not_allowed'); // follow-ups need a real setup id
    const doc = await cli.request<{ checks: Array<{ id: string; ok: boolean }> }>('cli.doctor', {});
    assert.ok(doc.checks.find((x) => x.id === 'socket_permissions')!.ok);
    assert.ok(doc.checks.find((x) => x.id === 'db_permissions')!.ok);
    const logs = await cli.request<Array<{ type: string }>>('cli.logs', { limit: 5 });
    assert.ok(logs.length > 0);
    cli.close();
  } finally { await h.stop(); cleanup(h); }
});

test('cli over ipc: tampered policy leaves only status, doctor, config get/verify; verify restores', async () => {
  const h0 = await ipcHarness();
  h0.svc.store.db.run(`UPDATE policy SET value = '{"mode":"auto","timeout_ms":600000}' WHERE key = 'approval'`);
  const h = await h0.restart();
  try {
    const cli = await IpcClient.open(h.svc.paths.socket, 'cli');
    assert.equal((await cli.request<{ policy: { ok: boolean } }>('cli.status', {})).policy.ok, false);
    assert.equal(await code(cli.request('cli.agents', {})), 'policy_tampered');
    assert.equal(await code(cli.request('cli.approve', { approval_id: 'x' })), 'policy_tampered');
    const show = await cli.request<{ current: Record<string, string>; last_verified: Record<string, string> }>('cli.config_verify', { action: 'show' });
    assert.equal(show.current['approval.mode'], 'auto'); assert.equal(show.last_verified['approval.mode'], 'per_conversation');
    await cli.request('cli.config_verify', { action: 'restore' });
    assert.equal((await cli.request<{ policy: { ok: boolean; mode: string } }>('cli.status', {})).policy.mode, 'per_conversation');
    assert.ok(Array.isArray(await cli.request('cli.agents', {})));
    cli.close();
  } finally { await h.stop(); cleanup(h); }
});

test('peer: lsof resolver finds a real child process and its parent', async () => {
  const dir = mkdtempSync('/tmp/ab-peer-'); const path = `${dir}/s.sock`;
  const r = new LsofPeerResolver();
  let sock: import('node:net').Socket | null = null; let srvRef: import('node:net').Server | null = null;
  const got = new Promise<{ pid: number | null }>((resolve) => {
    const srv = createServer(async (s) => { sock = s; resolve({ pid: await r.peerPid(s) }); }); srvRef = srv;
    srv.listen(path, () => {
      const child = spawn(process.execPath, ['-e', `const s=require('net').connect(${JSON.stringify(path)}); s.on('close',()=>process.exit(0)); setTimeout(()=>process.exit(0),5000)`], { stdio: 'ignore' });
      childPid = child.pid!;
    });
  });
  let childPid = 0;
  const { pid } = await got;
  assert.equal(pid, childPid);
  assert.equal(await isDescendant(r, pid!, process.pid), true);
  assert.equal(await isDescendant(r, pid!, 1), false);
  assert.equal((await r.proc(process.pid))!.uid, process.getuid!());
  (sock as unknown as { destroy(): void } | null)?.destroy(); (srvRef as unknown as { close(): void } | null)?.close();
});
