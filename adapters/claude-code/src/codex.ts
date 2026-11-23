// Codex CLI host support (§11a). The same plugin runtime serves Codex when started with
// `--host=codex`: deliveries are posted with `codex queue --thread <id>` instead of Claude Code's inbox socket, the
// standing instruction comes from the SessionStart hook, and bridge_confirm refuses Codex auto-review approvals.
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { LIMITS } from '@agentbridge/protocol';
import type { ToolResult } from '@agentbridge/protocol';

export type Host = 'claude' | 'codex';

/** `--host=codex` (or AGENTBRIDGE_HOST=codex) selects Codex; anything else is Claude Code. */
export function hostFrom(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): Host {
  const a = argv.find((x) => x.startsWith('--host='))?.slice('--host='.length) ?? env.AGENTBRIDGE_HOST;
  return a === 'codex' ? 'codex' : 'claude';
}

/**
 * The Codex binary to run `queue` with: the parent process (this MCP server is a direct child of Codex) when it is
 * an executable named codex, else AGENTBRIDGE_CODEX_BIN, else `codex` on PATH.
 */
export function codexBinary(ppid: number, env: Readonly<Record<string, string | undefined>> = process.env,
  parentPath: (pid: number) => string | null = parentExecutable): string {
  if (env.AGENTBRIDGE_CODEX_BIN) return env.AGENTBRIDGE_CODEX_BIN;
  const p = parentPath(ppid);
  if (p && isAbsolute(p) && /^codex(-[\w.-]+)?$/.test(basename(p))) {
    try { accessSync(p, constants.X_OK); return p; } catch { /* fall through */ }
  }
  return 'codex';
}

function parentExecutable(pid: number): string | null {
  try { return execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim() || null; }
  catch { return null; }
}

export type RunFn = (bin: string, args: string[]) => Promise<void>;
const runQueue: RunFn = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 15_000, maxBuffer: 256 * 1024 }, (e, _out, stderr) => {
    if (e) reject(new Error(`codex queue: ${(stderr || e.message).toString().trim().slice(0, 200)}`)); else resolve();
  });
});

/** Posts into a Codex session with `codex queue`, serialised and spaced like the Claude inbox poster. */
export class CodexQueuePoster {
  readonly #bin: string;
  readonly #run: RunFn;
  readonly #spacingMs: number;
  #chain: Promise<unknown> = Promise.resolve();
  #lastStart = -Infinity;

  constructor(bin: string, opts: { run?: RunFn; spacingMs?: number } = {}) {
    this.#bin = bin; this.#run = opts.run ?? runQueue; this.#spacingMs = opts.spacingMs ?? LIMITS.inboxPostSpacingMs;
  }

  /** Queue one post into `threadId`. Rejects when the id is missing or `codex queue` fails. */
  post(text: string, threadId?: string): Promise<void> {
    const run = async (): Promise<void> => {
      if (!threadId) throw new Error('no Codex session id yet (waiting for the SessionStart hook)');
      let wait: number;
      while ((wait = this.#lastStart + this.#spacingMs - performance.now()) > 0) await new Promise((r) => setTimeout(r, Math.ceil(wait)));
      this.#lastStart = performance.now();
      await this.#run(this.#bin, ['queue', '--thread', threadId, '--message', text]);
    };
    const p = this.#chain.then(run, run);
    this.#chain = p.catch(() => undefined);
    return p;
  }
}

/**
 * bridge_confirm under Codex counts as the user's approval only if Codex itself asked the user. With auto-review on
 * (`--approve-for-me`, `approvals_reviewer = "auto_review"`) a model approves the call instead, so refuse unless the
 * call's turn metadata says auto-review is off. Missing metadata fails closed. Returns null when the call may proceed.
 */
export function codexConfirmGuard(meta: unknown, approvalId: unknown): ToolResult | null {
  const turn = meta && typeof meta === 'object' ? (meta as Record<string, unknown>)['x-codex-turn-metadata'] : undefined;
  const autoReview = turn && typeof turn === 'object' ? (turn as Record<string, unknown>)['auto_review_enabled'] : undefined;
  if (autoReview === false) return null;
  const id = typeof approvalId === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(approvalId) ? approvalId : '<approval_id>';
  const why = autoReview === true ? 'Codex auto-review is on, so this approval would come from a model, not the user'
    : 'Codex did not say whether auto-review is on, so this approval cannot be trusted to come from the user';
  return { status: 'failed', reason: 'host_refused', hint: `${why}. The request is still pending: ask the user to approve it in a terminal with \`agentbridge approve ${id}\` (or turn auto-review off and call bridge_confirm again).` };
}
