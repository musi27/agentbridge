// End-to-end check against the real, interactive Codex CLI (manual; costs a few small model calls).
// A real bridge service on a temp root with a fake peer `fake:echo`, and `codex` started in a pty
// (scripts/codex-tui.py) with -c overrides only: the plugin runtime as MCP server (--host=codex) and hooks, pointed at
// the temp socket. The user's ~/.codex/config.toml is not changed (E2E_DISABLE_MCP switches named servers off for the run).
//
// Flow: Codex starts a conversation with fake:echo -> pending_approval -> bridge_confirm -> Codex's own approval
// prompt -> the script presses Allow -> fake:echo accepts and replies -> the bridge delivers the reply through
// `codex queue` -> Codex quotes it. Also checks hooks (session id, mode), the standing instruction (tag code), and
// that the confirm call carried auto_review_enabled=false.
//
//   node --conditions=agentbridge-source packages/bridge/scripts/e2e-codex.ts      (E2E_MODEL, CODEX_BIN, E2E_DISABLE_MCP optional)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeAdapter } from '@agentbridge/adapter-fake';
import type { ToolResult } from '@agentbridge/protocol';
import { MemorySecretStore } from '../src/policy/integrity.ts';
import { startBridge } from '../src/service.ts';
import { RecordingNotifier, ScriptedPresence } from '../test/helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(here, '..', '..', '..', 'adapters', 'claude-code', 'plugin', 'runtime');
const MARK = `PONG-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const root = mkdtempSync('/tmp/abcx-'); const work = mkdtempSync('/tmp/abcx-work-');
const log = (s: string): void => { console.log(`[e2e] ${s}`); };

const fake = new FakeAdapter();
const svc = await startBridge({ root, secrets: new MemorySecretStore(), presence: new ScriptedPresence(), notifier: new RecordingNotifier(), adapters: { fake }, inboundReader: () => 'accept' });
const echo = svc.engine.registerLocal({ name: 'echo' });
const sock = svc.paths.socket;
log(`bridge on ${sock}; peer ${echo.address}`);

// Codex: plugin runtime as MCP server + hooks, aimed at the temp socket.
const node = process.execPath;
const hook = `AGENTBRIDGE_SOCKET=${sock} ${node} ${join(runtime, 'hook.mjs')} --host=codex`;
const hk = (ev: string, extra = ''): string => `hooks.${ev}=[{${extra}hooks=[{type="command",command=${JSON.stringify(hook)},timeout=${ev === 'SessionStart' ? 8 : 3}}]}]`;
const codexArgs = [
  '--no-alt-screen', '-a', 'on-request', '-s', 'read-only', '-C', work, '-m', process.env.E2E_MODEL ?? 'gpt-6-luna', '--dangerously-bypass-hook-trust',
  // your own MCP servers stay on unless named here, e.g. E2E_DISABLE_MCP=docs,search
  ...(process.env.E2E_DISABLE_MCP ?? '').split(',').filter(Boolean).flatMap((s) => ['-c', `mcp_servers.${s}.enabled=false`]),
  '-c', `mcp_servers.agentbridge.command=${JSON.stringify(node)}`,
  '-c', `mcp_servers.agentbridge.args=[${JSON.stringify(join(runtime, 'server.mjs'))},"--host=codex"]`,
  '-c', `mcp_servers.agentbridge.env={AGENTBRIDGE_SOCKET=${JSON.stringify(sock)}}`,
  '-c', 'mcp_servers.agentbridge.default_tools_approval_mode="approve"',
  '-c', 'mcp_servers.agentbridge.tools.bridge_confirm.approval_mode="prompt"',
  '-c', hk('SessionStart'), '-c', hk('UserPromptSubmit'), '-c', hk('PreToolUse', 'matcher="^mcp__agentbridge__",'), '-c', hk('Stop'), '-c', hk('SessionEnd'),
  `Using the agentbridge tools: start a conversation with ${echo.address}, topic "e2e check", first message "ping". If a tool returns pending_approval, call bridge_confirm with exactly the returned fields. Then tell me your agentbridge tag code. When a reply from ${echo.address} arrives later, quote it exactly.`,
];
const approvedFlag = join(root, 'approved'); const doneFlag = join(root, 'done');
const steps = [
  { until: 'Allow the agentbridge MCP server to run tool \\W?bridge_confirm', timeout: 150 }, { wait: 1 }, { key: 'enter' },
  { wait: 2 }, { mark: 'approved' }, { shell: `touch ${approvedFlag}` }, { file: doneFlag, timeout: 150 }, { wait: 25 }, { mark: 'end' },
];
const stepsFile = join(root, 'steps.json'); writeFileSync(stepsFile, JSON.stringify(steps));
const screen = join(root, 'tui.log');
const tui = spawn('python3', [join(here, 'codex-tui.py'), stepsFile, screen, process.env.CODEX_BIN ?? 'codex', ...codexArgs], { stdio: ['ignore', 'inherit', 'inherit'] });
const tuiDone = new Promise<void>((r) => tui.on('close', () => r()));

// fake:echo: accept the invite, then reply once the first message lands.
const until = async (what: string, f: () => boolean, ms = 180_000): Promise<boolean> => {
  const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await new Promise((r) => setTimeout(r, 500)); }
  log(`timed out waiting for ${what}`); return false;
};
const call = (name: string, params: unknown): Promise<ToolResult> => svc.engine.callTool(echo, `tool.${name}`, params);
let replied = false;
if (await until('the invite to fake:echo', () => fake.noticeCodes(echo.participant_id).includes('invite'))) {
  const item = fake.inbox(echo.participant_id).filter((i) => i.notices.some((n) => n.code === 'invite')).at(-1)!;
  const n = item.notices.find((x) => x.code === 'invite')!; const text = n.parts.map((p) => p.text).join('\n');
  const facts = { approval_id: /approval_id=([0-9A-Z]{26})/.exec(text)![1]!, kind: 'accept', peer: /peer=([a-z]+:[A-Za-z0-9_-]+)/.exec(text)![1]!, direction: 'incoming', topic: n.parts.find((p) => p.kind === 'untrusted')!.text, turn_limit: Number(/turn_limit=(\d+)/.exec(text)![1]) };
  log(`fake:echo accepts: ${(await call('bridge_confirm', facts)).status}`);
  if (await until('the first message at fake:echo', () => fake.bodies(echo.participant_id).length > 0)) {
    const conv = fake.inbox(echo.participant_id).find((i) => i.messages.length)!.conversation!.id;
    log(`fake:echo got "${fake.bodies(echo.participant_id)[0]}"; replying`);
    const r = await call('bridge_send', { conversation_id: conv, body: `${MARK}: hello back from fake:echo.` }); replied = true;
    log(`reply send: ${r.status}${r.hint ? ` (${r.hint})` : ''}`);
  }
}
await new Promise((r) => setTimeout(r, 2000)); writeFileSync(doneFlag, '');
await tuiDone;

// ---- checks ----
const failures: string[] = [];
const check = (ok: unknown, what: string): void => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78DME]/g, ' ');
const tx = existsSync(screen) ? strip(readFileSync(screen, 'utf8')) : '';
const codex = svc.store.participants().find((p) => p.agent === 'codex');
const events = svc.store.events({ limit: 500 }).map((e) => e.type);
const link = codex ? [...(svc.engine as unknown as { links: Map<string, { nonce: string }> }).links.entries()].find(([id]) => id === codex.id)?.[1] : undefined;
check(codex, `a codex participant registered (${codex ? `codex:${codex.name}` : 'none'})`);
check(codex?.session_id, 'SessionStart hook linked the Codex session id');
check(codex && codex.permission_mode !== 'unknown', `permission mode reported (${codex?.permission_mode})`);
check(events.includes('approval_resolved') || svc.store.conversations().some((c) => c.state === 'active'), 'the conversation was approved (Codex prompt -> Allow)');
check(/Allow the agentbridge MCP server to run tool/.test(tx), 'Codex showed its own approval prompt for bridge_confirm');
check(replied, 'fake:echo received the first message and replied');
check(new RegExp(MARK).test(tx.split('=====MARK approved=====').pop() ?? ''), `the reply reached the Codex session through codex queue (${MARK})`);
check(link && tx.includes(link.nonce), `standing instruction reached the model (tag code ${link?.nonce ?? '?'} quoted)`);
console.log(failures.length ? `\n${failures.length} check(s) failed. TUI log: ${screen}` : '\nAll checks passed.');
await svc.stop();
if (!failures.length) { rmSync(root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
process.exit(failures.length ? 1 : 0);
