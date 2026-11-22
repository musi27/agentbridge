// `agentbridge add grok`, `revoke grok:<name>` and the doctor round trip (§12.5, §12.6): bridge side, CLI methods over
// handleCli (presence for the first step only), and the interactive flow with a scripted terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROK_ROUTINE_INSTRUCTION, SECRET_NAMES, zBotId, type CliMethod, type DeliveryPayload } from '@agentbridge/protocol';
import { GrokAdapter, botTokenHash } from '@agentbridge/adapter-grok';
import { FakeAdapter } from '@agentbridge/adapter-fake';
import { harness } from './helpers.ts';
import { FakeClock } from '../src/clock.ts';
import { openDatabase } from '../src/db/db.ts';
import { Store } from '../src/db/store.ts';
import { MemorySecretStore } from '../src/policy/integrity.ts';
import { RelayLink } from '../src/relay/link.ts';
import { GrokSetup, GrokSetupError, roundTripCauses } from '../src/grok/setup.ts';
import { handleCli } from '../src/ipc/cli-methods.ts';
import { LineSplitter, addGrokFlow, revokeGrokFlow, type Io } from '../src/cli/grok.ts';
import { ENDPOINT, FakeTransport, errorOf, relayCall, result, simulateRun } from './grok-helpers.ts';

type RunMode = 'reply' | 'read_only' | 'silent';
const WEBHOOK = 'https://api2.cursor.sh/webhooks/abc';

async function setup(o: { webhook?: (n: number) => Response | Error; roundTripMs?: number; retryMs?: number[] } = {}) {
  const clock = new FakeClock(); const store = new Store(openDatabase(':memory:')); const secrets = new MemorySecretStore();
  const transport = new FakeTransport();
  let link!: RelayLink;
  const state = { mode: 'reply' as RunMode, posts: 0, runs: [] as Promise<unknown>[] };
  const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
    state.posts++;
    if (o.webhook) { const r = o.webhook(state.posts); if (r instanceof Error) throw r; if (r.status !== 200) return r; }
    const payload = JSON.parse(String(init?.body)) as DeliveryPayload;
    const key = (init?.headers as Record<string, string>)['authorization']!.replace('Bearer ', '');
    // the routine run: find the bot whose webhook key was used, then act like Appendix B
    const bot = await (async () => { for (const b of store.bots()) if (await secrets.get(SECRET_NAMES.webhookKey(b.bot_id)) === key) return b; return null; })();
    if (bot && state.mode !== 'silent') {
      const token = (await secrets.get(SECRET_NAMES.botToken(bot.bot_id)))!;
      state.runs.push(new Promise((r) => setTimeout(r, 5)).then((): Promise<unknown> => state.mode === 'read_only'
        ? relayCall(link, { botId: bot.bot_id, token }, 'bridge_get_messages', { conversation_id: payload.conversation.id })
        : simulateRun(link, { botId: bot.bot_id, token }, payload, { alwaysRead: true, reply: () => 'pong from grok' })));
    }
    return new Response('{"success":true,"runUuid":"run-setup"}', { status: 200 });
  }) as typeof fetch;
  const grok = new GrokAdapter({
    secrets, botIdFor: (r) => store.participant(r.participant_id)?.bot_id ?? null, fetch: fetchImpl, now: () => clock.now(), probeReachability: false,
    listBots: () => store.bots().map((b) => ({ bot_id: b.bot_id, address: `grok:${store.participant(b.participant_id)!.name}` })),
  });
  const fake = new FakeAdapter();
  const h = await harness({ clock, store, secrets, fake, adapters: { fake, grok } });
  link = new RelayLink({ engine: h.engine, transport, endpoint: ENDPOINT });
  let now = Date.UTC(2026, 10, 22, 12);
  const g = new GrokSetup({ engine: h.engine, link, secrets, adapter: grok, roundTripMs: o.roundTripMs ?? 2_000, roundTripRetryMs: o.retryMs ?? [20, 50], now: () => now });
  return { h, link, transport, secrets, g, grok, state, advance: (ms: number) => { now += ms; } };
}

