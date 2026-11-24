import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanel, renderPanel, plainText } from '../src/cli/panel.ts';
import { runWatch, ENTER_SCREEN, LEAVE_SCREEN } from '../src/cli/watch.ts';
import { main } from '../src/cli/main.ts';
import { IpcClient } from '../src/ipc/client.ts';
import { fixtureStatus, NOW } from './fixtures/panel-status.ts';
import { ipcHarness, cleanup, FakePlugin, hookEvent } from './ipc-helpers.ts';

const view = (s = fixtureStatus(), cliVersion = '0.2.3') => buildPanel(s, { cliVersion, nowMs: NOW });

test('panel view model: sections from a status snapshot', () => {
  const v = view();
  assert.equal(v.health.bridgeVersion, '0.2.3'); assert.equal(v.health.pid, 4182);
  assert.equal(v.health.relay, 'connected'); assert.equal(v.health.versionMismatch, null); assert.equal(v.health.complete, true);
  // closed sessions are collapsed to a count
  assert.equal(v.closedCount, 3);
  assert.deepEqual(v.agents.map((a) => a.address), ['claude:agentbridge', 'claude:landing', 'claude:video-notes', 'codex:trading-bot', 'grok:researcher']);
  const by = Object.fromEntries(v.agents.map((a) => [a.address, a]));
  assert.equal(by['claude:landing']!.activity, 'waiting_first_prompt');
  assert.equal(by['codex:trading-bot']!.activity, 'approval');
  assert.equal(by['claude:video-notes']!.activity, 'in_conversation');
  assert.equal(by['grok:researcher']!.mode, 'bot'); assert.equal(by['grok:researcher']!.kind, 'grok');
  assert.equal(by['claude:agentbridge']!.title, 'status --watch');
  // active conversations first, with turns and age
  assert.deepEqual(v.conversations.map((c) => [c.a, c.b, c.state, `${c.turnsUsed}/${c.turnLimit}`, c.agoS]), [
    ['claude:video-notes', 'grok:researcher', 'active', '6/30', 120], ['grok:researcher', 'codex:trading-bot', 'pending', '0/10', 60]]);
  // approvals, then held deliveries; deliveries in flight (hold null) don't wait on the user
  assert.deepEqual(v.waiting.map((w) => w.type), ['approval', 'delivery']);
  assert.match(v.waiting[0]!.text, /approve in codex:trading-bot's own prompt · expires in 9m/);
  assert.match(v.waiting[1]!.text, /2 messages held until someone types in it/);
  // newest notice first
  assert.match(v.notices[0]!.title, /message waiting/); assert.equal(v.notices[0]!.agoS, 300);
});

test('panel view model: version mismatch, relay states, older bridge, tampered policy', () => {
  assert.match(view(fixtureStatus(), '0.2.4').health.versionMismatch!, /running bridge is 0.2.3 but this agentbridge is 0.2.4/);
  const relay = (r: { configured: boolean; connected: boolean | null; mode: string | null }) => { const s = fixtureStatus(); s.relay = r; return view(s).health; };
  assert.equal(relay({ configured: true, connected: false, mode: 'on_demand' }).relayText, 'relay idle (connects when a Grok bot needs it)');
  assert.equal(relay({ configured: true, connected: false, mode: 'always' }).relayText, 'relay DISCONNECTED');
  assert.equal(relay({ configured: false, connected: null, mode: 'on_demand' }).relay, 'not_configured');
  const old = fixtureStatus(); delete old.conversation_list; delete old.recent_notices; delete old.waiting_deliveries; delete old.relay; delete old.now;
  const ov = view(old);
  assert.equal(ov.health.complete, false); assert.equal(ov.health.relay, 'unknown'); assert.deepEqual(ov.conversations, []);
  assert.match(renderPanel(ov).join('\n'), /bridge is older than the CLI/);
  const t = fixtureStatus(); t.policy = { ok: false, reason: 'signature_mismatch' };
  assert.match(view(t).health.policy, /TAMPERED \(signature_mismatch\): run agentbridge config verify/);
});

test('panel: agent-written text cannot inject terminal escape sequences', () => {
  const evil = 'hi\u001b[2J\u001b[H\u001b]0;owned\u0007\u001b]8;;https://x.test\u001b\\link\u001b]8;;\u001b\\\r\nnext\u0000\u0007\u009b31m‮gnp.exe⁦';
  assert.equal(plainText(evil), 'hilink nextgnp.exe');
  assert.equal(plainText(undefined), ''); assert.equal(plainText(42), '42');
  const s = fixtureStatus();
  s.conversation_list![1]!.topic = evil;
  s.participants[0]!.title = `\u001b[31mred\u001b[0m title`;
  s.pending_approvals[0]!.topic = `x\u001bcy`;
  s.recent_notices![0]!.body = `\u001b[?1049lescape`;
  s.participants[1]!.address = 'claude:\u001b[1mbold';
  const v = view(s);
  assert.equal(v.conversations[0]!.topic, 'hilink nextgnp.exe');
  assert.equal(v.agents.find((a) => a.title.includes('red'))!.title, 'red title');
  // plain render: no ESC/C1 at all; colour render: only our own SGR codes
  const plain = renderPanel(v, { color: false }).join('\n');
  assert.doesNotMatch(plain, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
  const colour = renderPanel(v, { color: true }).join('\n');
  assert.deepEqual([...new Set(colour.match(/\u001b[^m]*m?/g))].filter((x) => !/^\u001b\[\d+m$/.test(x)), []);
});

test('panel render: matches the mockup layout and cuts long lines to the width', () => {
  const lines = renderPanel(view(), { width: 100, clock: '14:32:10' });
  const text = lines.join('\n');
  assert.match(lines[0]!, /^agentbridge 0\.2\.3 · pid 4182 · relay connected · policy v7, per_conversation {3}14:32:10$/);
  for (const h of ['WAITING ON YOU', 'CONVERSATIONS', 'AGENTS', 'NOTICES']) assert.match(text, new RegExp(`^${h}`, 'm'));
  assert.match(text, /◆ claude:video-notes ↔ grok:researcher\n {3}"b-roll ideas for this week" {3}6\/30 · 2m ago/);
  assert.match(text, /● accept: grok:researcher → codex:trading-bot {3}"funding-rate summary" {2}\(10 turns\)/);
  assert.match(text, /claude:landing +- +waiting for first prompt/);
  assert.match(text, /\+ 3 closed/);
  const s = fixtureStatus(); s.conversation_list![1]!.topic = 'x'.repeat(300);
  for (const l of renderPanel(view(s), { width: 60 })) assert.ok([...l].length <= 60, l);
});

test('watch: without a TTY prints one snapshot and returns', async () => {
  const out: string[] = []; let calls = 0;
  const code = await runWatch({ fetch: async () => { calls++; return fixtureStatus(); }, out: { isTTY: false, write: (s) => out.push(s) }, cliVersion: '0.2.3', now: () => NOW });
  assert.equal(code, 0); assert.equal(calls, 1);
  const text = out.join('');
  assert.doesNotMatch(text, /\u001b/); assert.match(text, /CONVERSATIONS/);
});

test('watch: on a TTY redraws in place until stopped, survives a bridge error, restores the screen', async () => {
  const out: string[] = []; let calls = 0; let stop!: () => void;
  const stopped = new Promise<void>((r) => { stop = r; });
  const code = await runWatch({
    fetch: async () => { calls++; if (calls === 2) throw new Error('agentbridge is not running'); return fixtureStatus(); },
    out: { isTTY: true, columns: 120, write: (s) => out.push(s) }, cliVersion: '0.2.3', now: () => NOW, stopped,
    sleep: async () => { if (calls >= 3) stop(); await Promise.resolve(); },
  });
  assert.equal(code, 0); assert.equal(calls, 3);
  assert.equal(out[0], ENTER_SCREEN); assert.equal(out.at(-1), LEAVE_SCREEN);
  const frames = out.slice(1, -1);
  assert.equal(frames.length, 3);
  for (const f of frames) assert.ok(f.startsWith('\u001b[H') && f.endsWith('\u001b[J'));
  assert.match(frames[1]!, /cannot read the bridge: agentbridge is not running/);
  assert.match(frames[2]!, /WAITING ON YOU/);
});

test('status --watch over ipc: one read-only snapshot with conversations; notices stay for plain status', async () => {
  const h = await ipcHarness();
  try {
    const a = await FakePlugin.connect(h, 100, { cwd: '/w/alice' });
    const b = await FakePlugin.connect(h, 200, { cwd: '/w/bob' });
    await hookEvent(h, { event: 'state', claude_pid: 100, session_id: 'sa', permission_mode: 'default' });
    const r = await a.tool('bridge_start_conversation', { peer: 'claude:bob', topic: 'review \u001b[2Jplease', first_message: 'hi' });
    await a.tool('bridge_confirm', r.approval);
    h.svc.store.insertEvent({ ts: Date.now(), level: 'warning', type: 'popup', participant_id: null, conversation_id: null, data: JSON.stringify({ title: 'agentbridge: test', body: 'a notice' }), popup: 1 });
    const cli = await IpcClient.open(h.svc.paths.socket, 'cli');
    const w = await cli.request<ReturnType<typeof fixtureStatus>>('cli.status', { watch: true });
    assert.equal(w.conversation_list!.length, 1);
    assert.doesNotMatch(w.conversation_list![0]!.topic, /\u001b/); // the bridge cleans topics on the way in; the view model cleans again
    assert.equal(w.conversation_list![0]!.initiator, 'claude:alice');
    assert.deepEqual(w.relay, { configured: false, connected: null, mode: 'on_demand' });
    assert.equal(w.recent_notices!.at(-1)!.title, 'agentbridge: test');
    assert.deepEqual(w.notifications, []);
    // the watch poll did not consume the notice: plain status still gets it once
    const plain = await cli.request<{ notifications: Array<{ title: string }>; conversation_list?: unknown }>('cli.status', {});
    assert.equal(plain.notifications.at(-1)!.title, 'agentbridge: test'); assert.equal(plain.conversation_list, undefined);
    assert.ok((await cli.request<{ recent_notices: unknown[] }>('cli.status', { watch: true })).recent_notices.length >= 1);
    cli.close();
    // the CLI without a TTY prints one cleaned snapshot
    const out: string[] = [];
    assert.equal(await main(['status', '--watch', '--home', h.root], (s) => out.push(s), () => {}), 0);
    const text = out.join('\n');
    assert.match(text, /claude:alice ↔ claude:bob {3}\(invite (pending|queued)\)\n {3}"review please"/);
    assert.doesNotMatch(text, /\u001b/);
    const json: string[] = [];
    assert.equal(await main(['status', '--watch', '--json', '--home', h.root], (s) => json.push(s), () => {}), 0);
    assert.ok(Array.isArray((JSON.parse(json.join('\n')) as { conversation_list: unknown[] }).conversation_list));
    assert.equal(await main(['status', '--frobnicate', '--home', h.root], () => {}, () => {}), 2);
    a.close(); b.close();
  } finally { await h.stop(); cleanup(h); }
});
