// Grok tool handlers as the relay delivers them (§12.3, §13.3): caller identity + token re-verification, tool and
// parameter whitelists, one-reply rule, body-hash dedup, paging under the relay result budget, held rejections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, ulid } from '@agentbridge/protocol';
import { harness, lastInvite, type Harness } from './helpers.ts';
import { RelayLink } from '../src/relay/link.ts';
import { ENDPOINT, FakeTransport, addBot, errorOf, relayCall, result } from './grok-helpers.ts';

async function setup(o: { resultBytes?: number } = {}) {
  const h = await harness();
  const transport = new FakeTransport();
  const link = new RelayLink({ engine: h.engine, transport, endpoint: ENDPOINT, ...(o.resultBytes ? { resultBytes: o.resultBytes } : {}) });
  const c = h.engine.registerLocal({ name: 'auth-refactor' });
  const bot = addBot(h.engine, 'researcher', 'bot00000000000a1');
  return { h, transport, link, c, bot };
}

/** Local starts with the bot; returns the conversation id after the first delivery. */
async function localToGrok(h: Harness, c: { participant_id: string; epoch: number }, peer = 'grok:researcher', first = 'first question'): Promise<string> {
  const r = await h.tool(c, 'bridge_start_conversation', { peer, topic: 'design', first_message: first, turn_limit: 50 });
  const ok = await h.tool(c, 'bridge_confirm', r.approval);
  assert.equal(ok.status, 'delivered');
  await h.idle();
  return ok.conversation_id!;
}

test('§13.3 caller identity: the relay caller bot id plus the token re-verified against the bridge copy', async () => {
  const { h, link, transport, bot } = await setup();
  assert.equal(result(await relayCall(link, bot, 'bridge_list_conversations', {}))['status'], 'delivered');
  const wrong = errorOf(await relayCall(link, bot, 'bridge_list_conversations', {}, { token: 'stolen' }));
  assert.equal(wrong.code, 'not_participant'); assert.match(wrong.message, /token/);
  assert.equal(errorOf(await relayCall(link, bot, 'bridge_list_conversations', {}, { caller: 'zzzzzzzzzzzz' })).code, 'not_participant');
  // another bot's token does not work for this bot id
  const other = addBot(h.engine, 'second', 'bot00000000000b2');
  assert.equal(errorOf(await relayCall(link, bot, 'bridge_list_conversations', {}, { token: other.token })).code, 'not_participant');
  // rotation: old token refused at once, new one accepted
  h.engine.rotateBotToken(bot.botId, (await import('@agentbridge/adapter-grok')).botTokenHash('new-token'));
  assert.equal(errorOf(await relayCall(link, bot, 'bridge_list_conversations', {})).code, 'not_participant');
  assert.equal(result(await relayCall(link, { ...bot, token: 'new-token' }, 'bridge_list_conversations', {}))['status'], 'delivered');
  // revoked bots and removed participants are refused
  h.store.updateBot(other.botId, { revoked_at: 1 });
  assert.equal(errorOf(await relayCall(link, other, 'bridge_list_conversations', {})).code, 'not_participant');
  assert.ok(h.store.events({ type: 'relay_call_rejected' }).length >= 3);
  assert.equal(transport.active, 7); // markActive on every call from Grok (§13.2)
  h.engine.stop();
});

test('§12.3 tool whitelist: Grok cannot confirm, decline, cancel or extend; unknown parameters are dropped', async () => {
  const { h, link, c, bot } = await setup();
  const cid = await localToGrok(h, c);
  for (const m of ['bridge_confirm', 'bridge_decline', 'bridge_cancel', 'bridge_extend_conversation', 'tool.bridge_send', 'whatever']) {
    assert.equal(errorOf(await relayCall(link, bot, m, { conversation_id: cid })).code, 'invalid_message', m);
  }
  // reply_expected is not a Grok parameter: a Grok reply always expects an answer
  const r = result(await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'answer', reply_expected: false }));
  assert.equal(r['status'], 'delivered');
  assert.equal(h.store.message(r['message_id'] as string)!.reply_expected, 1);
  // `continues` is not a Grok start parameter
  const ended = await localToGrok(h, c, 'grok:researcher', 'other');
  h.engine.endManual(ended);
  const s = result(await relayCall(link, bot, 'bridge_start_conversation', { peer: c.address, topic: 't', first_message: 'x', continues: ended, conversation_id: ulid() }));
  assert.equal(s['status'], 'awaiting_local_approval');
  assert.equal(h.store.conversation(s['conversation_id'] as string)!.continues, null);
  h.engine.stop();
});

