// SessionStart: start the bridge on demand when no login service runs it (§11.5).
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { SETUP_MARKER_FILE, pidAlive, setupMarkerLive } from '@agentbridge/protocol';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { agentbridgeHome } from './paths.ts';

type Env = Readonly<Record<string, string | undefined>>;

function isExecutable(p: string): boolean {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

/** The `agentbridge` CLI: AGENTBRIDGE_CLI, then PATH, then the `~/.agentbridge/app` install (§14.1). */
export function findCli(env: Env = process.env): string | null {
  if (env.AGENTBRIDGE_CLI) return isExecutable(env.AGENTBRIDGE_CLI) ? env.AGENTBRIDGE_CLI : null;
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  dirs.push(join(agentbridgeHome(env), 'app', 'node_modules', '.bin'));
  for (const d of dirs) {
    const p = join(d, 'agentbridge');
    if (isExecutable(p)) return p;
  }
  return null;
}

/** Is `agentbridge init` running (live run/setup.lock)? Then on-demand starts must wait, or init cannot take the lock. */
export function setupInProgress(env: Env = process.env, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive): boolean {
  let text: string | null = null;
  try { text = readFileSync(join(agentbridgeHome(env), 'run', SETUP_MARKER_FILE), 'utf8'); } catch { text = null; }
  return setupMarkerLive(text, now, alive);
}

/** The session's env minus Claude Code's own variables (the bridge must not inherit a session's inbox token etc.). */
export function bridgeSpawnEnv(env: Env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDECODE')) continue;
    out[k] = v;
  }
  return out;
}

/** Spawn `agentbridge start` fully detached, from the home folder (not the session's project folder). */
export function startBridgeDetached(cli: string, env: Env = process.env): boolean {
  try {
    const child = spawn(cli, ['start'], { detached: true, stdio: 'ignore', cwd: homedir(), env: bridgeSpawnEnv(env) });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
