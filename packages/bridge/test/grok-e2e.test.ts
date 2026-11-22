// End to end (§19.2) on the real service: CLI `add grok` over IPC → relay register → webhook round trip; then
// Claude (fake adapter) ↔ Grok through a local fake webhook server and the relay link, in both directions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { DELIVERY_END, LIMITS, SECRET_NAMES, ulid, type DeliveryPayload } from '@agentbridge/protocol';
import { FakeAdapter } from '@agentbridge/adapter-fake';
import { startBridge, type BridgeService } from '../src/service.ts';
import { MemorySecretStore } from '../src/policy/integrity.ts';
import { IpcClient } from '../src/ipc/client.ts';
import { addGrokFlow, type Io } from '../src/cli/grok.ts';
import { RecordingNotifier, ScriptedPresence } from './helpers.ts';
import { ScriptedPeer } from './ipc-helpers.ts';
import { ENDPOINT, FakeTransport, relayCall, result, simulateRun } from './grok-helpers.ts';

interface Hook { auth: string | undefined; body: string; payload: DeliveryPayload }

async function until(pred: () => boolean, ms = 15_000): Promise<void> { // returns as soon as pred holds
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
}
const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve) => { let b = ''; req.setEncoding('utf8'); req.on('data', (c: string) => { b += c; }); req.on('end', () => resolve(b)); });

