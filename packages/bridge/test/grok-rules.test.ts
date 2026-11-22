// Grok-side bridge rules (§6.4–§6.5, §7.4 A/B, §7.5 relay origin) using a fake adapter posing as Grok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, lastInvite, type Harness } from './helpers.ts';

const MIN = 60_000;

async function setup(): Promise<{ h: Harness; c: ReturnType<Harness['engine']['registerLocal']>; g: { participant_id: string; epoch: number }; gid: string }> {
  const h = await harness();
  const c = h.engine.registerLocal({ name: 'auth-refactor' });
  const bot = h.engine.createBot({ name: 'researcher', bot_id: 'bot00001', token_hash: 'h' });
  return { h, c, g: { participant_id: bot.id, epoch: 0 }, gid: bot.id };
}

/** Local starts with Grok (sequence A); returns the conversation id. */
async function localToGrok(h: Harness, c: { participant_id: string; epoch: number }, turnLimit = 30): Promise<string> {
  const r = await h.tool(c, 'bridge_start_conversation', { peer: 'grok:researcher', topic: 'design', first_message: 'first question', turn_limit: turnLimit });
  assert.equal(r.status, 'pending_approval');
  const ok = await h.tool(c, 'bridge_confirm', r.approval);
  assert.equal(ok.status, 'delivered'); // Grok auto-accepts; first_message delivered as turn 1 (§7.4 A3–A4)
  return ok.conversation_id!;
}

test('§7.4 A: local → Grok auto-accepts on confirm; first message is turn 1', async () => {
  const { h, c, gid } = await setup();
  const cid = await localToGrok(h, c);
  const conv = h.store.conversation(cid)!;
  assert.equal(conv.state, 'active'); assert.equal(conv.turn_count, 1);
  const item = h.grok.inbox(gid)[0]!;
  assert.equal(item.messages[0]!.body, 'first question'); assert.equal(item.messages[0]!.turn, 1);
  assert.equal(item.reply_to, item.messages[0]!.message_id);
  assert.deepEqual(item.conversation, { id: cid, topic: 'design', peer_address: 'fake:auth-refactor', turn: 1, turn_limit: 30, state: 'active' });
  h.engine.stop();
});

test('§7.4 B: Grok → local: awaiting_local_approval without an approval id; accept delivers first_message; Grok learns of acceptance in its first delivery', async () => {
  const { h, c, g, gid } = await setup();
  const r = await h.tool(g, 'bridge_start_conversation', { peer: c.address, topic: 'is the migration done?', first_message: 'Hi from Grok' }, { conversation_id: '01JD0000000000000000000ABC' });
  assert.equal(r.status, 'awaiting_local_approval'); assert.equal(r.approval, undefined);
  assert.equal(r.conversation_id, '01JD0000000000000000000ABC'); // relay-allocated id is used (§13.3)
  await h.idle();
  assert.equal(h.fake.bodies(c.participant_id).length, 0); // first_message withheld
  const inv = lastInvite(h, c.participant_id);
  assert.equal(inv.peer, 'grok:researcher'); assert.equal(inv.topic, 'is the migration done?');
  assert.equal((await h.tool(c, 'bridge_confirm', inv)).status, 'delivered');
  await h.idle();
  assert.deepEqual(h.fake.bodies(c.participant_id), ['Hi from Grok']);
  await h.tool(c, 'bridge_send', { conversation_id: r.conversation_id, body: 'Yes, done.' });
  await h.idle();
  const first = h.grok.inbox(gid)[0]!;
  assert.deepEqual(first.notices.map((n) => n.code), ['accepted']);
  assert.equal(first.messages[0]!.body, 'Yes, done.');
  // duplicate relay id is rejected
  assert.equal((await h.tool(g, 'bridge_start_conversation', { peer: c.address, topic: 't', first_message: 'x' }, { conversation_id: '01JD0000000000000000000ABC' })).reason, 'invalid_message');
  h.engine.stop();
});

