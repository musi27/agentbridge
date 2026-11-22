// The real Grok adapter inside the bridge pipeline (§12.4, §6.5): packing integration, retries 2 s/10 s/30 s with the
// same payload (fake timers), terminal webhook answers, the adapter cap backstop, the 25-minute hint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELIVERY_END, LIMITS, SECRET_NAMES, type DeliveryPayload } from '@agentbridge/protocol';
import { GrokAdapter } from '@agentbridge/adapter-grok';
import { FakeAdapter } from '@agentbridge/adapter-fake';
import { harness, type Harness } from './helpers.ts';
import { FakeClock } from '../src/clock.ts';
import { openDatabase } from '../src/db/db.ts';
import { Store } from '../src/db/store.ts';
import { MemorySecretStore } from '../src/policy/integrity.ts';
import { addBot } from './grok-helpers.ts';

const MIN = 60_000;
interface Post { at: number; body: string; auth: string | null }

async function setup(answer: (n: number, body: string) => Response | Error, o: { perHourCap?: number } = {}) {
  const posts: Post[] = [];
  const clock = new FakeClock(); const store = new Store(openDatabase(':memory:')); const secrets = new MemorySecretStore(); const fake = new FakeAdapter();
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    posts.push({ at: clock.now(), body, auth: (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? null });
    const a = answer(posts.length, body);
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
  const grok = new GrokAdapter({ secrets, botIdFor: (r) => store.participant(r.participant_id)?.bot_id ?? null, fetch: fetchImpl, now: () => clock.now(), ...(o.perHourCap ? { perHourCap: o.perHourCap } : {}) });
  const h = await harness({ clock, store, secrets, fake, adapters: { fake, grok } });
  const c = h.engine.registerLocal({ name: 'auth-refactor' });
  const bot = addBot(h.engine, 'researcher', 'bot00000000000d4');
  await secrets.set(SECRET_NAMES.webhookUrl(bot.botId), 'https://api2.cursor.sh/hook/1');
  await secrets.set(SECRET_NAMES.webhookKey(bot.botId), 'key-1');
  return { h, c, bot, posts, fake, grok };
}

const ok = (): Response => new Response('{"success":true,"runUuid":"run-x"}', { status: 200 });

async function start(h: Harness, c: { participant_id: string; epoch: number }, first: string) {
  const r = await h.tool(c, 'bridge_start_conversation', { peer: 'grok:researcher', topic: 'design', first_message: first });
  return h.tool(c, 'bridge_confirm', r.approval);
}

test('§12.4 packing integration: the bridge item reaches the webhook as thin JSON ≤ 3,500 chars, end last, bearer key', async () => {
  const { h, c, posts } = await setup(ok);
  const r = await start(h, c, `long ${'é'.repeat(6000)}`);
  assert.equal(r.status, 'handed_off');
  const p = JSON.parse(posts[0]!.body) as DeliveryPayload;
  assert.ok(posts[0]!.body.length <= LIMITS.grokDeliveryChars && Buffer.byteLength(posts[0]!.body) <= LIMITS.grokDeliveryChars);
  assert.equal(Object.keys(p).at(-1), 'end'); assert.equal(p.end, DELIVERY_END);
  assert.equal(p.truncated, true); assert.equal(p.messages[0]!.body, undefined); assert.ok(p.messages[0]!.preview!.length <= 300);
  assert.equal(p.messages[0]!.length, 6005);
  assert.equal(p.reply_to, p.messages[0]!.message_id);
  assert.equal(p.conversation.peer, 'fake:auth-refactor'); assert.equal(p.conversation.turns_left, 29);
  assert.equal(posts[0]!.auth, 'Bearer key-1');
  assert.equal(h.store.deliveriesOf(r.conversation_id!)[0]!.run_uuid, 'run-x'); // runUuid stored on the delivery row
  h.engine.stop();
});

test('§12.4 network/5xx: retried at 2 s, 10 s, 30 s with the identical payload, then failed(grok_run_not_started)', async () => {
  const { h, c, posts, fake } = await setup((n) => (n % 2 ? new Error('ECONNRESET') : new Response('bad gateway', { status: 502 })));
  const r = await start(h, c, 'hello');
  assert.equal(r.status, 'queued'); // the tool call does not wait for the whole backoff
  const t0 = posts[0]!.at;
  await h.clock.advance(2_000); await h.idle();
  await h.clock.advance(10_000); await h.idle();
  await h.clock.advance(30_000); await h.idle();
  assert.deepEqual(posts.map((p) => p.at - t0), [0, 2_000, 12_000, 42_000]);
  assert.equal(new Set(posts.map((p) => p.body)).size, 1); // same payload ids, same JSON
  const d = h.store.deliveriesOf(r.conversation_id!)[0]!;
  assert.deepEqual([d.state, d.reason], ['failed', 'grok_run_not_started']);
  await h.idle();
  assert.ok(fake.noticeCodes(c.participant_id).includes('delivery_failed'));
  assert.ok(h.notifier.popups.some((p) => /server error/.test(p.body)));
  await h.clock.advance(60 * MIN); await h.idle();
  assert.equal(posts.length, 4); // no more attempts
  h.engine.stop();
});

test('§12.4 a retry that succeeds hands off; 400 "is disabled" and 401 fail at once with their hints', async () => {
  const a = await setup((n) => (n === 1 ? new Response('', { status: 503 }) : ok()));
  const r = await start(a.h, a.c, 'hi');
  await a.h.clock.advance(2_000); await a.h.idle();
  assert.equal(a.h.store.deliveriesOf(r.conversation_id!)[0]!.state, 'handed_off');
  assert.equal(a.posts.length, 2);
  a.h.engine.stop();

  const b = await setup(() => new Response('{"success":false,"error":"Automation 42 is disabled"}', { status: 400 }));
  const rb = await start(b.h, b.c, 'hi');
  assert.deepEqual([rb.status, rb.reason, rb.hint], ['failed', 'grok_run_not_started', 'routine paused — resume it in Grok Bot']);
  assert.equal(b.posts.length, 1);
  b.h.engine.stop();

  const k = await setup(() => new Response('{"code":"error","message":"Invalid API key"}', { status: 401 }));
  const rk = await start(k.h, k.c, 'hi');
  assert.equal(rk.hint, 'routine deleted or webhook key changed — run `agentbridge add grok` again');
  await k.h.idle();
  assert.ok(k.h.notifier.popups.some((p) => /webhook key changed/.test(p.body)));
  assert.equal(k.h.store.conversation(rk.conversation_id!)!.turn_count, 0); // no turn consumed
  k.h.engine.stop();
});

test('§6.5 adapter cap backstop: queued/rate_limited holds as cap with a notice; sent once the hour has passed', async () => {
  const { h, c, bot, posts, fake } = await setup(ok, { perHourCap: 1 });
  const r = await start(h, c, 'one');
  assert.equal(r.status, 'handed_off');
  const cid = r.conversation_id!;
  await h.tool({ participant_id: bot.pid, epoch: 0 }, 'bridge_send', { conversation_id: cid, body: 'reply' });
  const held = await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'two' });
  assert.equal(held.status, 'queued');
  await h.idle();
  assert.equal(posts.length, 1);
  const d = h.store.pendingDeliveries(bot.pid)[0]!;
  assert.deepEqual([d.hold, d.reason], ['cap', 'rate_limited']);
  assert.ok(fake.noticeCodes(c.participant_id).includes('grok_cap'));
  await h.clock.advance(30 * MIN); await h.idle();
  assert.equal(posts.length, 1); // still capped, rechecked every minute
  await h.clock.advance(31 * MIN); await h.idle();
  assert.equal(posts.length, 2);
  assert.equal((JSON.parse(posts[1]!.body) as DeliveryPayload).messages[0]!.body, 'two');
  h.engine.stop();
});