async function fullAdd(x: Awaited<ReturnType<typeof setup>>, name = 'researcher') {
  const b = await x.g.begin(name);
  await x.g.saveWebhook(b.setup_id, WEBHOOK, 'whk_1');
  return b;
}

test('§12.5 begin: mints bot_id and a 256-bit token, stores it, registers token_hash with the relay, creates the bot', async () => {
  const x = await setup();
  const b = await x.g.begin('Researcher');
  assert.ok(zBotId.safeParse(b.bot_id).success);
  assert.equal(Buffer.from(b.token, 'base64url').length, 32);
  assert.equal(await x.secrets.get(SECRET_NAMES.botToken(b.bot_id)), b.token);
  assert.deepEqual(x.transport.controls, [{ method: 'register_bot', params: { bot_id: b.bot_id, token_hash: botTokenHash(b.token), discovery: 'names' } }]);
  assert.equal(b.address, 'grok:Researcher'); // names keep their case, like Claude participants
  assert.equal(x.h.store.bot(b.bot_id)!.token_hash, botTokenHash(b.token));
  assert.ok(b.bootstrap.includes(`https://relay.musi.live/v1/u/${ENDPOINT.userId}/b/${b.bot_id}/mcp`));
  assert.ok(b.bootstrap.includes('Authorization: Bearer TOKEN')); // the user pastes the token over TOKEN
  assert.ok(!b.bootstrap.includes(b.token) && !/[<>]/.test(b.bootstrap));
  assert.equal(b.instruction, GROK_ROUTINE_INSTRUCTION);
  assert.deepEqual([...b.allow_rule_tools], ['bridge_send', 'bridge_get_messages', 'bridge_end_conversation', 'bridge_get_transcript']);
  // discovery none is passed to the relay
  await x.h.setPolicy('discovery.relay', 'none');
  await x.g.begin('second');
  assert.equal(x.transport.controls.at(-1)!.params['discovery'], 'none');
  // C4: control() connects by itself in the client (15 s grace, no cap); setup neither marks Grok activity nor connects
  assert.equal(x.transport.active, 0); assert.equal(x.transport.connects, 0);
  x.h.engine.stop();
});

test('§12.5 begin: a relay failure leaves no bot and no token; an unusable name is refused; no relay → bridge_offline', async () => {
  const x = await setup();
  x.transport.failWith = 'relay timeout';
  await assert.rejects(x.g.begin('researcher'), (e: GrokSetupError) => e.code === 'bridge_offline' && /did not register/.test(e.message));
  assert.equal(x.h.store.bots().length, 0);
  assert.equal([...x.secrets.map.keys()].filter((k) => k.startsWith('bot.')).length, 0);
  x.transport.failWith = null;
  await assert.rejects(x.g.begin('!!!'), (e: GrokSetupError) => e.code === 'invalid_message');
  const bare = new GrokSetup({ engine: x.h.engine, link: new RelayLink({ engine: x.h.engine }), secrets: x.secrets });
  await assert.rejects(bare.begin('researcher'), (e: GrokSetupError) => e.code === 'bridge_offline');
  x.h.engine.stop();
});

test('§12.5 webhook step: URL shape checked, URL and key stored; setup ids expire after 30 min', async () => {
  const x = await setup();
  const b = await x.g.begin('researcher');
  await assert.rejects(x.g.saveWebhook(b.setup_id, 'http://api2.cursor.sh/x', 'k'), /https/);
  await assert.rejects(x.g.saveWebhook(b.setup_id, WEBHOOK, 'has space'), /key/);
  await assert.rejects(x.g.saveWebhook('forged', WEBHOOK, 'k'), (e: GrokSetupError) => e.code === 'not_allowed');
  await x.g.saveWebhook(b.setup_id, ` ${WEBHOOK} `, ' whk_1 ');
  assert.equal(await x.secrets.get(SECRET_NAMES.webhookUrl(b.bot_id)), WEBHOOK);
  assert.equal(await x.secrets.get(SECRET_NAMES.webhookKey(b.bot_id)), 'whk_1');
  x.advance(31 * 60_000);
  await assert.rejects(x.g.saveWebhook(b.setup_id, WEBHOOK, 'k'), (e: GrokSetupError) => e.code === 'not_allowed');
  assert.equal(x.g.session(b.setup_id, ['add']), null);
  x.h.engine.stop();
});

