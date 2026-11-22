// Engine-level tests for the §6–§8 rules with two in-process fake participants (and a fake posing as Grok).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_MODE_WARNING } from '@agentbridge/protocol';
import { harness, openConversation, lastInvite } from './helpers.ts';

const MIN = 60_000;

test('§5: ambiguous label → recipient_ambiguous with candidates; short id disambiguates; unknown → recipient_gone', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' });
  // two participants that share a label (e.g. after renames) — created directly to force the collision
  const b1 = h.engine.registerLocal({ name: 'bob', cwd: '/w/one' });
  const b2 = h.engine.registerLocal({ name: 'bob2', cwd: '/w/two' });
  h.store.updateParticipant(b2.participant_id, { name: 'bob' });
  const r = await h.tool(a, 'bridge_start_conversation', { peer: 'fake:bob', topic: 't', first_message: 'x' });
  assert.equal(r.reason, 'recipient_ambiguous');
  assert.deepEqual(r.candidates!.map((c) => c.folder), ['one', 'two']);
  const ok = await h.tool(a, 'bridge_start_conversation', { peer: `fake:${r.candidates![1]!.short_id}`, topic: 't', first_message: 'x' });
  assert.equal(ok.status, 'pending_approval'); assert.equal(ok.approval!.peer, 'fake:bob');
  assert.equal((await h.tool(a, 'bridge_start_conversation', { peer: 'fake:nobody', topic: 't', first_message: 'x' })).reason, 'recipient_gone');
  assert.equal((await h.tool(a, 'bridge_start_conversation', { peer: a.address, topic: 't', first_message: 'x' })).reason, 'recipient_gone');
  void b1; h.engine.stop();
});

test('§6.2: decline → ended(declined), initiator notified, pair cooldown applies (§8.3)', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' });
  const c = await h.tool(a, 'bridge_confirm', r.approval);
  await h.idle();
  const d = await h.tool(b, 'bridge_decline', { conversation_id: c.conversation_id });
  assert.equal(d.status, 'declined');
  await h.idle();
  const conv = h.store.conversation(c.conversation_id!)!;
  assert.equal(conv.state, 'ended'); assert.equal(conv.end_reason, 'declined');
  assert.ok(h.fake.noticeCodes(a.participant_id).includes('declined'));
  // the invite's approval is gone
  assert.equal((await h.tool(b, 'bridge_confirm', lastInvite(h, b.participant_id))).reason, 'unknown_approval');
  // cooldown in both directions
  assert.equal((await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' })).reason, 'rate_limited');
  assert.equal((await h.tool(b, 'bridge_start_conversation', { peer: a.address, topic: 't', first_message: 'x' })).reason, 'rate_limited');
  await h.clock.advance(10 * MIN);
  assert.equal((await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' })).status, 'pending_approval');
  // only the invitee can decline; ended is terminal
  assert.equal((await h.tool(a, 'bridge_decline', { conversation_id: c.conversation_id })).reason, 'not_participant');
  assert.equal((await h.tool(b, 'bridge_decline', { conversation_id: c.conversation_id })).reason, 'conversation_ended');
  h.engine.stop();
});

test('§6.2: either participant may end; the other gets the summary; late messages → conversation_ended', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const cid = await openConversation(h, a, b);
  await h.tool(b, 'bridge_send', { conversation_id: cid, body: 'reply from bob' });
  const e = await h.tool(b, 'bridge_end_conversation', { conversation_id: cid });
  assert.equal(e.status, 'delivered');
  assert.match((e.data as { summary: string }).summary, /ended by participant/);
  await h.idle();
  const summary = h.fake.inbox(a.participant_id).flatMap((i) => i.notices).find((n) => n.code === 'ended')!;
  assert.ok(summary, 'initiator receives the end summary');
  // last messages appear only inside untrusted parts
  assert.ok(summary.parts.some((p) => p.kind === 'untrusted' && p.text === 'reply from bob'));
  assert.ok(!summary.parts.some((p) => p.kind === 'trusted' && p.text.includes('reply from bob')));
  assert.equal(h.store.conversation(cid)!.end_reason, 'ended_by_participant');
  assert.equal((await h.tool(a, 'bridge_send', { conversation_id: cid, body: 'x' })).reason, 'conversation_ended');
  assert.equal((await h.tool(a, 'bridge_end_conversation', { conversation_id: cid })).reason, 'conversation_ended');
  // continue in a new conversation
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 'again', first_message: 'x', continues: cid });
  assert.equal(r.status, 'pending_approval');
  assert.equal((await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 'again', first_message: 'x', continues: '01JD0000000000000000000000' })).reason, 'unknown_conversation');
  h.engine.stop();
});

