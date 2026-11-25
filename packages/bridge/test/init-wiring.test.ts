// init, identity, policy transport keys, doctor and relay-runtime wiring — all against fakes in temp dirs
// (never the real ~/.claude, LaunchAgents or login keychain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { verify as edVerify, createPublicKey } from 'node:crypto';
import { SECRET_NAMES, userIdFromPubkey, type DoctorCheck } from '@agentbridge/protocol';
import { DENY_RULES } from '@agentbridge/adapter-claude-code';
import { openDatabase, schemaVersion } from '../src/db/db.ts';
import { Store } from '../src/db/store.ts';
import { PolicyStore, MemorySecretStore, policyMac } from '../src/policy/integrity.ts';
import { applySetting, DEFAULT_POLICY, canonicalJson } from '../src/policy/policy.ts';
import { ensureIdentity, loadIdentity, signerFor, x25519Statement, IdentityCorruptError } from '../src/relay/identity.ts';
import { runInit, PLUGIN_ID, type InitDeps, type CommandResult } from '../src/init/init.ts';
import { localPolicy, findMarketplace } from '../src/init/deps.ts';
import { parseInitArgs } from '../src/cli/main.ts';
import { platformDoctor } from '../src/doctor.ts';
import { handleCli } from '../src/ipc/cli-methods.ts';
import { RelayRuntime, KV, type RelayClientLike, type RelayClientOptionsLike } from '../src/relay/runtime.ts';
import { resolvePaths } from '../src/paths.ts';
import { acquireLock, AlreadyRunningError, startBridge } from '../src/service.ts';
import { harness, ScriptedPresence } from './helpers.ts';
import { RelayLink } from '../src/relay/link.ts';
import { addBot, result } from './grok-helpers.ts';

const tmp = (): string => mkdtempSync('/tmp/ab-init-');

test('policy: transport.relay_mode / max_connected_hours_per_day default for rows signed before they existed', async () => {
  const store = new Store(openDatabase(':memory:')); const secrets = new MemorySecretStore();
  const ps = new PolicyStore(store, secrets); await ps.load();
  // rewrite the stored transport row as an older bridge signed it (no new keys), with a valid HMAC
  const rows = store.policyRows().map((r) => (r.key === 'transport' ? { key: r.key, value: canonicalJson({ relay_url: 'https://relay.musi.live' }) } : r)).filter((r) => r.key !== '_hmac');
  const key = Buffer.from((await secrets.get(SECRET_NAMES.policyHmacKey))!, 'base64');
  rows.push({ key: '_hmac', value: policyMac(key, 1, rows) });
  store.replacePolicy(rows);
  const again = new PolicyStore(store, secrets); const s = await again.load();
  assert.ok(s.ok, JSON.stringify(s));
  assert.equal(again.policy().transport.relay_mode, 'on_demand');
  assert.equal(again.policy().transport.max_connected_hours_per_day, 6);
  await again.set(applySetting(again.policy(), 'transport.relay_mode', 'always'));
  assert.match(store.policyRows().find((r) => r.key === 'transport')!.value, /"relay_mode":"always"/);
  assert.throws(() => applySetting(DEFAULT_POLICY, 'transport.max_connected_hours_per_day', '25'));
  assert.throws(() => applySetting(DEFAULT_POLICY, 'transport.relay_mode', 'sometimes'));
});

test('storage: migration 2 adds the kv table', () => {
  const db = openDatabase(':memory:'); const store = new Store(db);
  assert.ok(schemaVersion(db) >= 2);
  assert.equal(store.kvGet('x'), undefined);
  store.kvSet('x', '1'); store.kvSet('x', '2');
  assert.equal(store.kvGet('x'), '2');
});

test('identity: created once in the SecretStore, reloaded identically, signs verifiably; partial keys refused', async () => {
  const secrets = new MemorySecretStore();
  const a = await ensureIdentity(secrets); assert.equal(a.created, true);
  const b = await ensureIdentity(secrets); assert.equal(b.created, false);
  assert.equal(a.identity.userId, b.identity.userId);
  assert.equal(a.identity.userId, userIdFromPubkey(a.identity.ed25519.publicKey));
  assert.equal(a.identity.x25519.publicKey.length, 32);
  const msg = x25519Statement(a.identity.userId, 'abc');
  const sig = signerFor(b.identity).sign(msg);
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(a.identity.ed25519.publicKey).toString('base64url') }, format: 'jwk' });
  assert.ok(edVerify(null, msg, pub, sig));
  await secrets.delete(SECRET_NAMES.ed25519);
  await assert.rejects(loadIdentity(secrets), IdentityCorruptError);
});

interface FakeWorld {
  events: string[];
  deps: InitDeps; paths: ReturnType<typeof resolvePaths>; presence: ScriptedPresence; lines: string[]; claudeCalls: string[][]; installs: number; stopped: string[]; secrets: MemorySecretStore;
  relayPosts: Array<Record<string, string>>; root: string; settingsPath: string; cleanup(): void;
}