test('§12.3 bridge_list_agents respects discovery.relay', async () => {
  const { h, link, bot } = await setup();
  const list = result<{ data: Array<{ address: string; folder?: string }> }>(await relayCall(link, bot, 'bridge_list_agents', {}));
  assert.deepEqual(list.data.map((x) => x.address), ['fake:auth-refactor']);
  assert.ok(list.data.every((x) => x.folder === undefined)); // addresses and states only
  await h.setPolicy('discovery.relay', 'none');
  assert.deepEqual(result<{ data: unknown[] }>(await relayCall(link, bot, 'bridge_list_agents', {})).data, []);
  h.engine.stop();
});

test('§12.3 bridge_start_conversation uses the relay-allocated id: awaiting_local_approval, or queued when closed', async () => {
  const { h, link, c, bot } = await setup();
  const id = ulid();
  const r = result(await relayCall(link, bot, 'bridge_start_conversation', { peer: c.address, topic: 'migration', first_message: 'Is it done?', conversation_id: id }));
  assert.deepEqual([r['status'], r['conversation_id']], ['awaiting_local_approval', id]);
  assert.equal(h.store.conversation(id)!.origin, 'relay');
  await h.idle();
  assert.equal(lastInvite(h, c.participant_id).peer, 'grok:researcher');
  // a duplicate relay id is rejected
  assert.equal(errorOf(await relayCall(link, bot, 'bridge_start_conversation', { peer: c.address, topic: 'x', first_message: 'y', conversation_id: id })).code, 'invalid_message');
  // closed invitee → queued
  const d = h.engine.registerLocal({ name: 'docs' }); h.engine.setLocalLive(d.participant_id, false);
  const q = result(await relayCall(link, bot, 'bridge_start_conversation', { peer: d.address, topic: 'x', first_message: 'y', conversation_id: ulid() }));
  assert.equal(q['status'], 'queued');
  // unknown peer → failure text for the model
  const gone = errorOf(await relayCall(link, bot, 'bridge_start_conversation', { peer: 'claude:nobody', topic: 'x', first_message: 'y', conversation_id: ulid() }));
  assert.equal(gone.code, 'recipient_gone'); assert.match(gone.message, /bridge_list_agents/);
  h.engine.stop();
});

test('§6.5 bridge_send: one reply per delivered message → duplicate_reply with an instruction not to reply again', async () => {
  const { h, link, c, bot } = await setup();
  const cid = await localToGrok(h, c);
  const q = h.store.messages(cid)[0]!;
  assert.equal(result(await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'answer', in_reply_to: q.id, idempotency_key: 'k1' }))['status'], 'delivered');
  const dup = errorOf(await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'another answer', in_reply_to: q.id }));
  assert.equal(dup.code, 'duplicate_reply'); assert.match(dup.message, /Do not reply again/);
  // the same idempotency key returns the original result, not duplicate_reply
  const again = result(await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'answer', in_reply_to: q.id, idempotency_key: 'k1' }));
  assert.equal(again['status'], 'delivered');
  h.engine.stop();
});

test('§6.4 bridge_send without a key: body-hash dedup within 120 s unless a peer message arrived', async () => {
  const { h, link, c, bot } = await setup();
  const cid = await localToGrok(h, c);
  const r1 = result(await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'same text' }));
  const r2 = result(await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'same text' })); // a retried run
  assert.deepEqual(r2, r1);
  assert.equal(h.store.messages(cid).filter((m) => m.body === 'same text').length, 1);
  await h.clock.advance(121_000);
  assert.equal(errorOf(await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'same text' })).code, 'duplicate_reply'); // window over: the one-reply rule applies
  await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'next question' }); await h.idle();
  const r3 = result(await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'same text' }));
  assert.notEqual(r3['message_id'], r1['message_id']);
  h.engine.stop();
});

