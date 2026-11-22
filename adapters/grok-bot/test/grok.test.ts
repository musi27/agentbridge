import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELIVERY_END, LIMITS, SECRET_NAMES, zBotId, type OutboundItem, type ParticipantRef, type SecretStore } from '@agentbridge/protocol';
import { GrokAdapter, HINTS, NO_CONVERSATION, botTokenHash, mapWebhookResult, mintBotId, mintBotToken, packItem, tokenMatchesHash, toPackInput, webhookUrlProblem } from '../src/index.ts';

class Secrets implements SecretStore {
  readonly map = new Map<string, string>();
  async get(n: string): Promise<string | null> { return this.map.get(n) ?? null; }
  async set(n: string, v: string): Promise<void> { this.map.set(n, v); }
  async delete(n: string): Promise<void> { this.map.delete(n); }
}

const BOT = 'bot0000000000001';
const REF: ParticipantRef = { participant_id: '01JD00000000000000000000GK', address: 'grok:researcher', agent: 'grok' };
const URL_ = 'https://api2.cursor.sh/webhooks/abc';

function item(o: Partial<OutboundItem> = {}): OutboundItem {
  return {
    item_id: '01JD0000000000000000000ITM',
    conversation: { id: '01JD0000000000000000000CNV', topic: 'auth refactor', peer_address: 'claude:auth-refactor', turn: 6, turn_limit: 30, state: 'active' },
    messages: [{ message_id: '01JD0000000000000000000M11', seq: 11, turn: 6, from_address: 'claude:auth-refactor', body: 'Is the migration done?', created_at: '2026-11-22T12:00:00.000Z' }],
    notices: [], reply_to: '01JD0000000000000000000M11', ...o,
  };
}

interface Call { url: string; init: RequestInit }
function fakeFetch(answer: (n: number) => Response | Error): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const a = answer(calls.length);
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
  return { fetch: f, calls };
}
const ok = (): Response => new Response(JSON.stringify({ success: true, runUuid: 'run-1' }), { status: 200 });

async function adapter(answer: (n: number) => Response | Error = ok, extra: Partial<ConstructorParameters<typeof GrokAdapter>[0]> = {}) {
  const secrets = new Secrets();
  await secrets.set(SECRET_NAMES.webhookUrl(BOT), URL_); await secrets.set(SECRET_NAMES.webhookKey(BOT), 'whk_secret');
  await secrets.set(SECRET_NAMES.botToken(BOT), 'tok');
  const ff = fakeFetch(answer);
  let t = Date.UTC(2026, 10, 22, 12); const activity: string[] = []; const logs: string[] = [];
  const a = new GrokAdapter({
    secrets, botIdFor: (r) => (r.participant_id === REF.participant_id ? BOT : null), fetch: ff.fetch, now: () => t,
    onActivity: (b) => activity.push(b), log: (l) => logs.push(l), listBots: () => [{ bot_id: BOT, address: REF.address }], ...extra,
  });
  return { a, secrets, calls: ff.calls, activity, logs, advance: (ms: number) => { t += ms; } };
}

// ---------------------------------------------------------------- packing

test('§12.4 packing: full bodies when they fit; header, reply_to, notices; end is the last field', () => {
  const p = packItem(item({ notices: [{ id: 'n', code: 'accepted', severity: 'info', parts: [], text: 'claude:auth-refactor accepted the conversation.' }] }));
  assert.equal(p.truncated, false);
  assert.deepEqual(Object.keys(p.payload).at(-1), 'end');
  assert.equal(p.payload.end, DELIVERY_END);
  assert.ok(p.json.endsWith(`"end":"${DELIVERY_END}"}`));
  assert.deepEqual(p.payload.conversation, { id: '01JD0000000000000000000CNV', topic: 'auth refactor', peer: 'claude:auth-refactor', turn: 6, turn_limit: 30, turns_left: 24, state: 'active' });
  assert.equal(p.payload.messages[0]!.body, 'Is the migration done?');
  assert.equal(p.payload.reply_to, '01JD0000000000000000000M11');
  assert.deepEqual(p.payload.notices, [{ code: 'accepted', severity: 'info', text: 'claude:auth-refactor accepted the conversation.' }]);
});