function world(o: { claude?: (args: string[]) => CommandResult | Error; relayStatus?: () => number; running?: 'managed' | 'manual' | false; presenceOk?: boolean; foreign?: (pid: number) => boolean } = {}): FakeWorld {
  const root = tmp(); const paths = resolvePaths(join(root, 'ab'));
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const settingsPath = join(root, 'claude', 'settings.json');
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const secrets = new MemorySecretStore(); const presence = new ScriptedPresence();
  if (o.presenceOk === false) presence.answer = { ok: false, code: 'cancelled' };
  const w: FakeWorld = { events: [], deps: null as unknown as InitDeps, paths, presence, lines: [], claudeCalls: [], installs: 0, stopped: [], secrets, relayPosts: [], root, settingsPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  let running = o.running ?? false; let installed = o.running === 'managed' ? 'old' : '';
  const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/identity') {
      const body = JSON.parse(String(init!.body)) as Record<string, string>; w.relayPosts.push(body);
      const status = o.relayStatus?.() ?? (w.relayPosts.length === 1 ? 201 : 200);
      const ed = Buffer.from(body['ed25519_pub']!, 'base64');
      return new Response(JSON.stringify(status >= 400 ? { success: false, error: { code: 'conflict', message: 'Identity exists with other keys; use rotate_identity.' } } : { user_id: userIdFromPubkey(ed), created: status === 201 }), { status });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  w.deps = {
    claude: async (args) => { w.claudeCalls.push(args); const r = o.claude?.(args); if (r instanceof Error) throw r; return r ?? (args[0] === '--version' ? { code: 0, stdout: '2.1.340 (Claude Code)\n', stderr: '' } : { code: 0, stdout: 'ok', stderr: '' }); },
    secrets, presence,
    policy: () => localPolicy(paths, secrets),
    service: {
      status: async () => (running === 'managed' ? 'running' : w.installs ? 'stopped' : 'not_installed'),
      install: async (opts) => { w.installs++; running = 'managed'; installed = JSON.stringify(opts); },
      stopManaged: async () => { w.stopped.push('managed'); running = false; },
      startManaged: async () => { w.events.push('startManaged'); running = 'managed'; },
      plistMatches: async (opts) => installed === JSON.stringify(opts),
      job: async () => (running === 'managed' ? { state: 'running', pid: 4242 } : w.installs ? { state: 'not running', pid: null } : null),
      kickstart: async () => { w.events.push('kickstart'); running = 'managed'; },
    },
    lockPid: () => (running === 'managed' ? 4242 : running === 'manual' ? 5151 : null),
    bridgeRunning: async () => running !== false,
    stopBridge: async () => { w.stopped.push('manual'); running = false; },
    startBridge: async () => { w.events.push('startBridge'); running = 'manual'; },
    stopForeignBridge: async (pid) => { w.events.push(`stopForeign:${pid}`); return o.foreign?.(pid) ?? false; },
    marker: { write: () => w.events.push('marker+'), remove: () => w.events.push('marker-') },
    sleep: async () => {},
    waitForBridge: async () => true,
    lock: () => { mkdirSync(paths.runDir, { recursive: true, mode: 0o700 }); return acquireLock(paths.lock); },
    doctor: async (): Promise<DoctorCheck[]> => [{ id: 'policy', ok: true, detail: 'ok' }],
    fetch: fakeFetch,
    prompt: { choose: async (_q, _opts, def) => def },
    print: (l) => w.lines.push(l),
    marketplace: '/repo/agentbridge', claudeSettingsPath: settingsPath, settings: { env: { HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude') }, managedDir: join(root, 'managed') }, home,
    service_entry: { entry: '/repo/packages/bridge/dist/cli/service-main.js', logDir: paths.logsDir },
    launchPaths: () => ({ nodePath: '/opt/homebrew/bin/node', nodeVersioned: false, claudePath: '/Users/x/.local/bin/claude', path: '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin', environment: { PATH: '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin', AGENTBRIDGE_CLAUDE_BIN: '/Users/x/.local/bin/claude' } }),
  };
  return w;
}

test('init: fresh setup runs every step and writes only into the temp home', async () => {
  const w = world();
  try {
    const r = await runInit(w.deps, { relayUrl: 'https://relay.example.test', mode: 'per_conversation' });
    assert.ok(r.ok, w.lines.join('\n'));
    assert.deepEqual(r.steps.map((s) => s.id), ['claude_code', 'plugin', 'deny_rules', 'cross_session_inbound', 'presence', 'plan', 'identity', 'relay', 'approval_mode', 'service', 'doctor']);
    assert.deepEqual(w.claudeCalls, [['--version'], ['plugin', 'marketplace', 'add', '/repo/agentbridge'], ['plugin', 'install', PLUGIN_ID, '--scope', 'user']]);
    const settings = JSON.parse(readFileSync(w.settingsPath, 'utf8')) as { permissions: { deny: string[] } };
    for (const rule of DENY_RULES) assert.ok(settings.permissions.deny.includes(rule), rule);
    const id = await loadIdentity(w.secrets);
    assert.equal(r.userId, id!.userId);
    assert.equal(w.relayPosts.length, 1);
    assert.equal(w.relayPosts[0]!['x25519_pub'], Buffer.from(id!.x25519.publicKey).toString('base64'));
    const pol = await (await w.deps.policy()).get();
    assert.equal(pol.transport.relay_url, 'https://relay.example.test');
    assert.equal(w.installs, 1);
    assert.ok(w.lines.some((l) => /agentbridge add grok/.test(l)));
    assert.ok(w.lines.some((l) => /First try/.test(l)));
  } finally { w.cleanup(); }
});

test('init: re-running is idempotent (same identity, no duplicate rules, managed bridge stopped and reinstalled)', async () => {
  const w = world();
  try {
    const first = await runInit(w.deps, { mode: 'auto', yes: true });
    assert.ok(first.ok, w.lines.join('\n'));
    assert.equal((await (await w.deps.policy()).get()).approval.mode, 'auto');
    const rulesBefore = readFileSync(w.settingsPath, 'utf8');
    w.lines.length = 0;
    const second = await runInit(w.deps, { yes: true });
    assert.ok(second.ok, w.lines.join('\n'));
    assert.equal(second.userId, first.userId);
    assert.equal(readFileSync(w.settingsPath, 'utf8'), rulesBefore);
    assert.deepEqual(w.stopped, []); // nothing changed: the bridge keeps running
    assert.equal(w.installs, 1); // plist already up to date
    assert.ok(w.lines.some((l) => /already set; the bridge keeps running/.test(l)));
    assert.ok(w.lines.some((l) => /launchd agent up to date/.test(l)));
    assert.ok(w.lines.some((l) => /already registered/.test(l)));
    assert.ok(w.lines.some((l) => /deny rules already present/.test(l)));
    assert.equal((await (await w.deps.policy()).get()).approval.mode, 'auto'); // --yes keeps the current mode
  } finally { w.cleanup(); }
});

test('init: failures print exact fixes; presence failure stops before any key or policy change', async () => {
  const noClaude = world({ claude: () => new Error('claude not found on PATH') });
  try {
    const r = await runInit(noClaude.deps, { yes: true });
    assert.equal(r.ok, false);
    const plugin = r.steps.find((s) => s.id === 'plugin')!;
    assert.equal(plugin.ok, false);
    assert.equal(plugin.fix, `claude plugin marketplace add /repo/agentbridge && claude plugin install ${PLUGIN_ID} --scope user`);
    assert.equal(r.steps.find((s) => s.id === 'identity')!.ok, true); // the rest still runs
  } finally { noClaude.cleanup(); }
  const denied = world({ presenceOk: false });
  try {
    const r = await runInit(denied.deps, { yes: true });
    assert.equal(r.ok, false); assert.equal(r.steps.at(-1)!.id, 'presence');
    assert.equal(await loadIdentity(denied.secrets), null);
    assert.equal(denied.installs, 0);
  } finally { denied.cleanup(); }
  const conflict = world({ relayStatus: () => 409 });
  try {
    const r = await runInit(conflict.deps, { yes: true });
    const relay = r.steps.find((s) => s.id === 'relay')!;
    assert.equal(relay.ok, false); assert.match(relay.fix!, /identity rotate/);
  } finally { conflict.cleanup(); }
  const manual = world({ running: 'manual' });
  try { await runInit(manual.deps, { yes: true }); assert.deepEqual(manual.stopped, ['manual']); } finally { manual.cleanup(); }
});

test('init: inbound hold is reported with the fix; flags parse; marketplace is found in the checkout', async () => {
  const w = world();
  try {
    writeFileSync(join(w.deps.home, '.claude-settings-placeholder'), '');
    const userSettings = join(w.root, 'home', '.claude', 'settings.json');
    mkdirSync(join(w.root, 'home', '.claude'), { recursive: true });
    writeFileSync(userSettings, JSON.stringify({ crossSessionInbound: 'hold' }));
    w.deps.settings = { env: { HOME: join(w.root, 'home'), CLAUDE_CONFIG_DIR: join(w.root, 'home', '.claude') }, managedDir: join(w.root, 'managed') };
    const r = await runInit(w.deps, { yes: true });
    const inbound = r.steps.find((s) => s.id === 'cross_session_inbound')!;
    assert.equal(inbound.ok, false); assert.ok(inbound.fix);
  } finally { w.cleanup(); }
  assert.deepEqual(parseInitArgs(['--relay', 'https://relay.example.test', '--mode', 'auto', '--yes']), { relayUrl: 'https://relay.example.test', mode: 'auto', yes: true });
  assert.throws(() => parseInitArgs(['--dev-relay'])); // no built-in development relay
  assert.deepEqual(parseInitArgs(['--relay', 'http://127.0.0.1:8787']), { relayUrl: 'http://127.0.0.1:8787' });
  assert.throws(() => parseInitArgs(['--relay', 'http://evil.example']));
  assert.throws(() => parseInitArgs(['--mode', 'manual']));
  assert.ok(findMarketplace());
});

test('doctor: platform checks (Claude adapter, helper, launchd, relay health + signed pending) reach cli.doctor', async () => {
  const secrets = new MemorySecretStore(); const { identity } = await ensureIdentity(secrets);
  const seen: string[] = [];
  const f = (async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url)); seen.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === '/v1/health') return new Response('{"ok":true}', { status: 200 });
    const h = new Headers(init?.headers);
    assert.equal(h.get('x-agentbridge-user-id'), identity.userId);
    return new Response(JSON.stringify({ success: true, data: { pending: 2, oldest_ms: 10 } }), { status: 200 });
  }) as typeof fetch;
  const checks = await platformDoctor({
    claude: async () => [{ id: 'claude_code_version', ok: true, detail: 'Claude Code 2.1.340' }],
    helper: async () => { throw new Error('agentbridge-helper missing'); },
    launchd: async () => 'not_installed',
    relay: { policy: () => DEFAULT_POLICY, secrets, fetch: f, connected: () => false },
  });
  assert.deepEqual(checks.map((c) => [c.id, c.ok]), [['claude_code_version', true], ['presence_helper', false], ['launchd', false], ['relay_health', true], ['relay_identity', true]]);
  assert.match(checks.find((c) => c.id === 'relay_identity')!.detail, /2 waiting; idle/);
  assert.deepEqual(seen, ['GET /v1/health', 'POST /v1/pending']);
  const h = await harness();
  const out = await handleCli({ engine: h.engine, doctorExtras: async () => checks }, 'cli.doctor', {});
  assert.ok((out.result as { checks: DoctorCheck[] }).checks.some((c) => c.id === 'relay_identity'));
  const broken = await handleCli({ engine: h.engine, doctorExtras: async () => { throw new Error('x'); } }, 'cli.doctor', {});
  assert.ok((broken.result as { checks: DoctorCheck[] }).checks.some((c) => c.id === 'platform_checks' && !c.ok));
  h.engine.stop();
});