test('§6.2: sending before acceptance is refused; initiator can withdraw a pending invite', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' });
  const c = await h.tool(a, 'bridge_confirm', r.approval);
  assert.equal((await h.tool(a, 'bridge_send', { conversation_id: c.conversation_id, body: 'early' })).reason, 'invalid_message');
  assert.equal((await h.tool(a, 'bridge_end_conversation', { conversation_id: c.conversation_id })).status, 'delivered');
  await h.idle();
  assert.ok(h.fake.noticeCodes(b.participant_id).includes('declined')); // "withdrew the invitation"
  assert.equal(h.store.conversation(c.conversation_id!)!.end_reason, 'ended_by_participant');
  h.engine.stop();
});

test('§6.4: idempotent retries return the original result (start, send) within one epoch only', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const s1 = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x', idempotency_key: 'k1' });
  const s2 = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x', idempotency_key: 'k1' });
  assert.deepEqual(s2, s1);
  assert.equal(h.engine.approvals.all().length, 1);
  const cid = await openConversation(h, a, b);
  const m1 = await h.tool(a, 'bridge_send', { conversation_id: cid, body: 'hello again', idempotency_key: 'm1' });
  const m2 = await h.tool(a, 'bridge_send', { conversation_id: cid, body: 'hello again', idempotency_key: 'm1' });
  assert.deepEqual(m2, m1);
  assert.equal(h.store.messages(cid).filter((m) => m.body === 'hello again').length, 1);
  // a new registration epoch does not collide with old keys
  const a2 = h.engine.registerLocal({ name: 'alice', id: a.participant_id });
  assert.equal(a2.epoch, a.epoch + 1);
  const m3 = await h.tool(a2, 'bridge_send', { conversation_id: cid, body: 'hello again', idempotency_key: 'm1' });
  assert.notEqual(m3.message_id, m1.message_id);
  // the old epoch can no longer call tools
  assert.equal((await h.tool(a, 'bridge_send', { conversation_id: cid, body: 'stale' })).reason, 'not_participant');
  // keys expire after 24 h
  await h.clock.advance(24 * 60 * MIN + 61_000);
  const m4 = await h.tool(a2, 'bridge_send', { conversation_id: cid, body: 'hello again', idempotency_key: 'm1' });
  assert.notEqual(m4.message_id, m3.message_id);
  h.engine.stop();
});

test('§6.5: turn header warning near the limit; extension via approval raises the limit and notifies the peer', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const cid = await openConversation(h, a, b, { turn_limit: 4 });
  const ext = await h.tool(a, 'bridge_extend_conversation', { conversation_id: cid, add_turns: 6 });
  assert.equal(ext.status, 'pending_approval');
  assert.deepEqual({ ...ext.approval, approval_id: '-' }, { approval_id: '-', kind: 'extend', peer: b.address, direction: 'none', topic: 'design review', turn_limit: 10 });
  assert.equal((await h.tool(b, 'bridge_confirm', ext.approval)).reason, 'approval_mismatch'); // bound to the requester
  const ok = await h.tool(a, 'bridge_confirm', ext.approval);
  assert.equal(ok.status, 'delivered'); assert.deepEqual(ok.data, { turn_limit: 10 });
  await h.idle();
  assert.equal(h.store.conversation(cid)!.turn_limit, 10);
  assert.ok(h.fake.noticeCodes(b.participant_id).includes('extended'));
  assert.equal((await h.tool(a, 'bridge_extend_conversation', { conversation_id: cid, add_turns: 191 })).reason, 'invalid_message');
  h.engine.stop();
});

test('§6.5: extension after the limit is impossible (ended is terminal)', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const cid = await openConversation(h, a, b, { turn_limit: 2 });
  const ext = await h.tool(a, 'bridge_extend_conversation', { conversation_id: cid, add_turns: 5 });
  await h.tool(b, 'bridge_send', { conversation_id: cid, body: 'last' });
  await h.idle();
  assert.equal(h.store.conversation(cid)!.state, 'ended');
  assert.equal((await h.tool(a, 'bridge_confirm', ext.approval)).status, 'failed'); // approval cancelled with the conversation
  assert.equal((await h.tool(a, 'bridge_extend_conversation', { conversation_id: cid, add_turns: 5 })).reason, 'conversation_ended');
  h.engine.stop();
});