test('§6.5 25-minute hint: sent once to the local side when Grok has not replied; not sent if Grok replied; survives a restart', async () => {
  const a = await setup(ok);
  await start(a.h, a.c, 'q');
  await a.h.clock.advance(24 * MIN); await a.h.idle();
  assert.ok(!a.fake.noticeCodes(a.c.participant_id).includes('grok_waiting'));
  await a.h.clock.advance(1 * MIN); await a.h.idle();
  const hint = a.fake.inbox(a.c.participant_id).flatMap((i) => i.notices).filter((n) => n.code === 'grok_waiting');
  assert.equal(hint.length, 1);
  assert.match(hint[0]!.text, /Grok may be waiting on an approval card in your Grok chat/);
  await a.h.clock.advance(60 * MIN); await a.h.idle();
  assert.equal(a.fake.noticeCodes(a.c.participant_id).filter((x) => x === 'grok_waiting').length, 1); // one-time
  a.h.engine.stop();

  const b = await setup(ok);
  const rb = await start(b.h, b.c, 'q');
  await b.h.clock.advance(10 * MIN);
  await b.h.tool({ participant_id: b.bot.pid, epoch: 0 }, 'bridge_send', { conversation_id: rb.conversation_id!, body: 'answer' });
  await b.h.clock.advance(30 * MIN); await b.h.idle();
  assert.ok(!b.fake.noticeCodes(b.c.participant_id).includes('grok_waiting'));
  b.h.engine.stop();

  const c = await setup(ok);
  await start(c.h, c.c, 'q');
  await c.h.clock.advance(10 * MIN);
  const h2 = await c.h.restart(); // timers are recomputed from the DB (waiting_since)
  const local = h2.engine.registerLocal({ name: 'auth-refactor', id: c.c.participant_id });
  await h2.clock.advance(15 * MIN); await h2.idle();
  assert.ok(h2.fake.noticeCodes(local.participant_id).includes('grok_waiting'));
  h2.engine.stop();
});