class FakeRelayClient implements RelayClientLike {
  connected = false; started = 0; stopped = 0; active = 0; controls: Array<[string, unknown]> = []; attachedBeforeStart = false; o: RelayClientOptionsLike; usage: { day: string; ms: number };
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  constructor(o: RelayClientOptionsLike) { this.o = o; this.usage = o.usage ?? { day: '2026-11-22', ms: 0 }; }
  async start(): Promise<void> { this.started++; }
  async stop(): Promise<void> { this.stopped++; }
  async control(m: string, p: unknown): Promise<unknown> { this.controls.push([m, p]); return { ok: true }; }
  markActive(): void { this.active++; }
  async ensureConnected(): Promise<void> {}
  get connectedToday(): { day: string; ms: number } { return this.usage; }
  on(e: string, fn: (...a: unknown[]) => void): this { this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]); return this; }
  emit(e: string, ...a: unknown[]): void { for (const f of this.handlers.get(e) ?? []) f(...a); }
}

test('relay runtime: options from policy + keychain identity; cursor and usage persisted; expiry and cap handled', async () => {
  const h = await harness();
  await h.setPolicy('transport.max_connected_hours_per_day', '3');
  const secrets = new MemorySecretStore(); const { identity } = await ensureIdentity(secrets);
  h.store.kvSet(KV.usage, JSON.stringify({ day: '2026-11-22', ms: 1234 }));
  let client!: FakeRelayClient;
  const rt = await RelayRuntime.start({ engine: h.engine, store: h.store, policy: h.policy.policy(), identity, onCall: async () => ({ result: { ok: true } }), factory: (o) => (client = new FakeRelayClient(o)), usageSaveEveryMs: 1_000_000 });
  assert.equal(client.started, 1);
  assert.equal(client.o.url, 'https://relay.musi.live'); assert.equal(client.o.userId, identity.userId);
  assert.equal(client.o.mode, 'on_demand'); assert.equal(client.o.maxConnectedMsPerDay, 3 * 3600_000);
  assert.deepEqual(client.o.usage, { day: '2026-11-22', ms: 1234 });
  assert.deepEqual(Buffer.from(client.o.signer.publicKey), identity.ed25519.publicKey);
  // cursor
  assert.equal(client.o.loadCursor(), undefined);
  client.o.saveCursor('1700000000000-3'); assert.equal(client.o.loadCursor(), '1700000000000-3');
  assert.equal(h.store.kvGet(KV.cursor), '1700000000000-3');
  // usage saved on stop
  client.usage = { day: '2026-11-23', ms: 99 };
  // expiry → notice-only delivery to the Grok side of affected conversations + popup
  const bot = h.engine.createBot({ name: 'researcher', bot_id: 'bot00001', token_hash: 'h' });
  const c = h.engine.registerLocal({ name: 'alice' });
  const r = await h.tool(c, 'bridge_start_conversation', { peer: 'grok:researcher', topic: 't', first_message: 'q' });
  const ok = await h.tool(c, 'bridge_confirm', r.approval);
  await client.o.onExpiry([{ req_id: 'r1', method: 'bridge_send', conversation_id: ok.conversation_id }, { req_id: 'r2', method: 'bridge_start_conversation' }]);
  await h.idle();
  const last = h.grok.inbox(bot.id).at(-1)!;
  assert.deepEqual(last.messages, []); assert.deepEqual(last.notices.map((n) => n.code), ['relay_expired']);
  assert.ok(h.store.unshownPopups().some((p) => p.type === 'popup:relay_expired'));
  // cap reached → must-act popup kept for the next status
  client.emit('cap_reached', { connectedMs: 3 * 3600_000, capMs: 3 * 3600_000 });
  await h.idle();
  const cap = h.store.unshownPopups().find((p) => p.type === 'popup:relay_cap_reached')!;
  assert.match(JSON.parse(cap.data).body, /3 h limit/);
  await rt.stop();
  assert.equal(client.stopped, 1);
  assert.deepEqual(JSON.parse(h.store.kvGet(KV.usage)!), { day: '2026-11-23', ms: 99 });
  h.engine.stop();
});

