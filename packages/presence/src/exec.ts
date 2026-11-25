import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeHelperRequest, parseHelperResponse, type HelperResponse, type HelperSubcommand } from './protocol.ts';

export interface RunResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
export interface RunOptions {
  input?: string;
  /** After this, SIGTERM; after a further `killGraceMs` (default 2 s), SIGKILL. */
  timeoutMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}
/** Process runner; injectable so tests can stub launchctl/osascript. Never uses a shell. */
export type Runner = (file: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>;

const MAX_OUTPUT = 1 << 20;

export const run: Runner = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (d: string) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    let killTimer: NodeJS.Timeout | undefined;
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), opts.killGraceMs ?? 2000);
    }, opts.timeoutMs);
    const done = () => { clearTimeout(timer); clearTimeout(killTimer); };
    child.on('error', (e) => { done(); reject(e); });
    child.on('close', (code, signal) => { done(); resolve({ code, signal, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => {}); // EPIPE if the child exits early; the exit status tells the story
    child.stdin.end(opts.input ?? '');
  });

/**
 * Default location of the helper: the executable inside <package>/bin/AgentBridge.app (same from src/ and dist/).
 * It must run from inside the bundle: that is what makes the Touch ID and keychain dialogs say "AgentBridge".
 */
export const DEFAULT_HELPER_PATH = fileURLToPath(new URL('../bin/AgentBridge.app/Contents/MacOS/AgentBridge', import.meta.url));

export class HelperError extends Error {
  override name = 'HelperError';
  readonly response: HelperResponse | undefined;
  constructor(message: string, response?: HelperResponse) { super(message); this.response = response; }
}

export interface HelperClientOptions { helperPath?: string; runner?: Runner }

/** Runs one helper request. Returns the parsed response (which may be {ok:false}); throws HelperError on crash/timeout/garbage. */
export async function callHelper(
  sub: HelperSubcommand,
  req: Record<string, string | number>,
  opts: HelperClientOptions & { timeoutMs?: number } = {},
): Promise<HelperResponse> {
  const runner = opts.runner ?? run;
  const helperPath = opts.helperPath ?? DEFAULT_HELPER_PATH;
  let r: RunResult;
  try {
    // Minimal env: the helper needs nothing from ours, and nothing secret ever goes there.
    r = await runner(helperPath, [sub], { input: encodeHelperRequest(req), env: { PATH: '/usr/bin:/bin' }, ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) });
  } catch (e) {
    throw new HelperError(`cannot run the AgentBridge helper at ${helperPath}: ${(e as Error).message}`);
  }
  if (r.timedOut) throw new HelperError(`AgentBridge helper ${sub} timed out`);
  if (r.signal !== null) throw new HelperError(`AgentBridge helper ${sub} killed by ${r.signal}`);
  let res: HelperResponse;
  try {
    res = parseHelperResponse(r.stdout);
  } catch (e) {
    throw new HelperError(`AgentBridge helper ${sub} (exit ${r.code}): ${(e as Error).message}`);
  }
  if (r.code !== 0 && res.ok) throw new HelperError(`AgentBridge helper ${sub} exited ${r.code} with ok:true`);
  return res;
}
