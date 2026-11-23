// Session addresses (folder + branch), Claude Code titles as labels, and the held-for-first-prompt hint/popup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '@agentbridge/protocol';
import { openDatabase, schemaVersion } from '../src/db/db.ts';
import { Store } from '../src/db/store.ts';
import { branchSuffix, gitBranch, readSessionTitle, sessionBaseName } from '../src/core/session-label.ts';
import { harness, openConversation } from './helpers.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ab-names-'));
function repo(dir: string, head: string): string { mkdirSync(join(dir, '.git'), { recursive: true }); writeFileSync(join(dir, '.git', 'HEAD'), `${head}\n`); return dir; }

test('gitBranch: plain repo, subfolder, worktree .git file, detached HEAD, no repo', () => {
  const d = tmp();
  const main = repo(join(d, 'agentbridge'), 'ref: refs/heads/main');
  assert.equal(gitBranch(main), 'main');
  mkdirSync(join(main, 'packages', 'bridge'), { recursive: true });
  assert.equal(gitBranch(join(main, 'packages', 'bridge')), 'main');
  const wtGit = join(main, '.git', 'worktrees', 'video'); mkdirSync(wtGit, { recursive: true });
  writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/claude/demo-video\n');
  const wt = join(d, 'wt-video'); mkdirSync(wt); writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.equal(gitBranch(wt), 'claude/demo-video');
  const det = repo(join(d, 'det'), '3f765fd0c0ffee');
  assert.equal(gitBranch(det), null);
  const none = join(d, 'plain'); mkdirSync(none);
  assert.equal(gitBranch(none), null);
});

test('session address: folder alone on default branches, folder + last branch segment otherwise', () => {
  assert.equal(branchSuffix('main'), null); assert.equal(branchSuffix('master'), null); assert.equal(branchSuffix(null), null);
  assert.equal(branchSuffix('claude/demo-video'), 'demo-video');
  const d = tmp();
  assert.equal(sessionBaseName(repo(join(d, 'agentbridge'), 'ref: refs/heads/main')), 'agentbridge');
  assert.equal(sessionBaseName(repo(join(d, 'site'), 'ref: refs/heads/feature/new hero!')), 'site-new-hero');
  assert.equal(sessionBaseName(repo(join(d, 'blissful-dewdney-88e5a2'), 'ref: refs/heads/claude/blissful-dewdney-88e5a2')), 'blissful-dewdney-88e5a2');
  assert.equal(sessionBaseName(repo(join(d, 'agentbridge-video'), 'ref: refs/heads/video')), 'agentbridge-video');
  const plain = join(d, 'notes'); mkdirSync(plain);
  assert.equal(sessionBaseName(plain), 'notes');
  assert.equal(sessionBaseName(null), 'session');
});

test('readSessionTitle: latest custom-title record wins, sanitised; missing or malformed gives null', () => {
  const d = tmp(); const t = join(d, 's.jsonl');
  assert.equal(readSessionTitle(t), null);
  writeFileSync(t, '{"type":"user","message":"hi"}\n');
  assert.equal(readSessionTitle(t), null);
  appendFileSync(t, '{"type":"custom-title","customTitle":"First title","sessionId":"x"}\n{"type":"assistant"}\n');
  assert.equal(readSessionTitle(t), 'First title');
  appendFileSync(t, '{"type":"custom-title","customTitle":"Finish demo\\u001b[31m videos\\n(LinkedIn)","sessionId":"x"}\n');
  assert.equal(readSessionTitle(t), 'Finish demo videos (LinkedIn)');
  appendFileSync(t, `{"type":"custom-title","customTitle":"${'x'.repeat(300)}"}\n`);
  assert.equal(readSessionTitle(t)!.length, 80);
  appendFileSync(t, '{"type":"custom-title","customTitle":"cut off');
  assert.equal(readSessionTitle(t)!.length, 80); // a half-written last line is skipped
});