test('relay runtime → RelayLink: attached before start; Grok calls reach the engine; control and markActive go to the client', async () => {
  const h = await harness();
  const secrets = new MemorySecretStore(); const { identity } = await ensureIdentity(secrets);
  const link = new RelayLink({ engine: h.engine });
  assert.equal(link.configured, false);
  let client!: FakeRelayClient;
  const rt = await RelayRuntime.start({
    engine: h.engine, store: h.store, policy: h.policy.policy(), identity,
    onCall: (c) => link.handleCall(c), beforeStart: (cl, ep) => { link.attach(cl, ep); (cl as FakeRelayClient).attachedBeforeStart = (cl as FakeRelayClient).started === 0; },
    factory: (o) => (client = new FakeRelayClient(o)), usageSaveEveryMs: 1_000_000,
  });
  assert.ok(client.attachedBeforeStart);
  assert.deepEqual(link.endpoint, { origin: 'https://relay.musi.live', userId: identity.userId });
  const bot = addBot(h.engine, 'researcher', 'bot00001');
  h.engine.registerLocal({ name: 'alice' });
  const out = await client.o.onCall({ reqId: 'r1', entryId: '1-0', call: { method: 'bridge_list_agents', params: {}, caller: bot.botId, token: bot.token, received_at: Date.now() }, held: false });
  const agents = (result<{ data?: Array<{ address: string }> }>(out).data ?? (result(out) as unknown as Array<{ address: string }>)) as Array<{ address: string }>;
  assert.ok(JSON.stringify(agents).includes('fake:alice'), JSON.stringify(out));
  assert.ok(client.active >= 1); // Grok activity keeps the on-demand connection up
  await link.control('set_discovery', { bot_id: bot.botId, mode: 'none' });
  assert.deepEqual(client.controls, [['set_discovery', { bot_id: bot.botId, mode: 'none' }]]);
  const bad = await client.o.onCall({ reqId: 'r2', call: { method: 'bridge_list_agents', params: {}, caller: bot.botId, token: 'wrong', received_at: Date.now() }, held: false });
  assert.ok(bad && 'error' in bad);
  await rt.stop(); h.engine.stop();
});