test('§12.4 packing: long or many messages become previews; never above 3,500 chars or bytes', () => {
  const long = 'ü'.repeat(5000);
  const msgs = Array.from({ length: 12 }, (_, i) => ({ message_id: `01JD0000000000000000000M${String(i).padStart(2, '0')}`, seq: 20 + i, from_address: 'claude:x', body: `${i} ${long}`, created_at: '2026-11-22T12:00:00.000Z' }));
  const notes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, code: 'ended', severity: 'info' as const, parts: [], text: 'x'.repeat(1000) }));
  const p = packItem(item({ messages: msgs, notices: notes, reply_to: msgs.at(-1)!.message_id }));
  assert.equal(p.truncated, true); assert.equal(p.payload.truncated, true);
  assert.ok(p.json.length <= LIMITS.grokDeliveryChars); assert.ok(Buffer.byteLength(p.json) <= LIMITS.grokDeliveryChars);
  assert.equal(p.payload.messages.length, 12);
  for (const m of p.payload.messages) { assert.equal(m.body, undefined); assert.equal(m.length, 5000 + String(Number(m.seq) - 20).length + 1); }
  assert.equal(p.payload.end, DELIVERY_END);
});

test('§12.4 packing: notice-only delivery has messages [] and reply_to null; no-conversation notices get a placeholder header', () => {
  const n = { id: 'n', code: 'rate_limited', severity: 'warning' as const, parts: [], text: 'Your conversation request was rate limited.' };
  const a = toPackInput(item({ messages: [], notices: [n], reply_to: 'X' }));
  assert.equal(a.replyTo, null); assert.deepEqual(a.messages, []);
  const { conversation, ...rest } = item({ messages: [], notices: [n], reply_to: null }); void conversation;
  const b = packItem(rest);
  assert.deepEqual(b.payload.messages, []); assert.equal(b.payload.reply_to, null);
  assert.equal(b.payload.conversation.id, NO_CONVERSATION.id);
  // a pending conversation reads as active for Grok
  const pend = toPackInput(item({ conversation: { id: 'c', topic: 't', peer_address: 'claude:x', turn: 0, turn_limit: 30, state: 'pending' } }));
  assert.equal(pend.conversation.state, 'active');
});

// ---------------------------------------------------------------- results mapping (§12.4, M0 V9)

test('§12.4 results: 200/success → handed_off with runUuid; network and 5xx retryable; 400 disabled / 401 / other → failed', () => {
  assert.deepEqual(mapWebhookResult({ kind: 'response', status: 200, body: '{"success":true,"runUuid":"r-9"}' }).outcome, { status: 'handed_off', run_uuid: 'r-9' });
  const net = mapWebhookResult({ kind: 'network', error: 'ECONNRESET' });
  assert.deepEqual(net.outcome, { status: 'failed', reason: 'grok_run_not_started', hint: HINTS.network, retryable: true });
  for (const s of [500, 502, 503]) assert.deepEqual(mapWebhookResult({ kind: 'response', status: s, body: 'oops' }).outcome, { status: 'failed', reason: 'grok_run_not_started', hint: HINTS.server, retryable: true });
  const paused = mapWebhookResult({ kind: 'response', status: 400, body: '{"success":false,"error":"Automation 123 is disabled"}' });
  assert.deepEqual(paused.outcome, { status: 'failed', reason: 'grok_run_not_started', hint: 'routine paused — resume it in Grok Bot', retryable: false });
  const key = mapWebhookResult({ kind: 'response', status: 401, body: '{"code":"error","message":"Invalid API key"}' });
  assert.deepEqual(key.outcome, { status: 'failed', reason: 'grok_run_not_started', hint: 'routine deleted or webhook key changed — run `agentbridge add grok` again', retryable: false });
  const other = mapWebhookResult({ kind: 'response', status: 404, body: 'not found here' });
  assert.equal(other.outcome.status, 'failed'); assert.equal((other.outcome as { retryable: boolean }).retryable, false);
  assert.match(other.log!, /404: not found here/); // status and body go to the log
  const bad400 = mapWebhookResult({ kind: 'response', status: 400, body: 'bad request' });
  assert.match((bad400.outcome as { hint: string }).hint, /HTTP 400/);
  assert.equal(mapWebhookResult({ kind: 'response', status: 200, body: '{"success":false}' }).outcome.status, 'failed');
});