test('§6.5: a permanently failed delivery does not consume a turn; retryable failures retry with backoff', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const cid = await openConversation(h, a, b, { turn_limit: 5 });
  const before = h.store.conversation(cid)!.turn_count;
  h.fake.nextOutcome(() => ({ status: 'failed', reason: 'host_refused', retryable: false }));
  const r = await h.tool(a, 'bridge_send', { conversation_id: cid, body: 'lost' });
  assert.equal(r.status, 'failed');
  assert.equal(h.store.conversation(cid)!.turn_count, before);
  assert.equal(h.store.message(r.message_id!)!.status, 'failed');
  // retryable: 3 retries (2 s, 10 s, 30 s) then failed
  h.fake.setParticipantOutcome(b.participant_id, () => ({ status: 'failed', reason: 'host_refused', retryable: true }));
  const r2 = await h.tool(a, 'bridge_send', { conversation_id: cid, body: 'flaky' });
  assert.equal(r2.status, 'queued');
  await h.clock.advance(2_000); await h.idle();
  await h.clock.advance(10_000); await h.idle();
  await h.clock.advance(30_000); await h.idle();
  assert.equal(h.store.message(r2.message_id!)!.status, 'failed');
  assert.equal(h.fake.log.filter((x) => x.item.messages.some((m) => m.body === 'flaky')).length, 4);
  assert.equal(h.store.conversation(cid)!.turn_count, before);
  assert.ok(h.fake.noticeCodes(a.participant_id).includes('delivery_failed'));
  h.engine.stop();
});

test('§6.5/§9.1: closed recipient → queued + popup, delivered on reopen; queue expiry notifies and frees the turn', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const cid = await openConversation(h, a, b);
  h.engine.setLocalLive(b.participant_id, false);
  const r = await h.tool(a, 'bridge_send', { conversation_id: cid, body: 'while closed' });
  assert.equal(r.status, 'queued'); assert.match(r.hint!, /agentbridge open fake:bob/);
  await h.idle();
  assert.ok(h.notifier.popups.some((p) => p.body.includes('agentbridge open fake:bob')));
  assert.equal(h.store.conversation(cid)!.queued, 1);
  h.engine.setLocalLive(b.participant_id, true); await h.idle();
  assert.ok(h.fake.bodies(b.participant_id).includes('while closed'));
  assert.equal(h.store.conversation(cid)!.queued, 0);
  // expiry
  h.engine.setLocalLive(b.participant_id, false);
  const turns = h.store.conversation(cid)!.turn_count;
  const r2 = await h.tool(a, 'bridge_send', { conversation_id: cid, body: 'never read' });
  assert.equal(h.store.conversation(cid)!.turn_count, turns + 1);
  await h.clock.advance(7 * 24 * 60 * MIN + 60_000); await h.idle();
  assert.equal(h.store.message(r2.message_id!)!.status, 'expired');
  assert.equal(h.store.conversation(cid)!.turn_count, turns);
  assert.ok(h.fake.noticeCodes(a.participant_id).includes('queue_expired'));
  assert.ok(h.notifier.popups.some((p) => /expired/.test(p.title)));
  h.engine.stop();
});

test('§6.2 flags: waiting_on and the one-time 1 h no-reply notice, cleared by a reply', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const cid = await openConversation(h, a, b);
  assert.equal(h.store.conversation(cid)!.waiting_on, b.participant_id);
  await h.clock.advance(59 * MIN); await h.idle();
  assert.ok(!h.fake.noticeCodes(a.participant_id).includes('no_reply'));
  await h.clock.advance(MIN); await h.idle();
  assert.equal(h.fake.noticeCodes(a.participant_id).filter((c) => c === 'no_reply').length, 1);
  await h.clock.advance(120 * MIN); await h.idle();
  assert.equal(h.fake.noticeCodes(a.participant_id).filter((c) => c === 'no_reply').length, 1);
  await h.tool(b, 'bridge_send', { conversation_id: cid, body: 'sorry', reply_expected: false });
  assert.equal(h.store.conversation(cid)!.waiting_on, null);
  h.engine.stop();
});