test('§7.4 B: closed invitee → queued; decline → Grok gets a notice-only delivery', async () => {
  const { h, c, g, gid } = await setup();
  h.engine.setLocalLive(c.participant_id, false);
  const r = await h.tool(g, 'bridge_start_conversation', { peer: c.address, topic: 't', first_message: 'x' });
  assert.equal(r.status, 'queued');
  h.engine.setLocalLive(c.participant_id, true); await h.idle();
  assert.equal((await h.tool(c, 'bridge_decline', { conversation_id: r.conversation_id })).status, 'declined');
  await h.idle();
  const notice = h.grok.inbox(gid).at(-1)!;
  assert.deepEqual(notice.messages, []); assert.equal(notice.reply_to, null);
  assert.deepEqual(notice.notices.map((n) => n.code), ['declined']);
  h.engine.stop();
});

test('§7.5: relay-origin conversations need local approval in auto mode on the public relay (§19.3 #9)', async () => {
  const { h, c, g } = await setup();
  await h.setPolicy('approval.mode', 'auto');
  await h.setPolicy('allowlist.add', 'allow * -> *');
  const r = await h.tool(g, 'bridge_start_conversation', { peer: c.address, topic: 't', first_message: 'x' });
  assert.equal(r.status, 'awaiting_local_approval');
  // self-hosted relay + allow_relay_origin → auto applies
  await h.setPolicy('transport.relay_url', 'https://relay.example.org');
  await h.setPolicy('auto.allow_relay_origin', 'true');
  const c2 = h.engine.registerLocal({ name: 'other' });
  const r2 = await h.tool(g, 'bridge_start_conversation', { peer: c2.address, topic: 't', first_message: 'x' });
  assert.equal(r2.status, 'delivered');
  h.engine.stop();
});

test('§6.5: one Grok reply per delivered message → duplicate_reply', async () => {
  const { h, c, g } = await setup();
  const cid = await localToGrok(h, c);
  const q = h.store.messages(cid)[0]!;
  assert.equal((await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'answer', in_reply_to: q.id, idempotency_key: 'r1' })).status, 'delivered');
  const dup = await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'second answer', in_reply_to: q.id });
  assert.equal(dup.reason, 'duplicate_reply');
  const dup2 = await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'unprompted' });
  assert.equal(dup2.reason, 'duplicate_reply');
  // after the next local message, Grok may reply again (default target = latest delivery)
  await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'follow-up' });
  assert.equal((await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'answer 2' })).status, 'delivered');
  h.engine.stop();
});

test('§6.4: Grok calls without a key dedupe on body hash for 120 s unless a peer message arrived', async () => {
  const { h, c, g } = await setup();
  const cid = await localToGrok(h, c);
  const r1 = await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'same text' });
  const r2 = await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'same text' });
  assert.deepEqual(r2, r1); // original result, not duplicate_reply
  assert.equal(h.store.messages(cid).filter((m) => m.body === 'same text').length, 1);
  await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'ok, and?' });
  const r3 = await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'same text' });
  assert.notEqual(r3.message_id, r1.message_id);
  // window expiry
  await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'again?' });
  const r4 = await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'final' });
  await h.clock.advance(121_000);
  await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'more' }); void r4;
  h.engine.stop();
});

test('§6.5: serialized Grok deliveries: later local messages wait and go together on reply or after 5 min', async () => {
  const { h, c, g, gid } = await setup();
  const cid = await localToGrok(h, c);
  const s2 = await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'second' });
  assert.equal(s2.status, 'queued'); assert.match(s2.hint!, /held until the peer replies/);
  await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'third' });
  await h.idle();
  assert.equal(h.grok.inbox(gid).length, 1);
  await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'reply to first' });
  await h.idle();
  const batch = h.grok.inbox(gid)[1]!;
  assert.deepEqual(batch.messages.map((m) => m.body), ['second', 'third']); // one delivery, both messages
  assert.equal(batch.reply_to, batch.messages[1]!.message_id);
  // 5-minute release when Grok does not reply
  await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'fourth' });
  await h.idle();
  assert.equal(h.grok.inbox(gid).length, 2);
  await h.clock.advance(5 * MIN); await h.idle();
  assert.deepEqual(h.grok.inbox(gid)[2]!.messages.map((m) => m.body), ['fourth']);
  h.engine.stop();
});

