// Codex CLI sessions (§11a): registration as codex:<name>, deliveries carry the session id for `codex queue`,
// the SessionStart hook gets the Codex standing instruction, reopen prints `codex resume`, and setup edits only
// the managed block in config.toml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStandingInstruction, STANDING_INSTRUCTION_TEMPLATE, CODEX_WRAPPER_BULLET, IPC_METHODS } from '@agentbridge/protocol';
import { ipcHarness, cleanup, FakePlugin, hookEvent, inviteFacts } from './ipc-helpers.ts';
import { IpcClient } from '../src/ipc/client.ts';
import { inviteNotice } from '../src/core/notices.ts';
import { addCodex, removeCodex, codexBlock, stripBlock, foreignTables, hasForeignServer, stableNodePath, BEGIN, END, CODEX_HOOK_EVENTS, CODEX_HOOK_NAMES } from '../src/init/codex.ts';

test('codex: registers as codex:<folder>, links the session id, deliveries carry it as thread_id', async () => {
  const h = await ipcHarness();
  try {
    h.peer.queue.push(601); h.peer.child(601, 900);
    const hook = hookEvent(h, { event: 'start', host: 'codex', claude_pid: 900, session_id: '01a2-thread', source: 'startup', cwd: '/w/api', permission_mode: 'default' });
    h.peer.queue.push(602); h.peer.child(602, 900);
    const cx = await FakePlugin.connect(h, 900, { host: 'codex' });
    await hook;
    assert.equal(cx.reg.address, 'codex:api');
    const row = h.svc.store.participant(cx.reg.participant_id)!;
    assert.equal(row.agent, 'codex'); assert.equal(row.session_id, '01a2-thread'); assert.equal(row.permission_mode, 'default');
    // a Claude session in the same folder keeps its own namespace
    h.peer.queue.push(701); h.peer.child(701, 950);
    await hookEvent(h, { event: 'start', claude_pid: 950, session_id: 'c-1', source: 'startup', cwd: '/w/api' });
    h.peer.queue.push(702); h.peer.child(702, 950);
    const cl = await FakePlugin.connect(h, 950);
    assert.equal(cl.reg.address, 'claude:api');
    await hookEvent(h, { event: 'state', claude_pid: 950, session_id: 'c-1', permission_mode: 'default' });
    // Claude invites Codex: the invite reaches the Codex plugin with the thread id
    const r = await cl.tool('bridge_start_conversation', { peer: 'codex:api', topic: 'review', first_message: 'hi codex' });
    assert.equal(r.status, 'pending_approval');
    await cl.tool('bridge_confirm', r.approval);
    const invite = await cx.waitPost(/approval_id=/);
    assert.equal(cx.threads.at(-1), '01a2-thread');
    assert.match(invite, new RegExp(`ab-notice-${cx.nonce}`));
    // Codex's prompt shows only the first three arguments by name: the invite asks for the display copies too
    assert.match(invite, /bridge_confirm with: about=<the topic exactly as above>, agent=claude:api, allowed_turns=30, approval_id=/);
    // an adapter that forwards the copies (older or newer than this bridge) is still accepted
    const f = inviteFacts(invite);
    const acc = await cx.tool('bridge_confirm', { ...f, about: f.topic, agent: f.peer, allowed_turns: f.turn_limit });
    assert.ok(['delivered', 'handed_off'].includes(acc.status), acc.status);
    await cx.waitPost(/hi codex/);
    assert.ok(cx.threads.every((t) => t === '01a2-thread'));
    // deliveries to Claude never carry a thread id
    const convs = (await cx.tool('bridge_list_conversations', {})).data as Array<{ conversation_id?: string; id?: string }>;
    const conv = convs[0]!.conversation_id ?? convs[0]!.id!;
    await cx.tool('bridge_send', { conversation_id: conv, body: 'hello claude' });
    await cl.waitPost(/hello claude/);
    assert.ok(cl.threads.every((t) => t === undefined));
    cx.close(); cl.close();
  } finally { await h.stop(); cleanup(h); }
});

test('codex: SessionStart returns the Codex standing instruction with the MCP server tag code (waits for registration)', async () => {
  const h = await ipcHarness();
  try {
    h.peer.queue.push(611); h.peer.child(611, 910);
    const hook = hookEvent(h, { event: 'start', host: 'codex', claude_pid: 910, session_id: 't-2', source: 'startup', cwd: '/w/web' });
    h.peer.queue.push(612); h.peer.child(612, 910);
    const cx = await FakePlugin.connect(h, 910, { host: 'codex' });
    const res = IPC_METHODS.session_event.result.parse(await hook);
    assert.equal(res.context, renderStandingInstruction(cx.nonce, 'codex'));
    assert.ok(res.context!.includes(CODEX_WRAPPER_BULLET.replaceAll('<NONCE>', cx.nonce)));
    assert.ok(!res.context!.includes('Another Claude session sent a message'));
    // Claude Code hooks get no context (Claude reads the MCP instructions)
    h.peer.queue.push(613); h.peer.child(613, 920);
    assert.deepEqual(await hookEvent(h, { event: 'start', claude_pid: 920, session_id: 'c-9', source: 'startup' }), { ok: true });
    // reopen command
    const cli = await IpcClient.open(h.svc.paths.socket, 'cli');
    try { assert.deepEqual(await cli.request('cli.open', { address: 'codex:web' }), { command: 'codex resume t-2', cwd: '/w/web' }); } finally { cli.close(); }
    cx.close();
  } finally { await h.stop(); cleanup(h); }
});

