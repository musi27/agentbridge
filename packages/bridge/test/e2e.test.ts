import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, openConversation, lastInvite } from './helpers.ts';

test('e2e: start → confirm → accept → messages → turn limit → end summary', async () => {
  const h = await harness();
  const a = h.engine.registerLocal({ name: 'alice', cwd: '/w/alice' });
  const b = h.engine.registerLocal({ name: 'bob', cwd: '/w/bob' });
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: 'migration plan', first_message: 'Is the migration done?', turn_limit: 4 });
  assert.equal(r.status, 'pending_approval');
  assert.deepEqual({ ...r.approval, approval_id: 'x' }, { approval_id: 'x', kind: 'start', peer: 'fake:bob', direction: 'outgoing', topic: 'migration plan', turn_limit: 4 });
  const c = await h.tool(a, 'bridge_confirm', r.approval);
  assert.equal(c.status, 'awaiting_local_approval');
  await h.idle();
  const inv = lastInvite(h, b.participant_id);
  assert.equal(inv.peer, 'fake:alice'); assert.equal(inv.topic, 'migration plan');
  assert.deepEqual(h.fake.bodies(b.participant_id), []); // first_message withheld until accept
  const acc = await h.tool(b, 'bridge_confirm', inv);
  assert.equal(acc.status, 'delivered'); assert.equal(acc.conversation_id, c.conversation_id);
  await h.idle();
  assert.deepEqual(h.fake.bodies(b.participant_id), ['Is the migration done?']);
  const cid = c.conversation_id!;
  assert.equal((await h.tool(b, 'bridge_send', { conversation_id: cid, body: 'Almost.' })).status, 'delivered');
  assert.equal((await h.tool(a, 'bridge_send', { conversation_id: cid, body: 'What is left?' })).status, 'delivered');
  const last = await h.tool(b, 'bridge_send', { conversation_id: cid, body: 'Only the index.' });
  assert.equal(last.status, 'delivered'); // the message that reaches the limit is delivered
  await h.idle();
  const conv = h.store.conversation(cid)!;
  assert.equal(conv.state, 'ended'); assert.equal(conv.end_reason, 'turn_limit'); assert.equal(conv.turn_count, 4);
  assert.ok(h.fake.noticeCodes(a.participant_id).includes('ended'));
  assert.ok(h.fake.noticeCodes(b.participant_id).includes('ended'));
  const late = await h.tool(a, 'bridge_send', { conversation_id: cid, body: 'one more' });
  assert.equal(late.reason, 'conversation_ended');
  h.engine.stop();
});