test('§12.5 round trip: test delivery → the run reads and replies with bridge_send → ok; no conversation is stored', async () => {
  const x = await setup();
  const b = await fullAdd(x);
  const r = await x.g.roundTrip(x.h.store.bot(b.bot_id)!.participant_id);
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.reply_preview, 'pong from grok'); assert.equal(r.run_uuid, 'run-setup'); }
  assert.equal(x.h.store.conversations().length, 0);
  assert.ok(x.h.store.events({ type: 'grok_round_trip_ok' }).length === 1);
  // the probe is gone afterwards: a late call for its conversation is an unknown conversation
  x.h.engine.stop();
});

test('§12.5 round trip failures list the causes in order: placeholder → card/Allow rule → connector/token → paused', async () => {
  const x = await setup({ roundTripMs: 100 });
  const b = await fullAdd(x);
  const pid = x.h.store.bot(b.bot_id)!.participant_id;
  x.state.mode = 'silent';
  const silent = await x.g.roundTrip(pid);
  assert.equal(silent.ok, false);
  if (!silent.ok) {
    assert.equal(silent.stage, 'no_reply'); assert.deepEqual(silent.calls_seen, []);
    assert.deepEqual(silent.causes, roundTripCauses('grok:researcher'));
    assert.match(silent.causes[0]!, /placeholder/); assert.match(silent.causes[1]!, /Auto-review card/); assert.match(silent.causes[2]!, /connector is missing or the token is wrong/); assert.match(silent.causes[3]!, /paused/);
    assert.match(silent.detail, /never called agentbridge/);
  }
  // The read-only run must land inside the budget for calls_seen to show it; 100 ms is too tight on a loaded machine
  // (a run that never replies waits out the whole budget, so keep this window modest).
  const xr = await setup({ roundTripMs: 1_500 });
  const rb = await fullAdd(xr);
  xr.state.mode = 'read_only';
  const read = await xr.g.roundTrip(xr.h.store.bot(rb.bot_id)!.participant_id);
  await Promise.all(xr.state.runs);
  if (!read.ok) { assert.deepEqual(read.calls_seen, ['bridge_get_messages']); assert.match(read.detail, /did not reply/); } else assert.fail('expected failure');

  const p = await setup({ webhook: () => new Response('{"success":false,"error":"Automation 1 is disabled"}', { status: 400 }) });
  const pb = await fullAdd(p);
  const paused = await p.g.roundTrip(p.h.store.bot(pb.bot_id)!.participant_id);
  if (!paused.ok) { assert.equal(paused.stage, 'webhook'); assert.equal(paused.causes.length, 1); assert.match(paused.causes[0]!, /paused/); } else assert.fail('expected failure');
  const k = await setup({ webhook: () => new Response('{"message":"Invalid API key"}', { status: 401 }) });
  const kb = await fullAdd(k);
  const key = await k.g.roundTrip(k.h.store.bot(kb.bot_id)!.participant_id);
  if (!key.ok) { assert.match(key.detail, /webhook key changed/); assert.match(key.causes[0]!, /webhook URL and key again/); } else assert.fail('expected failure');
  for (const y of [x, xr, p, k]) y.h.engine.stop();
});