test('§12.3 bridge_get_messages: latest delivery by default, after_seq, paging under the result budget', async () => {
  const { h, link, c, bot } = await setup({ resultBytes: 5 * 1024 });
  const cid = await localToGrok(h, c, 'grok:researcher', 'q1');
  let r = result<{ data: { messages: Array<{ body: string; seq: number }>; next_after_seq: number | null } }>(await relayCall(link, bot, 'bridge_get_messages', { conversation_id: cid }));
  assert.deepEqual(r.data.messages.map((m) => m.body), ['q1']); assert.equal(r.data.next_after_seq, null);
  await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'a1' });
  // long local messages: 1 goes alone; 2 and 3 are serialized into one delivery after Grok's next reply (§6.5)
  const big = (n: number) => `${n}:${'x'.repeat(3000)}`;
  for (const n of [1, 2, 3]) await h.tool(c, 'bridge_send', { conversation_id: cid, body: big(n) });
  await h.idle();
  await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'a2' }); await h.idle();
  r = result(await relayCall(link, bot, 'bridge_get_messages', { conversation_id: cid }));
  assert.deepEqual(r.data.messages.map((m) => m.body.slice(0, 2)), ['2:']); // 5 KiB budget: one 3 KB message per page
  assert.ok(r.data.next_after_seq !== null);
  const page2 = result<{ data: { messages: Array<{ body: string }>; next_after_seq: number | null } }>(await relayCall(link, bot, 'bridge_get_messages', { conversation_id: cid, after_seq: r.data.next_after_seq }));
  assert.deepEqual(page2.data.messages.map((m) => m.body.slice(0, 2)), ['3:', 'a2']); assert.equal(page2.data.next_after_seq, null); // own messages are included
  // after_seq 0 returns everything visible, oldest first, own messages included
  const all = result<{ data: { messages: Array<{ body: string }> } }>(await relayCall(link, { ...bot }, 'bridge_get_messages', { conversation_id: cid, after_seq: 0 }));
  assert.deepEqual(all.data.messages.slice(0, 2).map((m) => m.body), ['q1', 'a1']);
  // a notice-only delivery does not change the default (regression: it used to return the whole conversation)
  h.engine.notify(bot.pid, h.store.conversation(cid)!, { id: ulid(), code: 'x', severity: 'info', parts: [], text: 'notice' });
  await h.idle();
  r = result(await relayCall(link, bot, 'bridge_get_messages', { conversation_id: cid }));
  assert.equal(r.data.messages[0]!.body.slice(0, 2), '2:');
  h.engine.stop();
});

test('§12.3 bridge_get_messages hides messages still held for this bot (serialized) until their delivery', async () => {
  const { h, link, c, bot } = await setup();
  const cid = await localToGrok(h, c, 'grok:researcher', 'q1');
  await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'held while Grok has not replied' });
  await h.idle();
  const r = result<{ data: { messages: Array<{ body: string }> } }>(await relayCall(link, bot, 'bridge_get_messages', { conversation_id: cid, after_seq: 0 }));
  assert.deepEqual(r.data.messages.map((m) => m.body), ['q1']);
  h.engine.stop();
});

test('§12.3 not_participant: a bot cannot read, reply to or end another bot\'s or a local-only conversation', async () => {
  const { h, link, c, bot } = await setup();
  const other = addBot(h.engine, 'second', 'bot00000000000c3');
  const cid = await localToGrok(h, c, other.address);
  for (const [m, extra] of [['bridge_get_messages', {}], ['bridge_get_transcript', {}], ['bridge_send', { body: 'hi' }], ['bridge_end_conversation', {}]] as const) {
    const e = errorOf(await relayCall(link, bot, m, { conversation_id: cid, ...extra }));
    assert.equal(e.code, 'not_participant', m);
  }
  assert.deepEqual(result<{ data: unknown[] }>(await relayCall(link, bot, 'bridge_list_conversations', {})).data, []);
  assert.equal(result<{ data: unknown[] }>(await relayCall(link, other, 'bridge_list_conversations', {})).data.length, 1);
  assert.equal(errorOf(await relayCall(link, bot, 'bridge_get_messages', { conversation_id: ulid() })).code, 'unknown_conversation');
  h.engine.stop();
});