async function world() {
  const root = mkdtempSync('/tmp/ab-g-');
  const secrets = new MemorySecretStore(); const presence = new ScriptedPresence(); const notifier = new RecordingNotifier();
  const transport = new FakeTransport(); const fake = new FakeAdapter();
  const hooks: Hook[] = [];
  let svc!: BridgeService;
  /** What the simulated routine run does with each delivery; `null` = nothing (run started, never calls back). */
  const routine = { auto: true, runs: [] as Promise<unknown>[] };
  const server: Server = createServer((req, res) => {
    void readBody(req).then(async (body) => {
      const payload = JSON.parse(body) as DeliveryPayload;
      hooks.push({ auth: req.headers.authorization, body, payload });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, runUuid: `run-${hooks.length}` }));
      if (!routine.auto) return;
      const key = req.headers.authorization?.replace('Bearer ', '');
      for (const b of svc.store.bots()) {
        if ((await secrets.get(SECRET_NAMES.webhookKey(b.bot_id))) !== key) continue;
        const token = (await secrets.get(SECRET_NAMES.botToken(b.bot_id)))!;
        // a real run calls back ~17 s after the POST (M0 V7a), long after the webhook answer was processed
        const first = payload.messages[0]?.message_id;
        await until(() => !first || !svc.store.message(first) || ['handed_off', 'delivered'].includes(svc.store.message(first)!.status));
        routine.runs.push(simulateRun(svc.relay, { botId: b.bot_id, token }, payload, { alwaysRead: true, reply: (_p, full) => `Grok says: got ${full.length} message(s), last "${full.at(-1)?.body.slice(0, 30)}"` }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const grokFetch = ((url: string | URL | Request, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, init)) as typeof fetch;
  svc = await startBridge({
    root, secrets, presence, notifier, peer: new ScriptedPeer(), adapters: { fake }, registerWaitMs: 0, onStopRequested: () => {},
    relay: { transport, endpoint: ENDPOINT }, grokFetch, grokRoundTripMs: 5_000,
  });
  return {
    svc, secrets, presence, transport, fake, hooks, routine,
    async close() { await Promise.allSettled(routine.runs); await svc.stop(); await new Promise((r) => server.close(r)); rmSync(root, { recursive: true, force: true }); },
  };
}

class ScriptIo implements Io {
  readonly out: string[] = []; readonly copies: string[] = [];
  private readonly answers: string[]; private readonly hidden: string[];
  constructor(answers: string[], hidden: string[]) { this.answers = answers; this.hidden = hidden; }
  print(s: string): void { this.out.push(s); }
  async prompt(q: string): Promise<string> { const a = this.answers.shift(); if (a === undefined) throw new Error(`unexpected prompt ${q}`); return a; }
  async promptHidden(q: string): Promise<string> { const a = this.hidden.shift(); if (a === undefined) throw new Error(`unexpected hidden prompt ${q}`); return a; }
  async copy(t: string): Promise<boolean> { this.copies.push(t); return true; }
  async paste(): Promise<string | null> { return this.copies.at(-1) ?? null; }
}

/** `agentbridge add grok` through the real IPC socket (privileged: presence checked by the bridge). */
async function addGrokViaCli(w: Awaited<ReturnType<typeof world>>): Promise<{ botId: string; token: string; pid: string }> {
  const io = new ScriptIo(['researcher', '', '', '', 'y'], ['https://api2.cursor.sh/v1/automations/webhook/abc', 'whk_test_key']);
  const call = async (m: string, p: unknown, t?: number): Promise<unknown> => {
    const c = await IpcClient.open(w.svc.paths.socket, 'cli');
    try { return await c.request(m, p, t); } finally { c.close(); }
  };
  assert.equal(await addGrokFlow(call, io), 0, io.out.join('\n'));
  assert.ok(io.out.some((l) => /✓ Round trip works/.test(l)));
  const b = w.svc.store.bots()[0]!;
  return { botId: b.bot_id, token: (await w.secrets.get(SECRET_NAMES.botToken(b.bot_id)))!, pid: b.participant_id };
}

test('e2e: add grok over IPC (presence, relay register, webhook round trip), then Claude → Grok → reply back to Claude', async () => {
  const w = await world();
  try {
    const bot = await addGrokViaCli(w);
    assert.match(w.presence.reasons.join('\n'), /add a Grok bot/);
    assert.equal(w.presence.reasons.length, 1); // one presence check for the whole flow
    assert.deepEqual(w.transport.controls.map((c) => c.method), ['register_bot']);
    assert.equal(w.hooks.length, 1); // the round-trip test delivery
    assert.equal(w.svc.store.conversations().length, 0);

    const claude = w.svc.engine.registerLocal({ name: 'auth-refactor' });
    const tool = (name: string, p: unknown) => w.svc.engine.callTool(claude, `tool.${name}`, p);
    const activeBefore = w.transport.active;
    const s = await tool('bridge_start_conversation', { peer: 'grok:researcher', topic: 'auth refactor', first_message: 'Which token lifetime do you recommend?' });
    assert.equal(s.status, 'pending_approval');
    const c = await tool('bridge_confirm', s.approval);
    assert.equal(c.status, 'handed_off');
    const cid = c.conversation_id!;

    // delivery POSTed: thin, end last, bearer webhook key
    await until(() => w.hooks.length === 2);
    const h = w.hooks[1]!;
    assert.equal(h.auth, 'Bearer whk_test_key');
    assert.ok(h.body.length <= LIMITS.grokDeliveryChars);
    assert.equal(Object.keys(h.payload).at(-1), 'end'); assert.equal(h.payload.end, DELIVERY_END);
    assert.equal(h.payload.conversation.id, cid); assert.equal(h.payload.messages[0]!.body, 'Which token lifetime do you recommend?');
    assert.equal(w.svc.store.deliveriesOf(cid).find((d) => d.participant_id === bot.pid)!.run_uuid, 'run-2');

    // simulated run: bridge_get_messages + bridge_send → reply delivered to Claude
    await until(() => w.fake.bodies(claude.participant_id).length === 1);
    assert.match(w.fake.bodies(claude.participant_id)[0]!, /^Grok says: got 1 message\(s\), last "Which token lifetime/);
    assert.ok(w.transport.active >= activeBefore + 3); // delivery + 2 calls kept the relay connection active (§13.2)

    // serialized: two local messages while Grok is busy go out together after its reply
    w.routine.auto = false;
    await tool('bridge_send', { conversation_id: cid, body: 'And refresh tokens?' });
    await until(() => w.hooks.length === 3);
    const held = await tool('bridge_send', { conversation_id: cid, body: 'Also: rotation?' });
    assert.equal(held.status, 'queued');
    const third = await tool('bridge_send', { conversation_id: cid, body: 'And revocation?' });
    assert.equal(third.status, 'queued');
    w.routine.auto = true;
    await simulateRun(w.svc.relay, bot, w.hooks[2]!.payload, { alwaysRead: true });
    await until(() => w.hooks.length === 4);
    assert.deepEqual(w.hooks[3]!.payload.messages.map((m) => m.body), ['Also: rotation?', 'And revocation?']);
    await until(() => w.fake.bodies(claude.participant_id).length === 3);
    // Grok ends it; Claude gets the summary
    assert.equal(result(await relayCall(w.svc.relay, bot, 'bridge_end_conversation', { conversation_id: cid }))['status'], 'delivered');
    await until(() => w.fake.noticeCodes(claude.participant_id).includes('ended'));
  } finally { await w.close(); }
});

test('e2e: Grok-initiated start → local approval → first message delivered; the reply reaches Grok with the acceptance', async () => {
  const w = await world();
  try {
    const bot = await addGrokViaCli(w);
    const claude = w.svc.engine.registerLocal({ name: 'auth-refactor' });
    const id = ulid();
    const r = result(await relayCall(w.svc.relay, bot, 'bridge_start_conversation', { peer: 'fake:auth-refactor', topic: 'migration status', first_message: 'Is the DB migration finished?', conversation_id: id }));
    assert.deepEqual([r['status'], r['conversation_id']], ['awaiting_local_approval', id]);
    await until(() => w.fake.noticeCodes(claude.participant_id).includes('invite'));
    assert.equal(w.fake.bodies(claude.participant_id).length, 0); // first message withheld until approval
    const n = w.fake.inbox(claude.participant_id).flatMap((i) => i.notices).find((x) => x.code === 'invite')!;
    const text = n.parts.map((p) => p.text).join('\n');
    const facts = { approval_id: /approval_id=([0-9A-Z]{26})/.exec(text)![1]!, kind: 'accept', peer: 'grok:researcher', direction: 'incoming', topic: 'migration status', turn_limit: 30 };
    const acc = await w.svc.engine.callTool(claude, 'tool.bridge_confirm', facts);
    assert.equal(acc.status, 'delivered');
    await until(() => w.fake.bodies(claude.participant_id).length === 1);
    assert.deepEqual(w.fake.bodies(claude.participant_id), ['Is the DB migration finished?']);
    const hooksBefore = w.hooks.length;
    await w.svc.engine.callTool(claude, 'tool.bridge_send', { conversation_id: id, body: 'Yes, finished an hour ago.' });
    await until(() => w.hooks.length === hooksBefore + 1);
    const p = w.hooks.at(-1)!.payload;
    assert.deepEqual(p.notices.map((x) => x.code), ['accepted']);
    assert.equal(p.messages[0]!.body, 'Yes, finished an hour ago.');
    assert.equal(p.conversation.state, 'active');
    await until(() => w.fake.bodies(claude.participant_id).length === 2); // the run replied
  } finally { await w.close(); }
});