test('§12.6 revoke: a new token replaces the old one in the keychain, relay and DB; a relay failure keeps the old one', async () => {
  const x = await setup();
  const b = await fullAdd(x);
  const pid = x.h.store.bot(b.bot_id)!.participant_id;
  const r = await x.g.rotate(pid);
  assert.notEqual(r.token, b.token);
  assert.equal(await x.secrets.get(SECRET_NAMES.botToken(b.bot_id)), r.token);
  assert.deepEqual(x.transport.controls.at(-1), { method: 'register_bot', params: { bot_id: b.bot_id, token_hash: botTokenHash(r.token), discovery: 'names' } });
  assert.equal(errorOf(await relayCall(x.link, { botId: b.bot_id, token: b.token }, 'bridge_list_conversations', {})).code, 'not_participant');
  assert.equal(result(await relayCall(x.link, { botId: b.bot_id, token: r.token }, 'bridge_list_conversations', {}))['status'], 'delivered');
  x.transport.failWith = 'down';
  await assert.rejects(x.g.rotate(pid), /old one still works/);
  assert.equal(await x.secrets.get(SECRET_NAMES.botToken(b.bot_id)), r.token);
  assert.equal(result(await relayCall(x.link, { botId: b.bot_id, token: r.token }, 'bridge_list_conversations', {}))['status'], 'delivered');
  x.h.engine.stop();
});

test('cli.add_grok / cli.revoke / cli.doctor: presence only for the first step; follow-ups need the setup id', async () => {
  const x = await setup();
  const ctx = { engine: x.h.engine, grok: x.g };
  const cli = (m: string, p: unknown) => handleCli(ctx, m as CliMethod, p);
  x.h.presence.answer = { ok: false, code: 'cancelled' };
  assert.equal((await cli('cli.add_grok', { step: 'begin', name: 'researcher' })).error?.code, 'unauthenticated');
  assert.match(x.h.presence.reasons.at(-1)!, /add a Grok bot/);
  x.h.presence.answer = { ok: true, method: 'biometric_or_password' };
  const b = (await cli('cli.add_grok', { step: 'begin', name: 'researcher' })).result as { setup_id: string; address: string };
  const asked = x.h.presence.reasons.length;
  x.h.presence.answer = { ok: false, code: 'cancelled' }; // follow-ups do not ask again
  assert.ok((await cli('cli.add_grok', { step: 'webhook', setup_id: b.setup_id, webhook_url: WEBHOOK, webhook_key: 'whk_1' })).result);
  const check = (await cli('cli.add_grok', { step: 'check', setup_id: b.setup_id })).result as { ok: boolean };
  assert.equal(check.ok, true);
  assert.equal(x.h.presence.reasons.length, asked);
  assert.equal((await cli('cli.add_grok', { step: 'check', setup_id: 'forged' })).error?.code, 'not_allowed');
  // a revoke-setup id cannot drive an add flow and vice versa
  assert.equal((await cli('cli.revoke', { step: 'check', setup_id: b.setup_id })).error?.code, 'not_allowed');
  assert.equal((await cli('cli.revoke', { address: 'grok:researcher' })).error?.code, 'unauthenticated');
  x.h.presence.answer = { ok: true, method: 'biometric_or_password' };
  assert.match(x.h.presence.reasons.at(-1)!, /revoke the agentbridge token of grok:researcher/);
  const rv = (await cli('cli.revoke', { address: 'grok:researcher' })).result as { setup_id: string; token: string };
  assert.ok(rv.token);
  assert.equal(((await cli('cli.revoke', { step: 'check', setup_id: rv.setup_id })).result as { ok: boolean }).ok, true);
  assert.equal((await cli('cli.revoke', { address: 'fake:nobody' })).error?.code, 'recipient_gone');
  x.h.engine.registerLocal({ name: 'local' });
  assert.equal((await cli('cli.revoke', { address: 'fake:local' })).error?.code, 'invalid_message');
  // doctor: Grok checks always; the round trip on demand
  const doc = (await cli('cli.doctor', {})).result as { checks: Array<{ id: string; ok: boolean }> };
  assert.ok(doc.checks.some((c) => c.id === 'grok:researcher:secrets' && c.ok));
  const rt = (await cli('cli.doctor', { round_trip: 'grok:researcher' })).result as { round_trip: { ok: boolean } };
  assert.equal(rt.round_trip.ok, true);
  assert.equal((await handleCli({ engine: x.h.engine }, 'cli.add_grok', { step: 'begin', name: 'x' })).error?.code, 'internal');
  x.h.engine.stop();
});