test('§12.3 bridge_get_transcript is paged (before_seq, limit) and stays under the relay result budget', async () => {
  const { h, link, c, bot } = await setup({ resultBytes: 16 * 1024 });
  const cid = await localToGrok(h, c, 'grok:researcher', 'm0');
  for (let i = 1; i <= 10; i++) {
    await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: `g${i} ${'y'.repeat(2500)}` });
    await h.tool(c, 'bridge_send', { conversation_id: cid, body: `c${i}` }); await h.idle();
  }
  const p1 = result<{ data: { messages: Array<{ seq: number; body: string }>; next_before_seq: number | null } }>(await relayCall(link, bot, 'bridge_get_transcript', { conversation_id: cid }));
  assert.ok(Buffer.byteLength(JSON.stringify(p1)) <= 16 * 1024);
  assert.equal(p1.data.messages.at(-1)!.body, 'c10'); // newest last
  assert.ok(p1.data.next_before_seq !== null);
  const p2 = result<{ data: { messages: Array<{ seq: number }> } }>(await relayCall(link, bot, 'bridge_get_transcript', { conversation_id: cid, before_seq: p1.data.next_before_seq, limit: 3 }));
  assert.equal(p2.data.messages.length, 3);
  assert.ok(p2.data.messages.every((m) => m.seq < p1.data.next_before_seq!));
  assert.equal(LIMITS.relayResultBytes, 64 * 1024);
  h.engine.stop();
});

test('§12.3 bridge_list_conversations: own only, newest first under the budget; bridge_end_conversation ends it', async () => {
  const { h, link, c, bot } = await setup({ resultBytes: 2 * 1024 });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) { ids.push(await localToGrok(h, c, 'grok:researcher', `q${i}`)); }
  const list = result<{ data: Array<{ id: string }>; hint?: string }>(await relayCall(link, bot, 'bridge_list_conversations', {}));
  assert.ok(list.data.length < 8 && list.data.length > 0); assert.match(list.hint!, /most recent/);
  assert.equal(list.data.at(-1)!.id, ids.at(-1));
  const end = result(await relayCall(link, bot, 'bridge_end_conversation', { conversation_id: ids[0] }));
  assert.equal(end['status'], 'delivered');
  assert.equal(h.store.conversation(ids[0]!)!.end_reason, 'ended_by_participant');
  assert.equal(errorOf(await relayCall(link, bot, 'bridge_end_conversation', { conversation_id: ids[0] })).code, 'conversation_ended');
  h.engine.stop();
});

test('§13.3 a held write the bridge rejects → Grok gets a notice-only delivery', async () => {
  const { h, link, c, bot } = await setup();
  const cid = await localToGrok(h, c);
  h.engine.endManual(cid); await h.idle();
  const before = h.grok.inbox(bot.pid).length;
  const r = await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'late reply' }, { held: true });
  assert.equal(errorOf(r).code, 'conversation_ended');
  await h.idle();
  const n = h.grok.inbox(bot.pid).slice(before).find((i) => i.notices.some((x) => x.code === 'held_rejected'))!;
  assert.ok(n); assert.deepEqual(n.messages, []); assert.equal(n.reply_to, null);
  assert.match(n.notices.find((x) => x.code === 'held_rejected')!.text, /earlier message .* not accepted \(conversation ended\)/);
  // a live (not held) failure is answered directly, no extra notice
  const count = h.grok.inbox(bot.pid).length;
  await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'live' }); await h.idle();
  assert.equal(h.grok.inbox(bot.pid).length, count);
  h.engine.stop();
});

test('RelayLink without a relay: control and ensureConnected report bridge_offline', async () => {
  const h = await harness();
  const link = new RelayLink({ engine: h.engine });
  assert.equal(link.configured, false);
  await assert.rejects(link.control('register_bot', {}), (e: Error & { code?: string }) => e.code === 'bridge_offline');
  link.markActive(); // no-op
  h.engine.stop();
});

// ------------------------------------------------------------------ integrator review of PR #6

