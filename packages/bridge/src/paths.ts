// Filesystem layout (§15.1). Everything lives under one root (default ~/.agentbridge); tests pass their own.
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  root: string; db: string; runDir: string; socket: string; lock: string; logsDir: string; configToml: string;
}

/** Root dir: explicit > $AGENTBRIDGE_HOME > ~/.agentbridge. Keep it short: macOS caps socket paths at 104 bytes. */
export function resolvePaths(root?: string): Paths {
  const r = root ?? process.env['AGENTBRIDGE_HOME'] ?? join(homedir(), '.agentbridge');
  const runDir = join(r, 'run');
  return {
    root: r, db: join(r, 'agentbridge.db'), runDir, socket: join(runDir, 'bridge.sock'), lock: join(runDir, 'bridge.lock'),
    logsDir: join(r, 'logs'), configToml: join(r, 'config.toml'),
  };
}