test('storage: migration 3 adds participants.title', () => {
  const db = openDatabase(':memory:');
  assert.ok(schemaVersion(db) >= 3);
  const store = new Store(db); const now = Date.now();
  store.insertParticipant({ id: 'P1', agent: 'fake', name: 'p', display_name: 'p', title: null, cwd: null, claude_pid: null, session_id: null, transcript_path: null, permission_mode: 'default', inbound: 'accept', state: 'live', epoch: 1, bot_id: null, created_at: now, updated_at: now });
  store.updateParticipant('P1', { title: 'Review the plan' });
  assert.equal(store.participant('P1')!.title, 'Review the plan');
});

test('title label: read from the transcript on session events and shown in list_agents', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' });
  const b = h.engine.registerLocal({ agent: 'claude', name: 'bob', cwd: '/w/bob' });
  const t = join(tmp(), 't.jsonl'); writeFileSync(t, '{"type":"custom-title","customTitle":"Fix relay timeout"}\n');
  h.store.updateParticipant(b.participant_id, { claude_pid: 4242 });
  h.engine.sessionEvent({ event: 'state', claude_pid: 4242, session_id: 's1', transcript_path: t });
  assert.equal(h.store.participant(b.participant_id)!.title, 'Fix relay timeout');
  const r = await h.tool(a, 'bridge_list_agents', {});
  const row = (r.data as Array<{ address: string; title?: string }>).find((x) => x.address === b.address)!;
  assert.equal(row.title, 'Fix relay timeout');
  const plain = (r.data as Array<{ address: string; title?: string }>).find((x) => x.address !== b.address);
  assert.equal(plain?.title, undefined);
  h.engine.stop();
});

test('held for first prompt: the sender gets a plain-language hint, the user one popup after 30 s', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const conv = await openConversation(h, a, b);
  await h.tool(b, 'bridge_send', { conversation_id: conv, body: 'over to you' }); await h.idle();
  h.engine.setPermissionMode(b.participant_id, 'unknown');
  const s1 = await h.tool(a, 'bridge_send', { conversation_id: conv, body: 'held' });
  assert.equal(s1.status, 'queued');
  assert.match(s1.hint ?? '', /hasn't had its first prompt yet.*as soon as someone types in that session/);
  await h.idle();
  assert.equal(h.notifier.popups.filter((p) => p.title === 'agentbridge: message waiting').length, 0);
  await h.clock.advance(LIMITS.unknownModePopupMs); await h.idle();
  const pops = h.notifier.popups.filter((p) => p.title === 'agentbridge: message waiting');
  assert.equal(pops.length, 1);
  assert.match(pops[0]!.body, new RegExp(`${b.address} has a message waiting\\. Type anything in that session`));
  await h.clock.advance(LIMITS.unknownModePopupMs * 4); await h.idle();
  assert.equal(h.notifier.popups.filter((p) => p.title === 'agentbridge: message waiting').length, 1, 'once per session');
  h.engine.setPermissionMode(b.participant_id, 'default'); await h.idle();
  assert.ok(h.fake.bodies(b.participant_id).includes('held'));
  h.engine.stop();
});

test('held for first prompt: no popup when the session reports its mode within 30 s', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const conv = await openConversation(h, a, b);
  await h.tool(b, 'bridge_send', { conversation_id: conv, body: 'over to you' }); await h.idle();
  h.engine.setPermissionMode(b.participant_id, 'unknown');
  await h.tool(a, 'bridge_send', { conversation_id: conv, body: 'held' }); await h.idle();
  await h.clock.advance(LIMITS.unknownModePopupMs / 2);
  h.engine.setPermissionMode(b.participant_id, 'default'); await h.idle();
  await h.clock.advance(LIMITS.unknownModePopupMs); await h.idle();
  assert.equal(h.notifier.popups.filter((p) => p.title === 'agentbridge: message waiting').length, 0);
  h.engine.stop();
});