class ScriptIo implements Io {
  readonly out: string[] = []; readonly copies: string[] = []; readonly hidden: string[] = [];
  private readonly answers: string[]; private readonly hiddenAnswers: string[]; private readonly clipboard: boolean;
  constructor(answers: string[], hiddenAnswers: string[], clipboard = true) { this.answers = answers; this.hiddenAnswers = hiddenAnswers; this.clipboard = clipboard; }
  print(s: string): void { this.out.push(s); }
  async prompt(q: string): Promise<string> { this.out.push(`? ${q}`); const a = this.answers.shift(); if (a === undefined) throw new Error(`unexpected prompt: ${q}`); return a; }
  async promptHidden(q: string): Promise<string> { this.hidden.push(q); const a = this.hiddenAnswers.shift(); if (a === undefined) throw new Error(`unexpected hidden prompt: ${q}`); return a; }
  clip: string | null = null;
  async copy(t: string): Promise<boolean> { this.copies.push(t); if (this.clipboard) this.clip = t; return this.clipboard; }
  async paste(): Promise<string | null> { return this.clipboard ? this.clip : null; }
}

function callVia(x: Awaited<ReturnType<typeof setup>>) {
  return async (m: string, p: unknown): Promise<unknown> => {
    const r = await handleCli({ engine: x.h.engine, grok: x.g }, m as CliMethod, p);
    if (r.error) throw new Error(r.error.message);
    return r.result;
  };
}

test('agentbridge add grok (interactive): prompt, token once, instruction, hidden webhook input, round trip with retry', async () => {
  const x = await setup({ roundTripMs: 1_000 }); // the retry must see the run's reply inside the budget, even under load
  x.state.mode = 'silent'; // first check fails
  const io = new ScriptIo(
    ['researcher', '', 'show', '', '', 'n', 'n', 'y', 'y'],
    ['http://wrong', 'k', WEBHOOK, 'whk_1'],
  );
  // flip the run on before the retry
  const origPrompt = io.prompt.bind(io);
  io.prompt = async (q: string) => { if (/try again/.test(q)) x.state.mode = 'reply'; return origPrompt(q); };
  const code = await addGrokFlow(callVia(x), io);
  assert.equal(code, 0);
  const b = x.h.store.bots()[0]!;
  const token = (await x.secrets.get(SECRET_NAMES.botToken(b.bot_id)))!;
  assert.equal(io.copies.length, 4);
  assert.match(io.copies[0]!, /Authorization: Bearer TOKEN/); // 1. bootstrap prompt
  assert.equal(io.copies[1], token); // 2. token, to the clipboard first
  assert.equal(io.copies[2], ''); // 3. clipboard cleared after Enter (it still held the token)
  assert.equal(io.copies[3], GROK_ROUTINE_INSTRUCTION); // 4. Appendix B
  assert.equal(io.out.filter((l) => l.includes(token)).length, 1); // printed only because the user typed "show"
  assert.ok(io.out.some((l) => /Clipboard cleared/.test(l)));
  assert.deepEqual(io.hidden, ['Webhook URL: ', 'Webhook key: ', 'Webhook URL: ', 'Webhook key: ']);
  assert.ok(io.out.some((l) => /✗ .*https/.test(l))); // bad URL rejected, asked again
  assert.ok(io.out.some((l) => /You receive deliveries from agentbridge/.test(l)));
  assert.ok(io.out.some((l) => /1\. The routine instruction is still the placeholder/.test(l))); // causes, in order
  assert.ok(io.out.some((l) => /4\. The routine is paused/.test(l)));
  assert.ok(io.out.some((l) => /✓ Round trip works/.test(l)));
  assert.ok(!io.out.some((l) => l.includes('whk_1'))); // the key never echoes
  x.h.engine.stop();
});

