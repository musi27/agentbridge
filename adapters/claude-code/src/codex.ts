// Codex CLI host support (§11a). The same plugin runtime serves Codex when started with
// `--host=codex`: deliveries are posted with `codex queue --thread <id>` instead of Claude Code's inbox socket, the
// standing instruction comes from the SessionStart hook, and bridge_confirm refuses Codex auto-review approvals.
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { LIMITS } from '@agentbridge/protocol';
import type { ToolDef, ToolResult } from '@agentbridge/protocol';

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

/**
 * Codex's MCP approval prompt shows only the first three arguments, sorted by name, each cut to 60 characters
 * (codex-rs tui `mcp_server_elicitation.rs`: APPROVAL_TOOL_PARAM_DISPLAY_LIMIT = 3). bridge_confirm's own fields
 * sort as approval_id, direction, kind, so the approver would never see who the conversation is with. Under Codex,
 * bridge_confirm therefore also takes these copies, named to sort first; each must equal the field it copies.
 */
export const CODEX_CONFIRM_DISPLAY = [
  ['about', 'topic'],
  ['agent', 'peer'],
  ['allowed_turns', 'turn_limit'],
] as const;

const DISPLAY_KEYS: ReadonlySet<string> = new Set(CODEX_CONFIRM_DISPLAY.map(([k]) => k));

/** bridge_confirm as Codex sees it: the display copies first (and required), then the usual fields. */
export function codexConfirmTool(base: ToolDef): ToolDef {
  const schema = base.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[] };
  const props: Record<string, Record<string, unknown>> = {};
  for (const [k, of] of CODEX_CONFIRM_DISPLAY) {
    props[k] = { ...schema.properties[of], description: `Same value as ${of} (Codex shows this field to the user)` };
  }
  return {
    ...base,
    description: 'Confirm a pending approval. The user must approve it in Codex\'s prompt. Pass exactly the fields you were given, plus about = topic, agent = peer and allowed_turns = turn_limit (the fields Codex shows the user).',
    inputSchema: { ...schema, properties: { ...props, ...schema.properties }, required: [...CODEX_CONFIRM_DISPLAY.map(([k]) => k), ...schema.required] },
  };
}

/**
 * Checks the display copies against the fields the bridge verifies, so what Codex showed the user is what gets
 * confirmed. Missing or different copies fail closed (the user may not have seen the real peer, topic or limit).
 * Returns the arguments without the copies, or a refusal.
 */
export function codexConfirmDisplay(args: unknown): { args: Record<string, unknown> } | { refused: ToolResult } {
  const a = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const bad = CODEX_CONFIRM_DISPLAY.filter(([k, of]) => a[k] === undefined || a[k] !== a[of]).map(([k, of]) => `${k} (= ${of})`);
  if (bad.length) {
    return { refused: { status: 'failed', reason: 'approval_mismatch', hint: `Codex shows the user only about, agent and allowed_turns, so they must equal topic, peer and turn_limit exactly. Missing or different: ${bad.join(', ')}. The request is still pending: call bridge_confirm again with them set.` } };
  }
  return { args: Object.fromEntries(Object.entries(a).filter(([k]) => !DISPLAY_KEYS.has(k))) };
}