test('codex: a Claude registration without an inbox is refused; Codex needs none', async () => {
  const h = await ipcHarness();
  try {
    h.peer.queue.push(621); h.peer.child(621, 930);
    const p = await FakePlugin.connect(h, 930, { register: false });
    await assert.rejects(p.client.request('register_session', { claude_pid: 930, tag_nonce: p.nonce, plugin_version: '0.1.0' }), /inbox/);
    p.close();
  } finally { await h.stop(); cleanup(h); }
});

test('standing instruction: the Codex variant changes only the delivery-wrapper bullet', () => {
  const c = renderStandingInstruction('1a2b3c4d', 'codex'); const cl = renderStandingInstruction('1a2b3c4d');
  assert.notEqual(c, cl);
  const diff = c.split('\n').filter((l) => !cl.split('\n').includes(l));
  assert.deepEqual(diff, [CODEX_WRAPPER_BULLET]);
  assert.ok(STANDING_INSTRUCTION_TEMPLATE.includes('Another Claude session sent a message'));
});

test('add/remove codex: one managed block; foreign entries refused; round trip restores the file', () => {
  const home = mkdtempSync(join(tmpdir(), 'ab-codex-')); const env = { CODEX_HOME: home, PATH: '' };
  const cfg = join(home, 'config.toml');
  const original = 'model = "gpt-6-luna"\n\n[mcp_servers.docs]\ncommand = "python"\n';
  writeFileSync(cfg, original);
  const r = addCodex({ env, nodePath: '/usr/local/bin/node', runtimeDir: '/opt/ab/plugin/runtime' });
  assert.ok(r.ok && r.changed);
  const text = readFileSync(cfg, 'utf8');
  assert.ok(text.startsWith(original.trimEnd()));
  assert.ok(text.includes(BEGIN) && text.trimEnd().endsWith(END));
  assert.match(text, /\[mcp_servers\.agentbridge\]\ncommand = "\/usr\/local\/bin\/node"\nargs = \["\/opt\/ab\/plugin\/runtime\/server\.mjs", "--host=codex"\]/);
  assert.match(text, /default_tools_approval_mode = "approve"/);
  assert.match(text, /\[mcp_servers\.agentbridge\.tools\.bridge_confirm\]\napproval_mode = "prompt"/);
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd']) assert.ok(text.includes(`[[hooks.${ev}]]`), ev);
  assert.match(text, /command = "\/usr\/local\/bin\/node \/opt\/ab\/plugin\/runtime\/hook\.mjs --host=codex"/);
  assert.equal(readFileSync(`${cfg}.agentbridge-backup`, 'utf8'), original);
  assert.equal(addCodex({ env, nodePath: '/usr/local/bin/node', runtimeDir: '/opt/ab/plugin/runtime' }).changed, false, 'idempotent');
  // a changed runtime path replaces the block in place
  addCodex({ env, nodePath: '/usr/local/bin/node', runtimeDir: '/new/runtime' });
  const t2 = readFileSync(cfg, 'utf8');
  assert.equal(t2.split(BEGIN).length, 2); assert.ok(t2.includes('/new/runtime/server.mjs') && !t2.includes('/opt/ab/'));
  assert.ok(removeCodex({ env }).changed);
  assert.equal(readFileSync(cfg, 'utf8'), original);
  assert.equal(removeCodex({ env }).changed, false);
  // a user-written agentbridge server is not overwritten
  writeFileSync(cfg, `${original}\n[mcp_servers.agentbridge]\ncommand = "x"\n`);
  assert.equal(hasForeignServer(readFileSync(cfg, 'utf8')), true);
  const f = addCodex({ env, nodePath: '/n', runtimeDir: '/r' });
  assert.equal(f.ok, false); assert.match(f.message, /didn't write/);
  // no file yet: created
  const home2 = mkdtempSync(join(tmpdir(), 'ab-codex-'));
  assert.ok(addCodex({ env: { CODEX_HOME: home2 }, nodePath: '/n', runtimeDir: '/r' }).ok);
  assert.ok(readFileSync(join(home2, 'config.toml'), 'utf8').startsWith(BEGIN));
  assert.equal(existsSync(join(home2, 'config.toml.agentbridge-backup')), false);
  assert.equal(stripBlock(`a = 1\n\n${codexBlock('/n', '/r')}\n\nb = 2\n`), 'a = 1\n\nb = 2\n');
  assert.equal(stableNodePath('/definitely/missing/node'), '/definitely/missing/node');
});

test('add codex: every hook is named for /hooks (statusMessage), one name per event', () => {
  const block = codexBlock('/n', '/r');
  const names = [...block.matchAll(/^statusMessage = "(.*)"$/gm)].map((m) => m[1]);
  assert.deepEqual(names, CODEX_HOOK_EVENTS.map((ev) => CODEX_HOOK_NAMES[ev]));
  assert.equal(new Set(names).size, CODEX_HOOK_EVENTS.length);
  for (const n of names) assert.match(n!, /^agentbridge: \S/);
  // each name sits in its own event's handler table
  for (const ev of CODEX_HOOK_EVENTS) {
    const section = block.split(`[[hooks.${ev}.hooks]]`)[1]!.split('\n\n')[0]!;
    assert.ok(section.includes(`statusMessage = "${CODEX_HOOK_NAMES[ev]}"`), ev);
  }
});

test('add codex / init refresh: tables Codex appended inside the block (hook trust, folder trust) survive', () => {
  const home = mkdtempSync(join(tmpdir(), 'ab-codex-')); const env = { CODEX_HOME: home, PATH: '' };
  const cfg = join(home, 'config.toml'); const opts = { env, nodePath: '/n', runtimeDir: '/r' };
  // what 0.2.2 wrote (no names), after the user trusted the hooks in /hooks and trusted a folder: Codex appends
  // new tables at the end of the file, i.e. before our end marker
  const oldBlock = codexBlock('/n', '/r').replace(/^statusMessage = .*\n/gm, '');
  const codexAdded = [
    '[hooks.state]', '',
    '[hooks.state."/h/config.toml:pre_tool_use:0:0"]', 'trusted_hash = "sha256:aaa"', '',
    '[hooks.state."/h/config.toml:session_start:0:0"]', 'trusted_hash = "sha256:bbb"', '',
    '[projects."/w/api"]', 'trust_level = "trusted"',
  ].join('\n');
  const head = 'model = "gpt-6-luna"\n';
  writeFileSync(cfg, `${head}\n${oldBlock.replace(END, `\n${codexAdded}\n${END}`)}\n`);
  { const f = readFileSync(cfg, 'utf8'); assert.equal(foreignTables(f.slice(f.indexOf(BEGIN) + BEGIN.length, f.indexOf(END))), codexAdded); }
  // upgrade: the block is rewritten with names; Codex's tables move out of the block, unchanged
  assert.ok(addCodex(opts).changed);
  const t = readFileSync(cfg, 'utf8');
  assert.equal(t, `${head}\n${codexAdded}\n\n${codexBlock('/n', '/r')}\n`);
  assert.equal(t.split('[hooks.state."/h/config.toml:pre_tool_use:0:0"]').length, 2);
  // a second run (init's refresh) is a no-op
  assert.equal(addCodex(opts).changed, false);
  // Codex adds more trust later (again at the end of the file, inside the block): kept again
  writeFileSync(cfg, t.replace(END, `\n[hooks.state."/h/config.toml:stop:0:0"]\ntrusted_hash = "sha256:ccc"\n${END}`));
  assert.ok(addCodex(opts).changed);
  const t3 = readFileSync(cfg, 'utf8');
  assert.ok(t3.includes('[hooks.state."/h/config.toml:stop:0:0"]\ntrusted_hash = "sha256:ccc"'));
  assert.ok(t3.trimEnd().endsWith(`${codexBlock('/n', '/r')}`));
  assert.equal(addCodex(opts).changed, false);
  // remove keeps them too: they are the user's choices, and stale trust entries are inert (bound to a hash)
  assert.ok(removeCodex({ env }).changed);
  const t4 = readFileSync(cfg, 'utf8');
  assert.ok(!t4.includes(BEGIN) && !t4.includes('[[hooks.') && !t4.includes('mcp_servers.agentbridge'));
  assert.ok(t4.includes('[projects."/w/api"]\ntrust_level = "trusted"') && t4.includes('sha256:ccc'));
  // our own tables are never treated as foreign
  assert.equal(foreignTables(codexBlock('/n', '/r')), '');
});

test('invite notice: only a Codex invitee is asked for the display copies (about, agent, allowed_turns)', () => {
  const facts = { approval_id: '01JABCDEFGHJKMNPQRSTVWXYZ0', kind: 'accept' as const, peer: 'grok:researcher', direction: 'incoming' as const, topic: 'review', turn_limit: 12 };
  const accept = (n: { text: string }): string => n.text.split('\n').find((l) => l.startsWith('To accept'))!;
  const cx = accept(inviteNotice({ facts, conversationId: 'c', autoModeWarning: false, dontAsk: false, codex: true }));
  assert.match(cx, /^To accept, call bridge_confirm with: about=<the topic exactly as above>, agent=grok:researcher, allowed_turns=12, approval_id=/);
  const cl = accept(inviteNotice({ facts, conversationId: 'c', autoModeWarning: false, dontAsk: false }));
  assert.equal(cl, 'To accept, call bridge_confirm with: approval_id=01JABCDEFGHJKMNPQRSTVWXYZ0, kind=accept, peer=grok:researcher, direction=incoming, topic=<exactly as above>, turn_limit=12.');
});
