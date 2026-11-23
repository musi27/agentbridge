// `agentbridge add codex` / `remove codex` (§11a): wire Codex CLI to the bridge with one managed block in
// $CODEX_HOME/config.toml: the plugin's MCP server started with --host=codex, an always-prompt approval for
// bridge_confirm, and the plugin hook on the session events. Nothing outside the markers is touched.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Env = Readonly<Record<string, string | undefined>>;

export const BEGIN = '# >>> agentbridge (managed by `agentbridge add codex`; remove with `agentbridge remove codex`)';
export const END = '# <<< agentbridge';
/** Hook events the bridge needs: lifecycle, the permission mode, and the standing instruction at start. */
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd'] as const;

export function codexHome(env: Env = process.env): string { return env.CODEX_HOME || join(homedir(), '.codex'); }
export function codexConfigPath(env: Env = process.env): string { return join(codexHome(env), 'config.toml'); }

/** The plugin runtime (server.mjs, hook.mjs): next to the npm bundle, or in a source checkout. */
export function findRuntimeDir(from: string = dirname(fileURLToPath(import.meta.url))): string | null {
  const cands = [join(from, '..', 'plugin', 'runtime')];
  let d = resolve(from);
  for (let i = 0; i < 8; i++) { cands.push(join(d, 'adapters', 'claude-code', 'plugin', 'runtime')); const up = dirname(d); if (up === d) break; d = up; }
  return cands.find((c) => existsSync(join(c, 'server.mjs')) && existsSync(join(c, 'hook.mjs'))) ?? null;
}

/**
 * A node path that survives upgrades: the first `node` on PATH (or a well-known link) that is the running node,
 * instead of process.execPath, which for Homebrew points into a versioned Cellar folder.
 */
export function stableNodePath(execPath: string = process.execPath, env: Env = process.env): string {
  let real: string; try { real = realpathSync(execPath); } catch { return execPath; }
  const dirs = [...(env.PATH ?? '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) {
    const c = join(d, 'node');
    try { if (realpathSync(c) === real) return c; } catch { /* not there */ }
  }
  return execPath;
}

const q = (s: string): string => JSON.stringify(s); // a TOML basic string is a JSON string for these paths

/** The managed block for `node` + the runtime dir. */
export function codexBlock(nodePath: string, runtimeDir: string): string {
  const server = join(runtimeDir, 'server.mjs'); const hook = join(runtimeDir, 'hook.mjs');
  const hookCmd = `${q(nodePath).slice(1, -1)} ${q(hook).slice(1, -1)} --host=codex`;
  const lines = [
    BEGIN,
    '[mcp_servers.agentbridge]',
    `command = ${q(nodePath)}`,
    `args = [${q(server)}, "--host=codex"]`,
    '# Codex asks before every MCP tool by default; agentbridge gates only bridge_confirm (below), like Claude Code.',
    'default_tools_approval_mode = "approve"',
    '',
    '# Codex must ask the user before every bridge_confirm (agentbridge relies on this prompt).',
    '[mcp_servers.agentbridge.tools.bridge_confirm]',
    'approval_mode = "prompt"',
  ];
  for (const ev of CODEX_HOOK_EVENTS) {
    lines.push('', `[[hooks.${ev}]]`);
    if (ev === 'PreToolUse') lines.push('matcher = "^mcp__agentbridge__"');
    lines.push(`[[hooks.${ev}.hooks]]`, 'type = "command"', `command = ${q(hookCmd)}`, `timeout = ${ev === 'SessionStart' ? 8 : 3}`);
  }
  lines.push(END);
  return lines.join('\n');
}

/** Remove the managed block (and the blank line before it). */
export function stripBlock(text: string): string {
  const b = text.indexOf(BEGIN); if (b < 0) return text;
  const e = text.indexOf(END, b); if (e < 0) throw new Error(`${BEGIN.slice(2, 14)} block has no end marker; fix ${'config.toml'} by hand`);
  const before = text.slice(0, b).replace(/\n+$/, ''); const after = text.slice(e + END.length).replace(/^\n+/, '');
  return before + (before && after ? '\n\n' : before ? '\n' : '') + after;
}

/** A user-written [mcp_servers.agentbridge] outside our block would clash with ours. */
export function hasForeignServer(text: string): boolean {
  return /^\s*\[mcp_servers\.agentbridge(\.|\])/m.test(stripBlock(text));
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.agentbridge-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path);
}

export interface CodexSetupResult { ok: boolean; changed: boolean; path: string; message: string }

export function addCodex(o: { env?: Env; nodePath?: string; runtimeDir?: string | null } = {}): CodexSetupResult {
  const path = codexConfigPath(o.env);
  const runtime = o.runtimeDir === undefined ? findRuntimeDir() : o.runtimeDir;
  if (!runtime) return { ok: false, changed: false, path, message: 'could not find the agentbridge plugin runtime (server.mjs, hook.mjs); reinstall agentbridge' };
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (hasForeignServer(cur)) return { ok: false, changed: false, path, message: `${path} already has an [mcp_servers.agentbridge] entry that agentbridge didn't write; remove it and run this again` };
  const base = stripBlock(cur);
  const next = (base ? base.replace(/\n*$/, '\n\n') : '') + codexBlock(o.nodePath ?? stableNodePath(process.execPath, o.env), runtime) + '\n';
  if (next === cur) return { ok: true, changed: false, path, message: `${path} is already set up` };
  if (cur && !existsSync(`${path}.agentbridge-backup`)) writeFileSync(`${path}.agentbridge-backup`, cur, { mode: 0o600 });
  writeAtomic(path, next);
  return { ok: true, changed: true, path, message: `added agentbridge to ${path}` };
}

export function removeCodex(o: { env?: Env } = {}): CodexSetupResult {
  const path = codexConfigPath(o.env);
  if (!existsSync(path)) return { ok: true, changed: false, path, message: `${path} does not exist; nothing to remove` };
  const cur = readFileSync(path, 'utf8');
  if (!cur.includes(BEGIN)) return { ok: true, changed: false, path, message: `agentbridge is not in ${path}` };
  writeAtomic(path, stripBlock(cur).replace(/\n*$/, '\n'));
  return { ok: true, changed: true, path, message: `removed agentbridge from ${path}` };
}

/** What the user still has to do in Codex after `add codex`. */
export const CODEX_NEXT_STEPS = [
  'Next, in Codex (one time):',
  '  1. Start codex in any folder and run /hooks. Trust the agentbridge hooks: Codex only runs hooks you have reviewed.',
  '  2. Leave approvals on (the default). agentbridge refuses approvals made by Codex auto-review (--approve-for-me).',
  'Then any new Codex session can talk to your other agents: ask it to list agents or start a conversation.',
];
