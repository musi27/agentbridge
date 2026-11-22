// End-to-end check against the real Claude Code CLI (manual; costs one small model call).
// Starts a logging fake bridge (test/helpers.ts), runs `claude -p --plugin-dir plugin` from a neutral temp folder,
// and asserts the frames: hooks (start/state/end, same claude_pid), register_session, a tool round trip, and a
// deliver -> post_result whose text shows up in the session transcript as a verified peer post.
//
//   npm run e2e:claude -w @agentbridge/adapter-claude-code            (uses `claude` on PATH, model haiku)
//   CLAUDE_BIN=/path/to/claude E2E_MODEL=sonnet npm run e2e:claude -w @agentbridge/adapter-claude-code
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from '@agentbridge/protocol';
import { FakeBridge, tempDir } from '../test/helpers.ts';
import { TOOL_NAME_PREFIX } from '../src/version.ts';

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugin');
const MARKER = `E2E-PING-${Math.random().toString(36).slice(2, 8)}`;

const { dir, cleanup } = tempDir('abe2e-');
const work = join(dir, 'neutral-folder'); mkdirSync(work);
const bridge = await new FakeBridge(join(dir, 'b.sock')).listen();
let nonce = '';
const reg = bridge.handlers.register_session!;
bridge.handlers.register_session = (p, c) => { nonce = (p as { tag_nonce: string }).tag_nonce; return reg(p, c); };
bridge.handlers['tool.bridge_list_agents'] = () => ({ status: 'delivered', data: [{ address: 'fake:echo', state: 'live' }] });
bridge.piggyback['tool.bridge_list_agents'] = () => [{
  method: 'deliver',
  params: { items: [{ post_id: ulid(), text: `<ab-msg-${nonce} conversation="${ulid()}" from="fake:echo" turn="1/30" id="${ulid()}">\n${MARKER}: hello from the e2e fake bridge.\n</ab-msg-${nonce}>` }] },
}];

const prompt = 'Call the bridge_list_agents tool once and report what it returned. Then, if a message from another session arrives, quote its first line exactly.';
const args = ['-p', '--model', process.env.E2E_MODEL ?? 'haiku', '--plugin-dir', pluginDir, '--allowedTools', `${TOOL_NAME_PREFIX}bridge_list_agents`, '--output-format', 'json', prompt];
const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((res) => {
  const p = spawn(process.env.CLAUDE_BIN ?? 'claude', args, { cwd: work, env: { ...process.env, AGENTBRIDGE_SOCKET: bridge.path }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  const kill = setTimeout(() => p.kill('SIGTERM'), 240_000);
  p.on('close', (code) => { clearTimeout(kill); res({ code, stdout, stderr }); });
});
await new Promise((r) => setTimeout(r, 500)); // late SessionEnd hook

const failures: string[] = [];
const check = (ok: unknown, what: string): void => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };
type Ev = { event: string; claude_pid: number; session_id: string; permission_mode?: string; source?: string; transcript_path?: string };
const events = bridge.calls('session_event').map((r) => r.params as Ev);
const regs = bridge.calls('register_session').map((r) => r.params as { claude_pid: number; tag_nonce: string; inbox: { socket: string } });
let out: { result?: string; session_id?: string } = {};
try { out = JSON.parse(result.stdout); } catch { /* reported below */ }

check(result.code === 0, `claude exited 0 (got ${result.code}${result.code ? `; stderr: ${result.stderr.slice(0, 300)}` : ''})`);
check(events.some((e) => e.event === 'start' && e.source === 'startup'), 'SessionStart hook -> session_event start/startup');
check(events.some((e) => e.event === 'state' && e.permission_mode), 'UserPromptSubmit/PreToolUse/Stop -> session_event state with permission_mode');
check(events.some((e) => e.event === 'end'), 'SessionEnd hook -> session_event end');
check(regs.length >= 1 && regs.every((r) => /^[0-9a-f]{8}$/.test(r.tag_nonce) && r.inbox.socket), 'MCP server -> register_session with nonce and inbox');
check(regs.length >= 1 && events.length > 0 && events.every((e) => e.claude_pid === regs.at(-1)!.claude_pid), 'hooks and MCP server report the same claude_pid');
check(bridge.calls('tool.bridge_list_agents').length === 1, 'tool call forwarded as tool.bridge_list_agents');
check(bridge.calls('post_result').some((r) => (r.params as { ok: boolean }).ok), 'deliver -> post_result ok');
check(out.result?.includes(MARKER), `model saw the inbox post (${MARKER})`);
const transcript = events.find((e) => e.transcript_path)?.transcript_path;
const tx = transcript && existsSync(transcript) ? readFileSync(transcript, 'utf8') : '';
check(tx.includes(MARKER) && /"origin":\{"kind":"peer"[^}]*"verifiedPeerPid":\d+/.test(tx), 'transcript records the post as a verified peer post');

await bridge.close();
cleanup();
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