test('§7.6: start approval expires after 10 min; requester notified; confirm afterwards → unknown_approval', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' });
  await h.clock.advance(10 * MIN); await h.idle();
  assert.ok(h.fake.noticeCodes(a.participant_id).includes('approval_expired'));
  assert.equal((await h.tool(a, 'bridge_confirm', r.approval)).reason, 'unknown_approval');
  assert.equal(h.store.conversations().length, 0);
  h.engine.stop();
});

test('§7.6: accept approval timer starts at hand-off; expiry ends the conversation and notifies both (popup if closed)', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  h.engine.setLocalLive(b.participant_id, false);
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' });
  const c = await h.tool(a, 'bridge_confirm', r.approval);
  assert.equal(c.status, 'queued'); // invitee closed: the invite waits in the queue, no approval yet
  assert.equal(h.engine.approvals.all().length, 0);
  await h.clock.advance(60 * MIN); // no timer running yet
  h.engine.setLocalLive(b.participant_id, true); await h.idle();
  assert.equal(h.engine.approvals.all().length, 1);
  assert.notEqual(h.engine.approvals.all()[0]!.expires_at, null);
  h.engine.setLocalLive(b.participant_id, false);
  await h.clock.advance(10 * MIN); await h.idle();
  const conv = h.store.conversation(c.conversation_id!)!;
  assert.equal(conv.state, 'ended'); assert.equal(conv.end_reason, 'approval_expired');
  assert.ok(h.fake.noticeCodes(a.participant_id).includes('approval_expired'));
  assert.ok(h.notifier.popups.some((p) => p.title.includes('fake:bob')));
  h.engine.stop();
});

test('§6.2: an invite to a closed session expires with the queue (invite_expired)', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  h.engine.setLocalLive(b.participant_id, false);
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' });
  const c = await h.tool(a, 'bridge_confirm', r.approval);
  await h.clock.advance(7 * 24 * 60 * MIN + 2 * MIN); await h.idle();
  assert.equal(h.store.conversation(c.conversation_id!)!.end_reason, 'invite_expired');
  h.engine.stop();
});

test('§7.3: bridge restart drops pending approvals; requesters notified; old facts no longer confirm', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 'before restart', first_message: 'x' });
  // a second pair with an accept approval that was handed off
  const c2 = h.engine.registerLocal({ name: 'carol' }); const d2 = h.engine.registerLocal({ name: 'dave' });
  const r2 = await h.tool(c2, 'bridge_start_conversation', { peer: d2.address, topic: 'x', first_message: 'x' });
  const conv2 = await h.tool(c2, 'bridge_confirm', r2.approval);
  await h.idle();
  const h2 = await h.restart();
  // participants come back closed; re-register (new epochs)
  const a2 = h2.engine.registerLocal({ name: 'alice', id: a.participant_id });
  const c22 = h2.engine.registerLocal({ name: 'carol', id: c2.participant_id });
  h2.engine.registerLocal({ name: 'dave', id: d2.participant_id });
  await h2.idle();
  assert.equal(h2.engine.approvals.all().length, 0);
  assert.equal((await h2.tool(a2, 'bridge_confirm', r.approval)).reason, 'unknown_approval');
  assert.ok(h2.fake.noticeCodes(a.participant_id).includes('approval_expired'));
  assert.equal(h2.store.conversation(conv2.conversation_id!)!.end_reason, 'approval_expired');
  assert.ok(h2.fake.noticeCodes(c22.participant_id).includes('approval_expired'));
  h2.engine.stop();
});

test('§7.3: restart before the invite was handed off re-issues it when the invitee is live', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  h.fake.setParticipantOutcome(b.participant_id, () => ({ status: 'queued' })); // invite stuck before hand-off
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' });
  const c = await h.tool(a, 'bridge_confirm', r.approval);
  await h.idle();
  h.fake.setParticipantOutcome(b.participant_id, null);
  const h2 = await h.restart();
  const b2 = h2.engine.registerLocal({ name: 'bob', id: b.participant_id });
  await h2.idle();
  const conv = h2.store.conversation(c.conversation_id!)!;
  assert.equal(conv.state, 'pending'); assert.notEqual(conv.invite_issued_at, null);
  const inv = lastInvite(h2, b.participant_id);
  assert.equal((await h2.tool(b2, 'bridge_confirm', inv)).status, 'delivered');
  h2.engine.stop();
});