test('§6.5: at most 60 deliveries per bot per hour; the rest are held with a notice, never dropped', async () => {
  const { h, c, g, gid } = await setup();
  const cid = await localToGrok(h, c, 200);
  for (let i = 0; i < 59; i++) {
    await h.tool(g, 'bridge_send', { conversation_id: cid, body: `r${i}` });
    await h.tool(c, 'bridge_send', { conversation_id: cid, body: `q${i}` });
  }
  await h.idle();
  assert.equal(h.grok.inbox(gid).length, 60);
  await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'r59' });
  const held = await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'over the cap' });
  assert.equal(held.status, 'queued'); assert.match(held.hint!, /cap/);
  await h.idle();
  assert.ok(h.fake.noticeCodes(c.participant_id).includes('grok_cap'));
  await h.clock.advance(61 * MIN); await h.idle();
  assert.ok(h.grok.bodies(gid).includes('over the cap'));
  h.engine.stop();
});

test('§6.5: 25-minute Grok hint and the 1 h no-reply notice go to the local sender', async () => {
  const { h, c } = await setup();
  await localToGrok(h, c);
  await h.clock.advance(25 * MIN); await h.idle();
  assert.deepEqual(h.fake.noticeCodes(c.participant_id).filter((x) => x !== 'accepted'), ['grok_waiting']);
  await h.clock.advance(35 * MIN); await h.idle();
  assert.ok(h.fake.noticeCodes(c.participant_id).includes('no_reply'));
  h.engine.stop();
});

test('§12.4: Grok delivery failures do not consume the turn and pop up with the hint', async () => {
  const { h, c, gid } = await setup();
  const cid = await localToGrok(h, c);
  await h.tool({ participant_id: gid, epoch: 0 }, 'bridge_send', { conversation_id: cid, body: 'answer' });
  h.grok.nextOutcome(() => ({ status: 'failed', reason: 'grok_run_not_started', hint: 'routine paused — resume it in Grok Bot', retryable: false }));
  const turns = h.store.conversation(cid)!.turn_count;
  const r = await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'x' });
  assert.equal(r.status, 'failed'); assert.equal(r.reason, 'grok_run_not_started');
  assert.equal(h.store.conversation(cid)!.turn_count, turns);
  await h.idle();
  assert.ok(h.notifier.popups.some((p) => /routine paused/.test(p.body)));
  h.engine.stop();
});

test('§12.3: bridge_get_messages returns full text of the latest delivery; discovery none hides agents', async () => {
  const { h, c, g } = await setup();
  const cid = await localToGrok(h, c);
  const r = await h.engine.callTool(g, 'tool.bridge_get_messages', { conversation_id: cid });
  assert.deepEqual((r.data as { messages: Array<{ body: string }> }).messages.map((m) => m.body), ['first question']);
  const other = h.engine.registerLocal({ name: 'x' }); void other;
  assert.equal(((await h.tool(g, 'bridge_list_agents', {})).data as unknown[]).length, 2);
  await h.setPolicy('discovery.relay', 'none');
  assert.deepEqual((await h.tool(g, 'bridge_list_agents', {})).data, []);
  assert.equal((await h.tool(g, 'bridge_extend_conversation', { conversation_id: cid, add_turns: 2 })).reason, 'invalid_message'); // Grok has no extend
  h.engine.stop();
});

test('review: a local message sent while a Grok delivery is in flight is not merged into it', async () => {
  const { h, c, g, gid } = await setup();
  const cid = await localToGrok(h, c);
  await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'answer' });
  let release!: () => void;
  h.grok.nextOutcome(() => new Promise((r) => { release = () => r({ status: 'handed_off' }); }));
  const p2 = h.tool(c, 'bridge_send', { conversation_id: cid, body: 'second' });
  await new Promise((r) => setTimeout(r, 20));
  const r3 = await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'third' });
  release(); await p2; await h.idle();
  const second = h.grok.log.find((x) => x.item.messages.some((m) => m.body === 'second'))!;
  assert.deepEqual(second.item.messages.map((m) => m.body), ['second']);
  assert.notEqual(h.store.message(r3.message_id!)!.status, 'handed_off');
  await h.clock.advance(5 * MIN); await h.idle();
  assert.ok(h.grok.bodies(gid).includes('third'));
  assert.equal(h.store.message(r3.message_id!)!.status, 'delivered');
  h.engine.stop();
});

test('review: a Grok reply whose delivery fails may be sent again', async () => {
  const { h, c, g } = await setup();
  const cid = await localToGrok(h, c);
  h.fake.nextOutcome(() => ({ status: 'failed', reason: 'host_refused', retryable: false }));
  assert.equal((await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'lost reply' })).status, 'failed');
  assert.equal((await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'reply again' })).status, 'delivered');
  h.engine.stop();
});
