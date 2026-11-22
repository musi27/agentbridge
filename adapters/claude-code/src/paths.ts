// File locations. Every path can be redirected by env so tests and manual runs never touch real user state.
import { homedir } from 'node:os';
import { join } from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

/** `~/.agentbridge` unless AGENTBRIDGE_HOME is set (§15.1). */
export function agentbridgeHome(env: Env = process.env): string {
  return env.AGENTBRIDGE_HOME || join(homedir(), '.agentbridge');
}

/** Bridge IPC socket (§10). AGENTBRIDGE_SOCKET overrides the whole path. */
export function bridgeSocketPath(env: Env = process.env): string {
  return env.AGENTBRIDGE_SOCKET || join(agentbridgeHome(env), 'run', 'bridge.sock');
}

/** Claude Code's user config dir: `~/.claude`, or CLAUDE_CONFIG_DIR when set (Claude Code honours it). */
export function claudeConfigDir(env: Env = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** `~/.claude/settings.json`: where `init` writes the deny rules (§11.2). */
export function userSettingsPath(env: Env = process.env): string {
  return join(claudeConfigDir(env), 'settings.json');
}