// ---------------------------------------------------------------- deliver

test('deliver: POSTs the thin JSON with the bearer key from the keychain; activity before the POST; no bodies in logs', async () => {
  const x = await adapter();
  const out = await x.a.deliver(item(), REF);
  assert.deepEqual(out, { status: 'handed_off', run_uuid: 'run-1' });
  assert.equal(x.calls.length, 1);
  const c = x.calls[0]!;
  assert.equal(c.url, URL_); assert.equal(c.init.method, 'POST');
  assert.equal((c.init.headers as Record<string, string>)['authorization'], 'Bearer whk_secret');
  assert.equal(c.init.body, packItem(item()).json);
  assert.ok(String(c.init.body).length <= LIMITS.grokDeliveryChars);
  assert.deepEqual(x.activity, [BOT]);
  assert.ok(x.logs.every((l) => !l.includes('Is the migration done?')));
});

test('deliver: retries resend the identical payload (same ids) — the bridge pipeline drives the backoff', async () => {
  const x = await adapter((n) => (n < 3 ? new Error('socket hang up') : ok()));
  const r1 = await x.a.deliver(item(), REF); const r2 = await x.a.deliver(item(), REF); const r3 = await x.a.deliver(item(), REF);
  assert.equal(r1.status, 'failed'); assert.equal((r1 as { retryable: boolean }).retryable, true); assert.equal(r2.status, 'failed');
  assert.equal(r3.status, 'handed_off');
  assert.equal(new Set(x.calls.map((c) => c.init.body)).size, 1);
});

test('deliver: per-bot hourly cap backstop → queued (rate_limited), never dropped; frees up after an hour', async () => {
  const x = await adapter(ok, { perHourCap: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await x.a.deliver(item(), REF)).status, 'handed_off');
  const held = await x.a.deliver(item(), REF);
  assert.equal(held.status, 'queued'); assert.equal((held as { reason: string }).reason, 'rate_limited');
  assert.equal(x.calls.length, 3); // not posted
  x.advance(3600_001);
  assert.equal((await x.a.deliver(item(), REF)).status, 'handed_off');
  // failed POSTs do not count toward the cap
  const y = await adapter(() => new Response('', { status: 503 }), { perHourCap: 1 });
  await y.a.deliver(item(), REF); await y.a.deliver(item(), REF);
  assert.equal(y.calls.length, 2); assert.equal(y.a.sentLastHour(BOT), 0);
  assert.equal(LIMITS.grokDeliveriesPerHour, 60);
});

test('deliver: unknown bot or missing webhook secrets fail without a POST', async () => {
  const x = await adapter();
  const unknown = await x.a.deliver(item(), { ...REF, participant_id: 'other' });
  assert.equal(unknown.status, 'failed'); assert.equal((unknown as { hint: string }).hint, HINTS.unknownBot);
  await x.secrets.delete(SECRET_NAMES.webhookKey(BOT));
  const nokey = await x.a.deliver(item(), REF);
  assert.deepEqual(nokey, { status: 'failed', reason: 'grok_run_not_started', hint: HINTS.notConfigured, retryable: false });
  assert.equal(x.calls.length, 0);
});

test('capabilities and describe', async () => {
  const x = await adapter();
  assert.deepEqual(x.a.capabilities(), { receive: 'webhook', native_confirm: false, delivery_confirmable: false });
  assert.equal(x.a.describe().agent, 'grok');
});

// ---------------------------------------------------------------- doctor