test('review C2: Grok cannot reply to, or read in the transcript, a message it was never sent (held for serialization)', async () => {
  const { h, link, c, bot } = await setup();
  const cid = await localToGrok(h, c, 'grok:researcher', 'q1');
  const held = await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'held while Grok has not replied' });
  assert.equal(held.status, 'queued');
  const heldId = held.message_id!;
  const e = errorOf(await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'guessing a reply', in_reply_to: heldId }));
  assert.equal(e.code, 'duplicate_reply');
  const t = result<{ data: { messages: Array<{ message_id: string }> } }>(await relayCall(link, bot, 'bridge_get_transcript', { conversation_id: cid }));
  assert.ok(!t.data.messages.some((m) => m.message_id === heldId));
  // the local side still sees its own held message in its transcript
  const local = await h.tool(c, 'bridge_get_transcript', { conversation_id: cid });
  assert.ok((local.data as { messages: Array<{ message_id: string }> }).messages.some((m) => m.message_id === heldId));
  h.engine.stop();
});

test('review C3: reply awaited — markActive every 5 min until 25 min after hand-off to Grok, then stops', async () => {
  const { h, link, transport, c } = await setup();
  link.startReplyWatch();
  await localToGrok(h, c);
  const base = transport.active;
  await h.clock.advance(5 * 60_000); assert.equal(transport.active, base + 1);
  await h.clock.advance(20 * 60_000); assert.equal(transport.active, base + 5); // ticks at 5, 10, 15, 20, 25 min
  await h.clock.advance(15 * 60_000); assert.equal(transport.active, base + 5); // past the window: no more
  link.stopReplyWatch();
  h.engine.stop();
});

test('review C3: no reply-awaited activity once Grok replied, or for local-only conversations', async () => {
  const { h, link, transport, c, bot } = await setup();
  link.startReplyWatch();
  const cid = await localToGrok(h, c);
  await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'answer', reply_expected: true });
  const base = transport.active;
  await h.clock.advance(30 * 60_000);
  assert.equal(transport.active, base); // now the local side is awaited, not Grok
  link.stopReplyWatch(); h.engine.stop();
});

test('review C4: control() does not mark Grok activity or connect (the client does); ensureConnected passes the grace', async () => {
  const { h, link, transport } = await setup();
  await link.control('set_discovery', { bot_id: 'bot00000000000a1', mode: 'none' });
  assert.equal(transport.active, 0); assert.equal(transport.connects, 0);
  await link.ensureConnected(105_000);
  assert.deepEqual(transport.graces, [105_000]); assert.equal(transport.active, 0);
  transport.failWith = 'at most 32 bots'; transport.failCode = 'rate_limited';
  await assert.rejects(link.control('register_bot', {}), (e: Error & { code?: string }) => e.code === 'rate_limited'); // code kept
  h.engine.stop();
});

test('review C5: a single message larger than the page budget is still returned (one per page, up to the client limit)', async () => {
  const { h, link, c, bot } = await setup();
  // 30 KB of quotes escapes to ~60 KB of JSON; two of them exceed the 64 KiB page
  const big = '"'.repeat(30_000);
  const cid = await localToGrok(h, c, 'grok:researcher', big);
  const r = await relayCall(link, bot, 'bridge_get_messages', { conversation_id: cid });
  assert.equal(result<{ data: { messages: Array<{ body: string }> } }>(r).data.messages[0]!.body, big);
  const r2 = await relayCall(link, bot, 'bridge_get_transcript', { conversation_id: cid });
  assert.equal(result<{ data: { messages: unknown[] } }>(r2).data.messages.length, 1);
  h.engine.stop();
});

test('review C6: a held write rejected as duplicate_reply sends no notice-only delivery', async () => {
  const { h, link, c, bot } = await setup();
  const cid = await localToGrok(h, c);
  await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'first reply' });
  await h.idle();
  const before = h.grok.inbox(bot.pid).length;
  assert.equal(errorOf(await relayCall(link, bot, 'bridge_send', { conversation_id: cid, body: 'second reply' }, { held: true })).code, 'duplicate_reply');
  await h.idle();
  assert.equal(h.grok.inbox(bot.pid).length, before);
  h.engine.stop();
});
