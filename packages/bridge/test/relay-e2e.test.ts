// End to end through a real local relay (PR #3, in-memory store): `init` registers the identity, the bridge service starts
// its on-demand relay client, and simulated Grok MCP `tools/call`s travel relay → bridge → engine → relay → Grok:
// a live `bridge_list_agents`, then a `bridge_send` held by the relay while the bridge is idle and picked up via /v1/pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { botTokenHash, grokMcpPath } from '@agentbridge/protocol';
import { createRelay, MemoryStore } from '@agentbridge/relay';
import { FakeAdapter } from '@agentbridge/adapter-fake';
import { MemorySecretStore } from '../src/policy/integrity.ts';
import { runInit, type InitDeps } from '../src/init/init.ts';
import { localPolicy } from '../src/init/deps.ts';
import { resolvePaths } from '../src/paths.ts';
import { acquireLock, startBridge } from '../src/service.ts';
import { startServiceRelay } from '../src/relay/attach.ts';
import { ScriptedPresence } from './helpers.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000): Promise<void> { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('until: timed out'); await sleep(20); } }

let rpc = 0;
async function grokCall(url: string, userId: string, botId: string, token: string, name: string, args: Record<string, unknown>): Promise<{ status: number; isError: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url + grokMcpPath(userId, botId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  const text = body.result?.content?.[0]?.text ?? '';
  let data: Record<string, unknown> = { text }; try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* plain text */ }
  return { status: res.status, isError: body.result?.isError === true, data };
}

test('e2e: init → bridge service ↔ local relay ↔ simulated Grok MCP calls (live and held)', async () => {
  const relay = createRelay({ store: new MemoryStore(), keyPrefix: 'e2e:', pollMs: 200, responseWaitMs: 1500 });
  await new Promise<void>((r) => relay.server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
  const root = mkdtempSync('/tmp/ab-e2e-'); const paths = resolvePaths(join(root, 'ab'));
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const secrets = new MemorySecretStore(); const presence = new ScriptedPresence();
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const lines: string[] = [];
  let svc: Awaited<ReturnType<typeof startBridge>> | null = null;
  let rt: Awaited<ReturnType<typeof startServiceRelay>> = null;
  try {
    // 1. init against the local relay (fakes for claude and launchd; real HTTP to the relay)
    const deps: InitDeps = {
      claude: async (args) => ({ code: 0, stdout: args[0] === '--version' ? '2.1.340 (Claude Code)' : 'ok', stderr: '' }),
      secrets, presence, policy: () => localPolicy(paths, secrets),
      service: { status: async () => 'not_installed', install: async () => {}, stopManaged: async () => {}, startManaged: async () => {}, plistMatches: async () => false, job: async () => null, kickstart: async () => {} },
      lockPid: () => null,
      startBridge: async () => {}, stopForeignBridge: async () => false, marker: { write: () => {}, remove: () => {} },
      bridgeRunning: async () => false, stopBridge: async () => {}, waitForBridge: async () => true,
      doctor: async () => [], lock: () => { mkdirSync(paths.runDir, { recursive: true, mode: 0o700 }); return acquireLock(paths.lock); },
      fetch, prompt: { choose: async (_q, _o, d) => d }, print: (l) => lines.push(l),
      marketplace: '/repo', claudeSettingsPath: join(root, 'claude', 'settings.json'),
      settings: { env: { HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude') }, managedDir: join(root, 'managed') }, home,
      service_entry: { entry: null, logDir: paths.logsDir },
      launchPaths: () => ({ nodePath: process.execPath, nodeVersioned: false, claudePath: null, path: '/usr/bin', environment: { PATH: '/usr/bin' } }),
    };
    const report = await runInit(deps, { relayUrl: url, yes: true, skipService: true });
    assert.ok(report.ok, lines.join('\n'));
    assert.equal(report.steps.find((x) => x.id === 'doctor')!.skipped, true); // no bridge running yet (--skip-service)
    assert.ok(lines.some((l) => /registered with http:\/\/127\.0\.0\.1/.test(l)));
    const userId = report.userId!;

    // 2. the bridge service + its on-demand relay client (fast polls for the test)
    const grok = new FakeAdapter({ agent: 'grok' }); const local = new FakeAdapter();
    svc = await startBridge({ root: paths.root, secrets, presence, notifier: { notify: async () => {} }, registerWaitMs: 0, onStopRequested: () => {}, adapters: { grok, fake: local } });
    rt = await startServiceRelay(svc, secrets, { clientOptions: { pendingPollMs: 100, activeWindowMs: 300, ensureGraceMs: 200 } });
    assert.ok(rt); assert.equal(rt.client.connected, false); // on demand: idle until needed

    // 3. a bot, registered with the relay through RelayLink.control (connects just for the call)
    const botId = 'e2ebot001'; const token = 'e2e-token-0123456789abcdefghijklmnopqrstuvw';
    const bot = svc.engine.createBot({ name: 'researcher', bot_id: botId, token_hash: botTokenHash(token) });
    await svc.relay.control('register_bot', { bot_id: botId, token_hash: botTokenHash(token), discovery: 'names' });
    const alice = svc.engine.registerLocal({ name: 'alice' });

    // 4. live call: Grok lists agents; the idle client connects via the pending check and answers within the wait
    const list = await grokCall(url, userId, botId, token, 'bridge_list_agents', {});
    assert.equal(list.isError, false, JSON.stringify(list));
    assert.ok(JSON.stringify(list.data).includes('fake:alice'), JSON.stringify(list.data));
    // wrong token: refused at the relay
    const bad = await grokCall(url, userId, botId, 'wrong-token-wrong-token-wrong-token-wrong', 'bridge_list_agents', {});
    assert.equal(bad.status === 401 || bad.isError, true);

    // 5. a conversation alice → Grok (Grok auto-accepts; first message goes to the fake Grok adapter)
    const r = await svc.engine.callTool(alice, 'tool.bridge_start_conversation', { peer: 'grok:researcher', topic: 'migration', first_message: 'Is it done?' });
    const ok = await svc.engine.callTool(alice, 'tool.bridge_confirm', r.approval);
    assert.equal(ok.status, 'delivered'); const cid = ok.conversation_id!;
    await until(() => grok.inbox(bot.id).length === 1);

    // 6. held call: the bridge's relay client is stopped, so the relay holds Grok's reply (held_relay)
    await rt.stop(); rt = null;
    const held = await grokCall(url, userId, botId, token, 'bridge_send', { conversation_id: cid, body: 'Yes, done yesterday.' });
    assert.equal(held.data['status'], 'held_relay', JSON.stringify(held.data));
    // the bridge comes back idle; /v1/pending reports the entry, the client connects and the engine accepts it
    rt = await startServiceRelay(svc, secrets, { clientOptions: { pendingPollMs: 100, activeWindowMs: 300, ensureGraceMs: 200 } });
    await until(() => svc!.store.messages(cid).some((m) => m.body === 'Yes, done yesterday.'));
    await until(() => local.bodies(alice.participant_id).includes('Yes, done yesterday.')); // and back to the local side
    assert.equal(svc.store.messages(cid).filter((m) => m.body === 'Yes, done yesterday.').length, 1);
    // the cursor advanced past the held entry (acked), so a restart does not redeliver it
    assert.ok(svc.store.kvGet('relay.cursor'));
  } finally {
    try { await rt?.stop(); } catch { /* stopping */ }
    try { await svc?.stop(); } catch { /* stopping */ }
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  }
});