test('integrator condition 1: init holds the bridge lock while it writes; a held lock aborts with a clear message', async () => {
  const w = world();
  try {
    // a bridge trying to start mid-write (e.g. from a SessionStart hook) cannot take the lock
    let startAttempt: unknown = null;
    const set = w.secrets.set.bind(w.secrets);
    w.secrets.set = async (n, v) => { if (startAttempt === null && n.startsWith('identity.')) { try { acquireLock(w.paths.lock)(); startAttempt = 'acquired'; } catch (e) { startAttempt = e; } } return set(n, v); };
    const r = await runInit(w.deps, { yes: true });
    assert.ok(r.ok, w.lines.join('\n'));
    assert.ok(startAttempt instanceof AlreadyRunningError);
    // released afterwards (before the launchd agent starts the bridge)
    acquireLock(w.paths.lock)();
  } finally { w.cleanup(); }
  const held = world();
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: 'ignore' });
    mkdirSync(held.paths.runDir, { recursive: true }); writeFileSync(held.paths.lock, String(child.pid)); // a bridge that would not stop
    const r = await runInit(held.deps, { yes: true });
    child.kill();
    assert.equal(r.ok, false);
    const lock = r.steps.find((s) => s.id === 'lock')!;
    assert.match(lock.detail, /already running/); assert.match(lock.fix!, /agentbridge stop/);
    assert.equal(held.presence.reasons.length, 1); // presence comes first; the lock failure aborts before any write
    assert.equal(await loadIdentity(held.secrets), null);
    assert.ok(held.events.includes(`stopForeign:${child.pid}`)); // tried to stop the holder (not a bridge here: refused)
    assert.equal(held.events.at(-1), 'marker-'); // marker removed on the abort path
  } finally { held.cleanup(); }
});

test('integrator condition 2: exactly one presence check per run, before any write, with the verb-phrase reason', async () => {
  const w = world();
  try {
    let writesBeforePresence = 0;
    const set = w.secrets.set.bind(w.secrets);
    w.secrets.set = async (n, v) => { if (w.presence.reasons.length === 0) writesBeforePresence++; return set(n, v); };
    await runInit(w.deps, { mode: 'auto' });
    assert.deepEqual(w.presence.reasons, ['finish setting up on this Mac']);
    assert.equal(writesBeforePresence, 0);
  } finally { w.cleanup(); }
});

test('integrator condition 3: init re-signs policy like config set; the bridge starts without policy_tampered', async () => {
  const w = world();
  try {
    const r = await runInit(w.deps, { mode: 'auto', relayUrl: 'https://relay.example.test' });
    assert.ok(r.ok, w.lines.join('\n'));
    assert.equal(await w.secrets.get(SECRET_NAMES.policyVersion), '3'); // defaults v1 + relay_url + mode
    assert.ok(await w.secrets.get(SECRET_NAMES.policySnapshot));
    const svc = await startBridge({ root: w.paths.root, secrets: w.secrets, presence: w.presence, notifier: { notify: async () => {} }, registerWaitMs: 0, onStopRequested: () => {} });
    try {
      const st = svc.engine.policyStore.current();
      assert.ok(st.ok, JSON.stringify(st));
      assert.equal(svc.engine.policyStore.policy().approval.mode, 'auto');
      assert.equal(svc.engine.policyStore.policy().transport.relay_url, 'https://relay.example.test');
      assert.equal(svc.store.events({ type: 'policy_tampered' }).length, 0);
    } finally { await svc.stop(); }
  } finally { w.cleanup(); }
});

test('integrator condition 4: a re-run shows current values and writes only what changed, under one presence check', async () => {
  const w = world();
  try {
    await runInit(w.deps, { mode: 'per_conversation', yes: true });
    const v1 = await w.secrets.get(SECRET_NAMES.policyVersion);
    w.lines.length = 0; w.presence.reasons.length = 0;
    await runInit(w.deps, { yes: true });
    assert.equal(await w.secrets.get(SECRET_NAMES.policyVersion), v1); // nothing changed → no write
    assert.ok(w.lines.some((l) => /^current: relay https:\/\/relay\.musi\.live, approval mode per_conversation, identity [a-z2-7]{26}/.test(l)), w.lines.join('\n'));
    assert.equal(w.presence.reasons.length, 1);
    w.presence.reasons.length = 0;
    await runInit(w.deps, { yes: true, mode: 'auto' });
    assert.equal(Number(await w.secrets.get(SECRET_NAMES.policyVersion)), Number(v1) + 1); // one change → one write
    assert.equal(w.presence.reasons.length, 1);
  } finally { w.cleanup(); }
});

// ---- init vs. on-demand starts (full-install bug: a SessionStart hook restarted the bridge mid-init) ----
const lockTaken = (pid: number): Error => Object.assign(new Error(`agentbridge is already running (pid ${pid})`), { pid });

test('race: a bridge started by another session grabs the lock after init stopped it → init stops it (ours) and continues', async () => {
  const w = world({ running: 'managed', foreign: (pid) => pid === 41155 });
  try {
    await runInit(w.deps, { yes: true }); // first setup
    w.events.length = 0; w.stopped.length = 0;
    let foreignAlive = true;
    w.deps.lock = () => { if (foreignAlive) throw lockTaken(41155); return () => {}; };
    w.deps.stopForeignBridge = async (pid) => { w.events.push(`stopForeign:${pid}`); foreignAlive = false; return true; };
    const r = await runInit(w.deps, { yes: true, mode: 'auto' }); // a change: init must stop and lock
    assert.ok(r.ok, w.lines.join('\n'));
    assert.deepEqual(w.stopped, ['managed']); // bootout only (plist kept)
    assert.deepEqual(w.events, ['marker+', 'stopForeign:41155', 'marker-']);
    assert.equal((await (await w.deps.policy()).get()).approval.mode, 'auto');
    assert.equal(w.installs, 2); // restarted through launchd
  } finally { w.cleanup(); }
});