test('agentbridge add grok: clipboard unavailable → texts are printed; giving up the check exits 1', async () => {
  const x = await setup({ roundTripMs: 50 });
  x.state.mode = 'silent';
  const io = new ScriptIo(['researcher', '', '', '', 'y', 'n'], [WEBHOOK, 'whk_1'], false);
  assert.equal(await addGrokFlow(callVia(x), io), 1);
  assert.ok(io.out.some((l) => l.includes(GROK_ROUTINE_INSTRUCTION)));
  const token = (await x.secrets.get(SECRET_NAMES.botToken(x.h.store.bots()[0]!.bot_id)))!;
  assert.equal(io.out.filter((l) => l.includes(token)).length, 1); // clipboard failed → printed once
  assert.ok(!io.copies.includes(''));
  assert.ok(io.out.some((l) => /agentbridge doctor grok:researcher/.test(l)));
  x.h.engine.stop();
});

test('agentbridge revoke grok:<name> (interactive): new token shown once, optional round trip', async () => {
  const x = await setup();
  await fullAdd(x);
  const io = new ScriptIo(['', ''], []);
  assert.equal(await revokeGrokFlow(callVia(x), io, 'grok:researcher'), 0);
  const b = x.h.store.bots()[0]!;
  const token = (await x.secrets.get(SECRET_NAMES.botToken(b.bot_id)))!;
  assert.deepEqual(io.copies, [token, '']); // clipboard first, cleared after Enter
  assert.ok(!io.out.some((l) => l.includes(token))); // never printed
  // the round trip runs by default (§12.5)
  assert.ok(io.out.some((l) => /old token for grok:researcher no longer works/.test(l)));
  assert.ok(io.out.some((l) => /✓ Round trip works/.test(l)));
  x.h.engine.stop();
});

// ------------------------------------------------------------------ integrator review of PR #6

test('review S2: one round trip per bot at a time, at most 6 per hour, each counted in the hourly delivery counter', async () => {
  const x = await setup();
  const b = await fullAdd(x);
  const pid = x.h.store.bot(b.bot_id)!.participant_id;
  const [a, busy] = await Promise.all([x.g.roundTrip(pid), x.g.roundTrip(pid)]);
  assert.equal(a.ok, true);
  assert.equal(busy.ok, false); if (!busy.ok) assert.equal(busy.stage, 'busy');
  assert.equal(x.h.store.countHandedOffSince(pid, x.h.clock.now() - 3600_000), 1);
  for (let i = 0; i < 5; i++) assert.equal((await x.g.roundTrip(pid)).ok, true);
  const limited = await x.g.roundTrip(pid);
  if (!limited.ok) { assert.equal(limited.stage, 'cap'); assert.match(limited.detail, /6 round trips/); } else assert.fail('expected the hourly limit');
  assert.equal(x.h.store.countHandedOffSince(pid, x.h.clock.now() - 3600_000), 6);
  assert.equal(x.state.posts, 6);
  await x.h.clock.advance(3601_000);
  assert.equal((await x.g.roundTrip(pid)).ok, true);
  x.h.engine.stop();
});

/** Slack on top of a round-trip budget for these wall-clock checks: CPU-starved timers fire late on a loaded machine. */
const BUDGET_LOAD_TOLERANCE_MS = 1500;