test('doctor: secrets present, webhook URL shape, reachability via HEAD (never POST)', async () => {
  const x = await adapter(() => new Response(null, { status: 405 }));
  const checks = await x.a.doctor();
  assert.deepEqual(checks.map((c) => [c.id, c.ok]), [['grok:researcher:secrets', true], ['grok:researcher:webhook_url', true], ['grok:researcher:webhook_reachable', true]]);
  assert.equal(x.calls[0]!.init.method, 'HEAD');
  await x.secrets.set(SECRET_NAMES.webhookUrl(BOT), 'http://api2.cursor.sh/x'); await x.secrets.delete(SECRET_NAMES.botToken(BOT));
  const bad = await x.a.doctor();
  assert.equal(bad[0]!.ok, false); assert.match(bad[0]!.detail, /bot token/);
  assert.equal(bad[1]!.ok, false); assert.match(bad[1]!.detail, /https/);
  const down = await adapter(() => new Error('getaddrinfo ENOTFOUND'));
  assert.equal((await down.a.doctor()).at(-1)!.ok, false);
  const none = new GrokAdapter({ secrets: new Secrets(), botIdFor: () => null });
  assert.deepEqual((await none.doctor()).map((c) => c.ok), [true]);
});

test('webhook URL problems', () => {
  assert.equal(webhookUrlProblem(URL_), null);
  assert.match(webhookUrlProblem('not a url')!, /valid/);
  assert.match(webhookUrlProblem('https://user:pw@api2.cursor.sh/x')!, /credentials/);
  assert.match(webhookUrlProblem('https://localhost/x')!, /host/);
});

// ---------------------------------------------------------------- ids

test('bot ids match zBotId; tokens are 256-bit; hash and constant-time match', () => {
  const ids = new Set(Array.from({ length: 50 }, mintBotId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.ok(zBotId.safeParse(id).success, id);
  const t = mintBotToken();
  assert.equal(Buffer.from(t, 'base64url').length, 32);
  assert.equal(botTokenHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(tokenMatchesHash(t, botTokenHash(t)));
  assert.ok(!tokenMatchesHash(`${t}x`, botTokenHash(t)));
  assert.ok(!tokenMatchesHash(t, 'nothex'));
});

test('C1: packing never fails on size — 40 messages and 20 long notices keep the newest stubs, truncated, ≤ 3,500', () => {
  const msgs = Array.from({ length: 40 }, (_, i) => ({ message_id: `01JD00000000000000000M${String(i).padStart(4, '0')}`, seq: 100 + i, from_address: 'claude:a-rather-long-session-name-here', body: 'x'.repeat(2000), created_at: '2026-11-22T12:00:00.000Z', in_reply_to: '01JD0000000000000000000R00' }));
  const notes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, code: 'grok_cap', severity: 'warning' as const, parts: [], text: `${i} ${'y'.repeat(400)}` }));
  const p = packItem(item({ messages: msgs, notices: notes, reply_to: msgs.at(-1)!.message_id }));
  assert.ok(p.json.length <= LIMITS.grokDeliveryChars && Buffer.byteLength(p.json) <= LIMITS.grokDeliveryChars);
  assert.equal(p.payload.truncated, true); assert.equal(p.payload.end, DELIVERY_END); assert.equal(Object.keys(p.payload).at(-1), 'end');
  assert.ok(p.payload.messages.length >= 1 && p.payload.messages.length < 40);
  assert.equal(p.payload.messages.at(-1)!.message_id, msgs.at(-1)!.message_id); // newest kept
  assert.equal(p.payload.reply_to, msgs.at(-1)!.message_id);
  // only notices, far too many: oldest dropped, still packs
  const onlyNotices = packItem(item({ messages: [], reply_to: null, notices: Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, code: 'ended', severity: 'info' as const, parts: [], text: `${i} ${'z'.repeat(300)}` })) }));
  assert.ok(onlyNotices.json.length <= LIMITS.grokDeliveryChars);
  assert.equal(onlyNotices.payload.notices.at(-1)!.text.startsWith('59 '), true);
});