test('race: if the lock cannot be taken, init restores the previous state (launchd plist bootstrapped again) and removes the marker', async () => {
  const w = world({ running: 'managed' });
  try {
    await runInit(w.deps, { yes: true });
    w.events.length = 0;
    w.deps.lock = () => { throw lockTaken(777); }; // something that is not ours keeps the lock
    const r = await runInit(w.deps, { yes: true, mode: 'auto' });
    assert.equal(r.ok, false);
    assert.deepEqual(w.events, ['marker+', 'stopForeign:777', 'startManaged', 'marker-']);
    assert.equal(r.steps.find((s) => s.id === 'restore')!.ok, true);
    assert.equal((await (await w.deps.policy()).get()).approval.mode, 'per_conversation'); // nothing written
  } finally { w.cleanup(); }
  const m = world({ running: 'manual' });
  try {
    m.deps.lock = () => { throw lockTaken(778); };
    const r = await runInit(m.deps, { yes: true, mode: 'auto' });
    assert.equal(r.ok, false);
    assert.deepEqual(m.stopped, ['manual']);
    assert.ok(m.events.includes('startBridge')); // a manually started bridge comes back too
    assert.equal(m.events.at(-1), 'marker-');
  } finally { m.cleanup(); }
});

test('race: re-running with nothing to change neither stops the bridge nor writes the marker; a plist change only reinstalls', async () => {
  const w = world({ running: 'managed' });
  try {
    await runInit(w.deps, { yes: true });
    w.events.length = 0; w.stopped.length = 0;
    const installs = w.installs;
    const r = await runInit(w.deps, { yes: true });
    assert.ok(r.ok);
    assert.deepEqual(w.stopped, []); assert.deepEqual(w.events, []); assert.equal(w.installs, installs);
    // claude moved: the plist environment differs → marker held around a reinstall, but no stop for policy writes
    const lp0 = w.deps.launchPaths();
    w.deps.launchPaths = () => ({ ...lp0, environment: { ...lp0.environment, AGENTBRIDGE_CLAUDE_BIN: '/Users/x/new/claude' } });
    const r2 = await runInit(w.deps, { yes: true });
    assert.ok(r2.ok);
    assert.deepEqual(w.stopped, []); assert.deepEqual(w.events, ['marker+', 'marker-']); assert.equal(w.installs, installs + 1);
  } finally { w.cleanup(); }
});

test('upgrade: a running bridge on another version is restarted by init (plist unchanged, nothing to write)', async () => {
  const w = world({ running: 'managed' });
  try {
    await runInit(w.deps, { yes: true });
    let bridgeVersion = '0.2.0';
    w.deps.version = '0.2.1';
    w.deps.bridgeVersion = async () => bridgeVersion;
    w.deps.service.install = (orig => async (opts) => { await orig(opts); bridgeVersion = '0.2.1'; })(w.deps.service.install);
    w.events.length = 0; w.stopped.length = 0; w.lines.length = 0;
    const installs = w.installs;
    const r = await runInit(w.deps, { yes: true });
    assert.ok(r.ok, w.lines.join('\n'));
    assert.equal(w.installs, installs + 1, 'the launchd agent is reinstalled, which restarts the bridge');
    assert.deepEqual(w.stopped, [], 'no policy writes, so no separate stop');
    assert.deepEqual(w.events, ['marker+', 'marker-']);
    assert.match(w.lines.join('\n'), /the running bridge is 0\.2\.0; this agentbridge is 0\.2\.1/);
    assert.match(r.steps.find((s) => s.id === 'service')!.detail, /restarted on 0\.2\.1 \(was 0\.2\.0\)/);
    const plan = r.steps.find((s) => s.id === 'plan')!.detail;
    assert.match(plan, /the bridge is restarted on 0\.2\.1 below/); assert.doesNotMatch(plan, /keeps running/);
    // same version again: nothing restarts
    const again = await runInit(w.deps, { yes: true });
    assert.ok(again.ok); assert.equal(w.installs, installs + 1);
    assert.match(again.steps.find((s) => s.id === 'service')!.detail, /up to date and running/);
    assert.match(again.steps.find((s) => s.id === 'plan')!.detail, /the bridge keeps running/);
  } finally { w.cleanup(); }
});

test('upgrade: with --skip-service a bridge on another version is reported with the fix, not restarted', async () => {
  const w = world({ running: 'manual' });
  try {
    await runInit(w.deps, { yes: true, skipService: true });
    w.deps.version = '0.2.1'; w.deps.bridgeVersion = async () => '0.2.0';
    const r = await runInit(w.deps, { yes: true, skipService: true });
    const svc = r.steps.find((s) => s.id === 'service')!;
    assert.equal(svc.ok, false); assert.match(svc.detail, /still runs 0\.2\.0/); assert.match(svc.fix ?? '', /agentbridge stop, then agentbridge start/);
  } finally { w.cleanup(); }
});