test('§7.5: deny rule → not_allowed in every mode; auto + allow rule skips both approvals', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice', cwd: '/w/a' }); const b = h.engine.registerLocal({ name: 'bob' });
  await h.setPolicy('allowlist.add', 'deny fake:alice -> fake:bob');
  assert.equal((await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' })).reason, 'not_allowed');
  await h.setPolicy('allowlist.remove', '1');
  await h.setPolicy('approval.mode', 'auto');
  // empty allowlist in auto behaves like per_conversation
  assert.equal((await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' })).status, 'pending_approval');
  await h.setPolicy('allowlist.add', 'allow fake:* -> fake:* cwd /w');
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 'auto talk', first_message: 'auto hello' });
  assert.equal(r.status, 'delivered');
  await h.idle();
  assert.equal(h.store.conversation(r.conversation_id!)!.state, 'active');
  assert.equal(h.store.conversation(r.conversation_id!)!.effective_mode, 'auto');
  const item = h.fake.inbox(b.participant_id).find((i) => i.messages.some((m) => m.body === 'auto hello'))!;
  assert.deepEqual(item.notices.map((n) => n.code), ['invite_accepted']);
  h.engine.stop();
});

test('§8.4: bypass sessions cannot start, accept or receive (unless allowed); auto sessions get the warning', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice', permission_mode: 'bypassPermissions' });
  const b = h.engine.registerLocal({ name: 'bob' });
  assert.equal((await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' })).reason, 'requester_unsafe_mode');
  assert.equal((await h.tool(b, 'bridge_start_conversation', { peer: a.address, topic: 't', first_message: 'x' })).reason, 'recipient_unsafe_mode');
  assert.ok(h.notifier.popups.some((p) => /bypassPermissions/.test(p.body)));
  // receiving in an active conversation after switching to bypass
  h.engine.setPermissionMode(a.participant_id, 'default');
  const cid = await openConversation(h, b, a);
  h.engine.setPermissionMode(a.participant_id, 'bypassPermissions');
  const s = await h.tool(b, 'bridge_send', { conversation_id: cid, body: 'x' });
  assert.equal(s.status, 'failed'); assert.equal(s.reason, 'recipient_unsafe_mode');
  await h.setPolicy('delivery.allow_bypass_sessions', 'true');
  assert.equal((await h.tool(b, 'bridge_send', { conversation_id: cid, body: 'y' })).status, 'delivered');
  // auto mode: allowed, with the warning in pending_approval and in the invite
  const c = h.engine.registerLocal({ name: 'carol', permission_mode: 'auto' });
  const d = h.engine.registerLocal({ name: 'dave', permission_mode: 'auto' });
  const r = await h.tool(c, 'bridge_start_conversation', { peer: d.address, topic: 't', first_message: 'x' });
  assert.equal(r.status, 'pending_approval'); assert.equal(r.warning, AUTO_MODE_WARNING);
  await h.tool(c, 'bridge_confirm', r.approval); await h.idle();
  const inv = h.fake.inbox(d.participant_id).flatMap((i) => i.notices).find((n) => n.code === 'invite')!;
  assert.ok(inv.parts.some((p) => p.kind === 'trusted' && p.text === AUTO_MODE_WARNING));
  assert.equal((await h.tool(d, 'bridge_confirm', lastInvite(h, d.participant_id))).status, 'delivered');
  h.engine.stop();
});

test('§8.4: unknown mode holds invites and deliveries until the mode is known', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' });
  const b = h.engine.registerLocal({ name: 'bob', permission_mode: 'unknown' });
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' });
  const c = await h.tool(a, 'bridge_confirm', r.approval);
  assert.equal(c.status, 'awaiting_local_approval');
  await h.idle();
  assert.equal(h.fake.inbox(b.participant_id).length, 0);
  h.engine.setPermissionMode(b.participant_id, 'default'); await h.idle();
  assert.equal(h.fake.noticeCodes(b.participant_id)[0], 'invite');
  await h.tool(b, 'bridge_confirm', lastInvite(h, b.participant_id)); await h.idle();
  h.engine.setPermissionMode(b.participant_id, 'unknown');
  const s = await h.tool(a, 'bridge_send', { conversation_id: c.conversation_id, body: 'held' });
  assert.equal(s.status, 'queued');
  h.engine.setPermissionMode(b.participant_id, 'plan'); await h.idle();
  assert.ok(h.fake.bodies(b.participant_id).includes('held'));
  h.engine.stop();
});

test('§8.4: dontAsk sessions cannot confirm; cancel keeps the approval for agentbridge approve', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice', permission_mode: 'dontAsk' }); const b = h.engine.registerLocal({ name: 'bob' });
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' });
  assert.match(r.hint!, /agentbridge approve/);
  assert.equal((await h.tool(a, 'bridge_confirm', r.approval)).reason, 'approval_unavailable');
  assert.equal((await h.tool(a, 'bridge_cancel', { approval_id: r.approval!.approval_id })).reason, 'approval_unavailable');
  assert.equal(h.engine.approvals.all().length, 1);
  const ok = await h.engine.approveById(r.approval!.approval_id);
  assert.equal(ok.status, 'awaiting_local_approval');
  h.engine.stop();
});

