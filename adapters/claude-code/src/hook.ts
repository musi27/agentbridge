// Plugin hooks (§10, §11.5): report session lifecycle and permission mode to the bridge.
// Rules: finish well under 1 s, never block Claude Code on bridge errors, print nothing but valid hook JSON.
import type { PermissionMode } from '@agentbridge/protocol';
import { connectIpc } from './ipc-client.ts';
import type { IpcConnection } from './ipc-client.ts';
import { bridgeSocketPath } from './paths.ts';
import { findCli, setupInProgress, startBridgeDetached } from './start-bridge.ts';
import { PLUGIN_VERSION } from './version.ts';

/** The fields of Claude Code's hook input we use (M0 V3 lists what each event carries). */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  source?: string;
  permission_mode?: string;
  transcript_path?: string;
  cwd?: string;
}

export interface SessionEventParams {
  event: 'start' | 'end' | 'state';
  claude_pid: number;
  session_id: string;
  source?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
  permission_mode?: PermissionMode;
  transcript_path?: string;
  cwd?: string;
}

const SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'] as const;
// Local copies so the hook bundle doesn't pull in zod (the protocol's enums are zod schemas); fast startup matters.
// test/hook.test.ts keeps them equal to IPC_PROTOCOL and PERMISSION_MODES from @agentbridge/protocol.
export const HOOK_IPC_PROTOCOL = 1;
export const HOOK_PERMISSION_MODES: readonly PermissionMode[] = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'unknown'];
const STATE_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'Stop']);

/** Map one hook input to a `session_event`; null for events we don't report or inputs without a session id. */
export function buildSessionEvent(input: HookInput, claudePid: number): SessionEventParams | null {
  const name = input.hook_event_name;
  if (typeof input.session_id !== 'string' || !input.session_id || !Number.isInteger(claudePid) || claudePid <= 0) return null;
  let event: SessionEventParams['event'];
  if (name === 'SessionStart') event = 'start';
  else if (name === 'SessionEnd') event = 'end';
  else if (name && STATE_EVENTS.has(name)) event = 'state';
  else return null;
  const p: SessionEventParams = { event, claude_pid: claudePid, session_id: input.session_id };
  if (event === 'start' && (SOURCES as readonly string[]).includes(input.source ?? '')) p.source = input.source as NonNullable<SessionEventParams['source']>;
  // SessionStart/SessionEnd carry no permission_mode (M0 V3); the bridge keeps the mode `unknown` until a state event.
  // A mode string this version does not know is reported as `unknown`, which holds deliveries (fail closed, §8.4).
  if (typeof input.permission_mode === 'string') {
    p.permission_mode = (HOOK_PERMISSION_MODES as readonly string[]).includes(input.permission_mode) ? input.permission_mode as PermissionMode : 'unknown';
  }
  if (typeof input.transcript_path === 'string' && input.transcript_path) p.transcript_path = input.transcript_path;
  if (typeof input.cwd === 'string' && input.cwd) p.cwd = input.cwd;
  return p;
}

/** hello + session_event on a short-lived connection. Resolves 'ok', 'offline' (no bridge) or 'error'. */
export async function sendSessionEvent(socketPath: string, params: SessionEventParams, timeoutMs = 700): Promise<'ok' | 'offline' | 'error'> {
  const deadline = Date.now() + timeoutMs;
  const left = (): number => Math.max(1, deadline - Date.now());
  let conn: IpcConnection;
  try { conn = await connectIpc(socketPath, { connectTimeoutMs: left() }); } catch { return 'offline'; }
  try {
    await conn.request('hello', { protocol: HOOK_IPC_PROTOCOL, client: 'hook', client_version: PLUGIN_VERSION }, left());
    await conn.request('session_event', params, left());
    return 'ok';
  } catch {
    return 'error';
  } finally {
    conn.close();
  }
}

export interface RunHookDeps {
  env?: Readonly<Record<string, string | undefined>>;
  ppid?: number;
  findCli?: typeof findCli;
  startBridge?: typeof startBridgeDetached;
  setupInProgress?: (env: Readonly<Record<string, string | undefined>>) => boolean;
  /** Total budget for SessionStart retries after starting the bridge. */
  startWaitMs?: number;
  /** Budget for one hello + session_event exchange (default 700 ms; tests that check payloads pass more). */
  eventTimeoutMs?: number;
}

/** Run one hook invocation. Returns what to print on stdout ('' or one JSON object). Never throws. */
export async function runHook(stdin: string, deps: RunHookDeps = {}): Promise<string> {
  let input: HookInput;
  try { input = JSON.parse(stdin) as HookInput; } catch { return ''; }
  if (!input || typeof input !== 'object') return '';
  const env = deps.env ?? process.env;
  const params = buildSessionEvent(input, deps.ppid ?? process.ppid);
  if (!params) return '';
  const socket = bridgeSocketPath(env);
  const first = await sendSessionEvent(socket, params, deps.eventTimeoutMs);
  if (first !== 'offline' || params.event !== 'start') return '';

  // `agentbridge init` is stopping/reconfiguring the bridge: don't race it for the lock; it restarts the bridge itself.
  if ((deps.setupInProgress ?? setupInProgress)(env)) {
    return JSON.stringify({ systemMessage: 'agentbridge: setup (agentbridge init) is running; the bridge will be back in a moment.' });
  }
  // SessionStart and nothing listens: start the bridge on demand (§11.5), then retry briefly.
  const cli = (deps.findCli ?? findCli)(env);
  if (!cli) {
    return JSON.stringify({ systemMessage: 'agentbridge: the bridge is not running and the `agentbridge` command was not found, so this session cannot talk to other agents. Install agentbridge or run `agentbridge start`.' });
  }
  if (!(deps.startBridge ?? startBridgeDetached)(cli, env)) {
    return JSON.stringify({ systemMessage: 'agentbridge: the bridge is not running and could not be started. Run `agentbridge start`.' });
  }
  const until = Date.now() + (deps.startWaitMs ?? 500);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    if ((await sendSessionEvent(socket, params, Math.max(50, until - Date.now()))) !== 'offline') return '';
  }
  // Still starting: the MCP server registers on its own once it is up, and the next hook event carries the session id.
  return '';
}