test('init refreshes the Codex block only when `add codex` set it up', async () => {
  const w = world({ running: 'managed' });
  try {
    let r = await runInit(w.deps, { yes: true });
    assert.equal(r.steps.find((s) => s.id === 'codex'), undefined, 'no refreshCodex dep: no step');
    w.deps.refreshCodex = () => null;
    r = await runInit(w.deps, { yes: true });
    assert.equal(r.steps.find((s) => s.id === 'codex'), undefined, 'not set up: no step');
    w.deps.refreshCodex = () => ({ ok: true, changed: true, message: 'added agentbridge to /x/config.toml' });
    r = await runInit(w.deps, { yes: true });
    assert.match(r.steps.find((s) => s.id === 'codex')!.detail, /restart open Codex sessions/);
    w.deps.refreshCodex = () => { throw new Error('boom'); };
    r = await runInit(w.deps, { yes: true });
    const c = r.steps.find((s) => s.id === 'codex')!; assert.equal(c.ok, false); assert.equal(c.fix, 'agentbridge add codex');
  } finally { w.cleanup(); }
});

test('stopForeignBridge stops only an agentbridge bridge process', async () => {
  const { stopForeignBridge } = await import('../src/init/deps.ts');
  const killed: number[] = []; let alive = true;
  const kill = (p: number): void => { killed.push(p); alive = false; };
  assert.equal(await stopForeignBridge(500, async () => '/usr/bin/vim notes.txt', kill, () => alive), false);
  assert.deepEqual(killed, []);
  assert.equal(await stopForeignBridge(501, async () => '/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/agentbridge/dist/cli.mjs serve', kill, () => alive), true);
  alive = true;
  assert.equal(await stopForeignBridge(502, async () => '/opt/homebrew/bin/node /x/agentbridge/dist/service-main.mjs', kill, () => alive), true);
  assert.deepEqual(killed, [501, 502]);
  assert.equal(await stopForeignBridge(process.pid, async () => 'agentbridge serve', kill, () => true), false); // never ourselves
});