test('§7.3: bridge_cancel (user denied the prompt) cancels; accept cancel declines the conversation', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' });
  assert.equal((await h.tool(b, 'bridge_cancel', { approval_id: r.approval!.approval_id })).reason, 'unknown_approval');
  assert.equal((await h.tool(a, 'bridge_cancel', { approval_id: r.approval!.approval_id })).status, 'declined');
  const r2 = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't2', first_message: 'x' });
  const c = await h.tool(a, 'bridge_confirm', r2.approval); await h.idle();
  const inv = lastInvite(h, b.participant_id);
  assert.equal((await h.tool(b, 'bridge_cancel', { approval_id: inv.approval_id })).status, 'declined');
  assert.equal(h.store.conversation(c.conversation_id!)!.end_reason, 'declined');
  h.engine.stop();
});

test('§8.3: at most 3 pending invites per requester and 10 per target', async () => {
  const h = await harness();
  const g = h.engine.createBot({ name: 'researcher', bot_id: 'bot00001', token_hash: 'h' });
  const grok = { participant_id: g.id, epoch: 0 };
  const targets = [1, 2, 3, 4].map((i) => h.engine.registerLocal({ name: `t${i}` }));
  for (const t of targets.slice(0, 3)) assert.equal((await h.tool(grok, 'bridge_start_conversation', { peer: t.address, topic: 't', first_message: 'x' })).status, 'awaiting_local_approval');
  const over = await h.tool(grok, 'bridge_start_conversation', { peer: targets[3]!.address, topic: 't', first_message: 'x' });
  assert.equal(over.reason, 'rate_limited');
  await h.idle();
  assert.ok(h.grok.noticeCodes(g.id).includes('rate_limited'));
  // per target
  const h2 = await harness();
  const target = h2.engine.registerLocal({ name: 'target' });
  const senders = Array.from({ length: 11 }, (_, i) => h2.engine.registerLocal({ name: `s${i}` }));
  for (const s of senders.slice(0, 10)) {
    const r = await h2.tool(s, 'bridge_start_conversation', { peer: target.address, topic: 't', first_message: 'x' });
    assert.equal((await h2.tool(s, 'bridge_confirm', r.approval)).status, 'awaiting_local_approval');
  }
  assert.equal((await h2.tool(senders[10]!, 'bridge_start_conversation', { peer: target.address, topic: 't', first_message: 'x' })).reason, 'rate_limited');
  h.engine.stop(); h2.engine.stop();
});

test('§8.4/§11.3: unreachable recipient (crossSessionInbound hold) → queued with recipient_unreachable', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const cid = await openConversation(h, a, b);
  h.store.updateParticipant(b.participant_id, { inbound: 'hold', state: 'unreachable' });
  const r = await h.tool(a, 'bridge_send', { conversation_id: cid, body: 'x' });
  assert.equal(r.status, 'queued'); assert.equal(r.reason, 'recipient_unreachable');
  const r2 = await h.tool(b, 'bridge_start_conversation', { peer: a.address, topic: 't', first_message: 'x' }); void r2;
  const c = h.engine.registerLocal({ name: 'carol' });
  const s = await h.tool(c, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' });
  assert.equal((await h.tool(c, 'bridge_confirm', s.approval)).reason, 'recipient_unreachable');
  h.engine.stop();
});