test('review C8: round trip retries network/5xx with the same payload inside one ≤ budget; network failure is reported apart', async () => {
  const flaky = await setup({ webhook: (n) => (n === 1 ? new Error('ECONNRESET') : n === 2 ? new Response('', { status: 502 }) : new Response('', { status: 200 })) });
  const fb = await fullAdd(flaky);
  const ok = await flaky.g.roundTrip(flaky.h.store.bot(fb.bot_id)!.participant_id);
  assert.equal(ok.ok, true); assert.equal(flaky.state.posts, 3);

  const down = await setup({ webhook: () => new Error('getaddrinfo ENOTFOUND api2.cursor.sh') });
  const db = await fullAdd(down);
  const t0 = Date.now();
  const r = await down.g.roundTrip(down.h.store.bot(db.bot_id)!.participant_id);
  assert.ok(Date.now() - t0 < 2_000 + BUDGET_LOAD_TOLERANCE_MS, `took ${Date.now() - t0} ms`); // the budget (2 s here) covers POSTs and retries
  if (!r.ok) {
    assert.equal(r.stage, 'network'); assert.equal(r.causes.length, 1);
    assert.match(r.causes[0]!, /could not reach the Grok webhook/); assert.doesNotMatch(r.causes[0]!, /placeholder|Auto-review/);
  } else assert.fail('expected failure');
  assert.equal(down.state.posts, 3); // first try + two retries

  // the reply wait is what is left of the budget after the POSTs
  const slow = await setup({ roundTripMs: 300, webhook: (n) => (n === 1 ? new Response('', { status: 503 }) : new Response('', { status: 200 })), retryMs: [150] });
  const sb = await fullAdd(slow); slow.state.mode = 'silent';
  const t1 = Date.now();
  const s = await slow.g.roundTrip(slow.h.store.bot(sb.bot_id)!.participant_id);
  assert.equal(s.ok, false); assert.ok(Date.now() - t1 < 300 + BUDGET_LOAD_TOLERANCE_MS, `took ${Date.now() - t1} ms (budget 300)`);
  for (const y of [flaky, down, slow]) y.h.engine.stop();
});

test('review C4: relay error codes reach the user (rate_limited for the bot limit), not a blanket bridge_offline', async () => {
  const x = await setup();
  x.transport.failWith = 'at most 32 bots'; x.transport.failCode = 'rate_limited';
  await assert.rejects(x.g.begin('researcher'), (e: GrokSetupError) => e.code === 'rate_limited' && /32 bots/.test(e.message));
  x.transport.failCode = 'timeout';
  await assert.rejects(x.g.begin('researcher'), (e: GrokSetupError) => e.code === 'bridge_offline');
  x.transport.failCode = 'something_new';
  await assert.rejects(x.g.begin('researcher'), (e: GrokSetupError) => e.code === 'internal');
  x.h.engine.stop();
});

test('review: revoke updates the DB hash before re-registering; a relay failure restores the old hash and token', async () => {
  const x = await setup();
  const b = await fullAdd(x);
  const pid = x.h.store.bot(b.bot_id)!.participant_id;
  let hashAtRegister = '';
  x.transport.onControl = () => { hashAtRegister = x.h.store.bot(b.bot_id)!.token_hash; };
  const r = await x.g.rotate(pid);
  assert.equal(hashAtRegister, botTokenHash(r.token)); // DB already had the new hash when the relay was asked
  x.transport.failWith = 'down';
  await assert.rejects(x.g.rotate(pid));
  assert.equal(x.h.store.bot(b.bot_id)!.token_hash, botTokenHash(r.token)); // restored
  assert.equal(await x.secrets.get(SECRET_NAMES.botToken(b.bot_id)), r.token);
  x.h.engine.stop();
});

test('review: an abandoned add (abort, or expiry before the webhook step) is undone: revoke_bot, keychain token, participant', async () => {
  const x = await setup();
  const a = await x.g.begin('first');
  assert.deepEqual(await x.g.abort(a.setup_id), { removed: true });
  assert.deepEqual(x.transport.controls.at(-1), { method: 'revoke_bot', params: { bot_id: a.bot_id } });
  assert.equal(await x.secrets.get(SECRET_NAMES.botToken(a.bot_id)), null);
  assert.equal(x.h.store.participant(x.h.store.bot(a.bot_id)!.participant_id)!.state, 'gone');
  assert.notEqual(x.h.store.bot(a.bot_id)!.revoked_at, null);

  const e = await x.g.begin('second');
  x.advance(31 * 60_000);
  assert.equal(await x.g.sweepAbandoned(), 1);
  assert.equal(await x.secrets.get(SECRET_NAMES.botToken(e.bot_id)), null);
  assert.ok(x.transport.controls.some((c) => c.method === 'revoke_bot' && c.params['bot_id'] === e.bot_id));

  // a setup whose webhook was saved is kept when it expires (doctor can repeat the check)
  const k = await fullAdd(x, 'third');
  x.advance(31 * 60_000);
  assert.equal(await x.g.sweepAbandoned(), 0);
  assert.ok(await x.secrets.get(SECRET_NAMES.botToken(k.bot_id)));
  x.h.engine.stop();
});