test('§12.4 ambiguous network error that did start a run: its reply is accepted; the retry\'s run gets duplicate_reply; no 5-min hold', async () => {
  const { h, c, bot, posts, fake } = await setup((n) => (n === 1 ? new Error('socket hang up') : ok()));
  const r = await start(h, c, 'question');
  const cid = r.conversation_id!;
  const q = (JSON.parse(posts[0]!.body) as DeliveryPayload).reply_to!;
  assert.equal(h.store.message(q)!.status, 'queued'); // waiting for the 2 s retry
  // the first POST did start a run after all; it replies with in_reply_to before the retry
  const g = { participant_id: bot.pid, epoch: 0 };
  const reply = await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'answer from run 1', in_reply_to: q });
  assert.equal(reply.status, 'delivered');
  await h.idle();
  assert.deepEqual(fake.bodies(c.participant_id), ['answer from run 1']);
  // without in_reply_to, an unsettled message is not a reply target
  assert.equal((await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'x' })).reason, 'duplicate_reply');
  await h.clock.advance(2_000); await h.idle();
  assert.equal(posts.length, 2); // the retry still goes out (same payload) …
  assert.equal(posts[1]!.body, posts[0]!.body);
  assert.equal((await h.tool(g, 'bridge_send', { conversation_id: cid, body: 'answer from run 2', in_reply_to: q })).reason, 'duplicate_reply'); // … and its run is told it already replied
  // the reply already came, so the next local message is not held for 5 minutes
  const next = await h.tool(c, 'bridge_send', { conversation_id: cid, body: 'next question' });
  assert.equal(next.status, 'handed_off');
  h.engine.stop();
});

test('review C1: a long hold never overflows one delivery — merges stop at 10 messages, every POST packs, nothing fails', async () => {
  const { h, c, bot, posts } = await setup(ok);
  const r = await start(h, c, 'q0');
  const cid = r.conversation_id!;
  for (let i = 1; i <= 25; i++) await h.tool(c, 'bridge_send', { conversation_id: cid, body: `held ${i} ${'w'.repeat(500)}` }); // Grok has not replied
  await h.idle();
  const pending = h.store.pendingDeliveries(bot.pid);
  assert.deepEqual(pending.map((d) => (JSON.parse(d.message_ids) as string[]).length), [10, 10, 5]);
  const g = { participant_id: bot.pid, epoch: 0 };
  for (let k = 0; k < 3; k++) { // Grok replies; each release posts one delivery
    await h.tool(g, 'bridge_send', { conversation_id: cid, body: `reply ${k}` });
    await h.idle();
  }
  assert.equal(posts.length, 4);
  for (const p of posts) assert.ok(p.body.length <= LIMITS.grokDeliveryChars);
  assert.deepEqual(posts.slice(1).map((p) => (JSON.parse(p.body) as DeliveryPayload).messages.length), [10, 10, 5]);
  assert.equal(h.store.db.get<{ n: number }>("SELECT count(*) AS n FROM deliveries WHERE state = 'failed'")!.n, 0);
  h.engine.stop();
});

test('review C7: the 25-min hint and the 1 h notice count from hand-off to Grok, not from acceptance', async () => {
  // a delivery held by the bot's hourly cap is handed off much later than it was accepted
  const { h, c, fake, posts } = await setup(ok, { perHourCap: 1 });
  const g0 = await start(h, c, 'warm-up'); // uses the bot's only slot this hour
  await h.tool({ participant_id: h.store.bots()[0]!.participant_id, epoch: 0 }, 'bridge_send', { conversation_id: g0.conversation_id!, body: 'ok' });
  await h.clock.advance(1000); await h.idle();
  const s = await h.tool(c, 'bridge_send', { conversation_id: g0.conversation_id!, body: 'question held by the cap' });
  assert.equal(s.status, 'queued');
  assert.equal(h.store.conversation(g0.conversation_id!)!.waiting_since, null); // not handed off: no clock yet
  await h.clock.advance(40 * MIN); await h.idle(); // still capped (the hour since the first hand-off is not over)
  assert.equal(posts.length, 1);
  assert.ok(!fake.noticeCodes(c.participant_id).includes('grok_waiting')); // would have fired at 25 min from acceptance
  await h.clock.advance(21 * MIN); await h.idle(); // cap frees → handed off now
  assert.equal(posts.length, 2);
  const handedOff = h.store.conversation(g0.conversation_id!)!.waiting_since!;
  assert.equal(handedOff, posts[1]!.at); // the clock starts at the POST that handed it off
  await h.clock.advance(handedOff + 25 * MIN - 1000 - h.clock.now()); await h.idle();
  assert.ok(!fake.noticeCodes(c.participant_id).includes('grok_waiting'));
  await h.clock.advance(1000); await h.idle();
  assert.ok(fake.noticeCodes(c.participant_id).includes('grok_waiting')); // 25 min after hand-off
  h.engine.stop();
});