test('§11.4: list_conversations returns own conversations only; transcripts for participants only', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' }); const e = h.engine.registerLocal({ name: 'eve' });
  const cid = await openConversation(h, a, b);
  await h.tool(b, 'bridge_send', { conversation_id: cid, body: 'secret plan' });
  assert.equal((await h.tool(e, 'bridge_list_conversations', {})).data instanceof Array && ((await h.tool(e, 'bridge_list_conversations', {})).data as unknown[]).length, 0);
  const mine = (await h.tool(a, 'bridge_list_conversations', {})).data as Array<{ id: string; peer: string; initiator: boolean }>;
  assert.deepEqual(mine.map((x) => [x.id, x.peer, x.initiator]), [[cid, 'fake:bob', true]]);
  assert.equal((await h.tool(e, 'bridge_get_transcript', { conversation_id: cid })).reason, 'not_participant');
  const t = await h.tool(a, 'bridge_get_transcript', { conversation_id: cid });
  assert.deepEqual((t.data as { messages: Array<{ body: string }> }).messages.map((m) => m.body), ['hello', 'secret plan']);
  const page = await h.tool(a, 'bridge_get_transcript', { conversation_id: cid, before_seq: 2, limit: 1 });
  assert.deepEqual((page.data as { messages: Array<{ body: string }> }).messages.map((m) => m.body), ['hello']);
  const agents = (await h.tool(e, 'bridge_list_agents', {})).data as Array<{ address: string }>;
  assert.deepEqual(agents.map((x) => x.address).sort(), ['fake:alice', 'fake:bob']);
  h.engine.stop();
});

test('§16: invalid and oversized input', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  assert.equal((await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x'.repeat(33 * 1024) })).reason, 'too_large');
  assert.equal((await h.tool(a, 'bridge_start_conversation', { peer: 'bob', topic: 't', first_message: 'x' })).reason, 'invalid_message');
  assert.equal((await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: '​‮', first_message: 'x' })).reason, 'invalid_message');
  assert.equal((await h.tool(a, 'bridge_nope', {})).reason, 'invalid_message');
  assert.equal((await h.tool(a, 'bridge_send', { conversation_id: '01JD0000000000000000000000', body: 'x' })).reason, 'unknown_conversation');
  // topics are sanitised before they become approval facts
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 'a\nb‮  c\u001b[31m', first_message: 'x' });
  assert.equal(r.approval!.topic, 'a b c');
  h.engine.stop();
});

test('§9.3: tampered policy stops conversation activity (starts, confirms, deliveries) and pops up', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const cid = await openConversation(h, a, b);
  h.store.db.run(`UPDATE policy SET value = '{"allow_bypass_sessions":true}' WHERE key = 'delivery'`);
  const h2 = await h.restart();
  const a2 = h2.engine.registerLocal({ name: 'alice', id: a.participant_id });
  h2.engine.registerLocal({ name: 'bob', id: b.participant_id });
  assert.ok(h2.notifier.popups.some((p) => /config verify/.test(p.body)));
  assert.equal((await h2.tool(a2, 'bridge_send', { conversation_id: cid, body: 'x' })).reason, 'policy_tampered');
  assert.equal((await h2.tool(a2, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' })).reason, 'policy_tampered');
  assert.equal((await h2.tool(a2, 'bridge_list_conversations', {})).status, 'delivered');
  await h2.policy.restoreLastVerified(); h2.engine.resumeAfterVerify();
  assert.equal((await h2.tool(a2, 'bridge_send', { conversation_id: cid, body: 'back' })).status, 'delivered');
  h2.engine.stop();
});

test('review: re-registration re-issues a pending invite bound to the old epoch', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice' }); const b = h.engine.registerLocal({ name: 'bob' });
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 't', first_message: 'x' });
  await h.tool(a, 'bridge_confirm', r.approval); await h.idle();
  const old = lastInvite(h, b.participant_id);
  const b2 = h.engine.registerLocal({ name: 'bob', id: b.participant_id }); await h.idle();
  const fresh = lastInvite(h, b.participant_id);
  assert.notEqual(fresh.approval_id, old.approval_id);
  assert.equal((await h.tool(b2, 'bridge_confirm', old)).reason, 'unknown_approval');
  assert.equal((await h.tool(b2, 'bridge_confirm', fresh)).status, 'delivered');
  h.engine.stop();
});