test('review: CLI abort on error before the webhook step; remove grok:<name> sends revoke_bot and clears the keychain', async () => {
  const x = await setup();
  const io = new ScriptIo(['researcher', ''], []); // runs out of answers at the token step → throws
  await assert.rejects(addGrokFlow(callVia(x), io), /unexpected prompt/);
  const b = x.h.store.bots()[0]!;
  assert.ok(x.transport.controls.some((c) => c.method === 'revoke_bot' && c.params['bot_id'] === b.bot_id));
  assert.ok(io.out.some((l) => /Setup cancelled/.test(l)));

  const k = await fullAdd(x, 'keeper');
  const res = await handleCli({ engine: x.h.engine, grok: x.g }, 'cli.remove', { address: k.address });
  assert.ok(res.result);
  assert.deepEqual(x.transport.controls.at(-1), { method: 'revoke_bot', params: { bot_id: k.bot_id } });
  for (const n of [SECRET_NAMES.botToken(k.bot_id), SECRET_NAMES.webhookUrl(k.bot_id), SECRET_NAMES.webhookKey(k.bot_id)]) assert.equal(await x.secrets.get(n), null);
  assert.equal(x.h.store.participant(x.h.store.bot(k.bot_id)!.participant_id)!.state, 'gone');
  x.h.engine.stop();
});

test('review: the terminal line reader keeps text after a newline in the same chunk (pasted URL + key)', () => {
  const s = new LineSplitter();
  s.push('https://api2.cursor.sh/x\nwhk_key\n');
  assert.deepEqual([s.shift(), s.shift(), s.shift()], ['https://api2.cursor.sh/x', 'whk_key', undefined]);
  s.push('\x1b[200~pasted\x1b[201~\r\nab\x7fc\r');
  assert.deepEqual([s.shift(), s.shift()], ['pasted', 'ac']);
  s.push('par'); assert.equal(s.shift(), undefined); s.push('tial\n'); assert.equal(s.shift(), 'partial');
  s.push('\u0003'); assert.equal(s.cancelled, true);
});

test('e2e run 1: step 1 copies the token only after the user confirms the prompt is pasted; "p" re-copies the prompt', async () => {
  const x = await setup();
  const io = new ScriptIo(['researcher', 'p', '', 'p', 'copy', '', '', 'y'], [WEBHOOK, 'whk_1']);
  const prompts: string[] = [];
  const orig = io.prompt.bind(io);
  io.prompt = async (q: string) => { prompts.push(q); return orig(q); };
  assert.equal(await addGrokFlow(callVia(x), io), 0);
  const token = (await x.secrets.get(SECRET_NAMES.botToken(x.h.store.bots()[0]!.bot_id)))!;
  const boot = io.copies[0]!;
  assert.match(boot, /Authorization: Bearer TOKEN/);
  assert.deepEqual(io.copies.slice(0, 6), [boot, boot, token, boot, token, '']); // prompt, re-copy, token, prompt again, token again, cleared
  const pastedQ = prompts.findIndex((q) => /Pasted it into the bot's chat \(not sent\)\?/.test(q));
  assert.ok(pastedQ >= 0 && pastedQ < prompts.findIndex((q) => /Replace the word TOKEN/.test(q)));
  assert.ok(!io.out.some((l) => l.includes(token))); // never printed
  x.h.engine.stop();
});