test('plistMatches compares program and environment of the installed plist', async () => {
  const { renderPlist } = await import('@agentbridge/presence');
  const { plistMatches } = await import('../src/init/launch-env.ts');
  const t = tmp(); const p = join(t, 'a.plist');
  try {
    writeFileSync(p, renderPlist({ label: 'live.musi.agentbridge', programArguments: ['/opt/homebrew/bin/node', '/pkg/dist/service-main.mjs'], stdoutPath: '/o', stderrPath: '/e', environment: { PATH: '/opt/homebrew/bin:/usr/bin', AGENTBRIDGE_CLAUDE_BIN: '/u/.local/bin/claude', AGENTBRIDGE_LAUNCHD: '1' } }));
    const want = { nodePath: '/opt/homebrew/bin/node', entry: '/pkg/dist/service-main.mjs', environment: { PATH: '/opt/homebrew/bin:/usr/bin', AGENTBRIDGE_CLAUDE_BIN: '/u/.local/bin/claude' } };
    assert.equal(plistMatches(p, want), true);
    assert.equal(plistMatches(p, { ...want, nodePath: '/opt/homebrew/Cellar/node/25.9.0_2/bin/node' }), false);
    assert.equal(plistMatches(p, { ...want, environment: { ...want.environment, PATH: '/usr/bin' } }), false);
    assert.equal(plistMatches(join(t, 'none.plist'), want), false);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('agentbridge start refuses while init holds a live setup marker', async () => {
  const { startDetached } = await import('../src/cli/main.ts');
  const { formatSetupMarker } = await import('@agentbridge/protocol');
  const t = tmp(); const paths = resolvePaths(join(t, 'ab'));
  try {
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(join(paths.runDir, 'setup.lock'), formatSetupMarker(process.pid, Date.now()));
    await assert.rejects(startDetached(paths.root), /init is running/);
    // (stale markers: covered by the protocol's setupMarkerLive test; never spawn a real bridge from a test)
  } finally { rmSync(t, { recursive: true, force: true }); }
});

/** A fake launchctl that behaves like launchd for one job: bootstrap/kickstart spawn a "bridge" (sleep) that takes the
 *  bridge lock, unless a live process already holds it (then the job stays "spawn scheduled", as with AlreadyRunning). */
function fakeLaunchctl(dir: string, lockPath: string): { path: string; log: string; cleanup(): void } {
  const log = join(dir, 'launchctl.log'); const state = join(dir, 'job.state'); const path = join(dir, 'launchctl');
  writeFileSync(path, `#!/bin/sh
LOG=${JSON.stringify(log)}; STATE=${JSON.stringify(state)}; LOCK=${JSON.stringify(lockPath)}
echo "$@" >> "$LOG"
case "$1" in
  bootstrap|kickstart)
    if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then echo "spawn scheduled" > "$STATE"
    else sleep 60 >/dev/null 2>&1 & echo $! > "$LOCK"; echo "running $!" > "$STATE"; fi ;;
  print) [ -f "$STATE" ] || exit 113; set -- $(cat "$STATE")
    if [ "$1" = running ]; then echo "state = running"; echo "pid = $2"; else echo "state = spawn scheduled"; fi ;;
  bootout) if [ -f "$STATE" ]; then set -- $(cat "$STATE"); [ "$1" = running ] && kill "$2" 2>/dev/null; fi; rm -f "$STATE" ;;
esac
exit 0
`); chmodSync(path, 0o755);
  return { path, log, cleanup: () => { try { const [st, pid] = readFileSync(state, 'utf8').trim().split(' '); if (st === 'running' && pid) process.kill(Number(pid)); } catch { /* none */ } } };
}

async function realServiceWorld() {
  const { LaunchdServiceManager } = await import('@agentbridge/presence');
  const { realInitDeps, stopForeignBridge } = await import('../src/init/deps.ts');
  const { liveLockPid } = await import('../src/init/launch-env.ts');
  const { pidAlive } = await import('@agentbridge/protocol');
  const t = tmp(); const agents = join(t, 'LaunchAgents');
  const w = world();
  mkdirSync(w.paths.runDir, { recursive: true });
  const lc = fakeLaunchctl(t, w.paths.lock);
  const mk = (environment: Record<string, string> = {}) => new LaunchdServiceManager({ launchAgentsDir: agents, launchctlPath: lc.path, uid: 501, environment, retryDelayMs: 1 });
  const real = realInitDeps({ paths: w.paths, secrets: w.secrets, presence: w.presence, service: mk(), serviceFor: (env) => mk(env), startBridge: async () => {}, print: () => {}, launchctlPath: lc.path, env: { HOME: '/nonexistent', PATH: '/usr/bin' } });
  w.deps.service = real.service;
  w.deps.lockPid = () => liveLockPid(w.paths.lock, pidAlive);
  w.deps.stopForeignBridge = (pid) => stopForeignBridge(pid);
  w.deps.bridgeRunning = async () => liveLockPid(w.paths.lock, pidAlive) !== null;
  w.deps.launchPaths = () => ({ nodePath: '/opt/homebrew/bin/node', nodeVersioned: false, claudePath: '/Users/x/.local/bin/claude', path: '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin', environment: { PATH: '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin', AGENTBRIDGE_CLAUDE_BIN: '/Users/x/.local/bin/claude' } });
  return { w, real, agents, lc, t, cleanup: () => { lc.cleanup(); w.cleanup(); rmSync(t, { recursive: true, force: true }); } };
}

test('init service step with the REAL LaunchdServiceManager (temp LaunchAgents, fake launchctl): plist shapes end to end', async () => {
  const { plistProgram, plistEnvironment } = await import('../src/init/launch-env.ts');
  const x = await realServiceWorld();
  try {
    const r = await runInit(x.w.deps, { yes: true });
    const svc = r.steps.find((s) => s.id === 'service')!;
    assert.equal(svc.ok, true, svc.detail);
    assert.match(svc.detail, /launchd runs the bridge \(pid \d+/);
    const plist = join(x.agents, 'live.musi.agentbridge.plist');
    assert.deepEqual(plistProgram(plist), ['/opt/homebrew/bin/node', '/repo/packages/bridge/dist/cli/service-main.js']);
    const env = plistEnvironment(plist)!;
    assert.equal(env['PATH'], '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin');
    assert.equal(env['AGENTBRIDGE_CLAUDE_BIN'], '/Users/x/.local/bin/claude');
    assert.equal(env['AGENTBRIDGE_LAUNCHD'], '1');
    assert.equal(await x.real.service.plistMatches({ nodePath: '/opt/homebrew/bin/node', entry: '/repo/packages/bridge/dist/cli/service-main.js', logDir: x.w.paths.logsDir, environment: x.w.deps.launchPaths().environment }), true);
    assert.equal(await x.real.service.status(), 'running');
    await x.real.service.stopManaged(); // bootout keeps the plist
    assert.ok(existsSync(plist));
    await x.real.service.startManaged();
    const log = readFileSync(x.lc.log, 'utf8');
    assert.match(log, /^bootstrap gui\/501 .*live\.musi\.agentbridge\.plist$/m);
    assert.match(log, /^bootout gui\/501\/live\.musi\.agentbridge$/m);
  } finally { x.cleanup(); }
});

test('init hands over from a manually started bridge to launchd and reports success only when launchd owns the lock', async () => {
  const { spawn } = await import('node:child_process');
  const x = await realServiceWorld();
  let manual: import('node:child_process').ChildProcess | null = null;
  try {
    assert.ok((await runInit(x.w.deps, { yes: true })).ok); // first setup: launchd runs it
    await x.real.service.stopManaged(); // later: the agent is down and someone runs `agentbridge serve` by hand
    manual = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'agentbridge', 'serve'], { stdio: 'ignore' });
    writeFileSync(x.w.paths.lock, String(manual.pid));
    const r = await runInit(x.w.deps, { yes: true });
    const svc = r.steps.find((s) => s.id === 'service')!;
    assert.equal(svc.ok, true, svc.detail);
    assert.match(svc.detail, /took over from a manually started bridge/);
    await new Promise((res) => setTimeout(res, 100));
    assert.notEqual(manual.exitCode === null && manual.signalCode === null, true); // the manual bridge was stopped
    const job = await x.real.service.job();
    assert.equal(job?.state, 'running');
    assert.equal(job?.pid, x.w.deps.lockPid()); // launchd's job holds the lock
    assert.match(readFileSync(x.lc.log, 'utf8'), /^kickstart -k gui\/501\/live\.musi\.agentbridge$/m);
  } finally { try { manual?.kill(); } catch { /* gone */ } x.cleanup(); }
});

test('init reports the exact state when the lock holder is not agentbridge (no false success)', async () => {
  const { spawn } = await import('node:child_process');
  const x = await realServiceWorld();
  let other: import('node:child_process').ChildProcess | null = null;
  try {
    assert.ok((await runInit(x.w.deps, { yes: true, skipRelay: true })).ok); // configured; nothing to write on the re-run
    await x.real.service.stopManaged();
    other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); // not an agentbridge bridge
    writeFileSync(x.w.paths.lock, String(other.pid));
    x.w.deps.bridgeRunning = async () => false; // it doesn't answer as a bridge
    const r = await runInit(x.w.deps, { yes: true, skipRelay: true });
    const svc = r.steps.find((s) => s.id === 'service');
    assert.ok(svc, JSON.stringify(r.steps.map((s) => s.id)));
    assert.equal(svc!.ok, false);
    assert.match(svc!.detail, /held by pid \d+, which is not an agentbridge bridge/);
    assert.equal(other.exitCode, null); // left alone
  } finally { other?.kill(); x.cleanup(); }
});
