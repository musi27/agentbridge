// Effective Claude Code `crossSessionInbound` for a session's cwd (§11.3). Under `hold` or `refuse` our inbox
// posts never reach Claude, so the participant is marked unreachable. Precedence (Claude Code settings docs):
// managed settings win; a `refuse` in project or local settings applies over other sources; otherwise
// local > project > user. No value → the per-message default, which accepts posts from the session's own child.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Inbound } from './db/store.ts';

export const MANAGED_SETTINGS_MACOS = '/Library/Application Support/ClaudeCode/managed-settings.json';

function read(path: string): Inbound | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const v = (JSON.parse(readFileSync(path, 'utf8')) as { crossSessionInbound?: unknown }).crossSessionInbound;
    return v === 'accept' || v === 'hold' || v === 'refuse' ? v : undefined;
  } catch { return undefined; }
}

export function effectiveInbound(cwd: string | null, o: { home?: string; managed?: string } = {}): Inbound {
  const managed = read(o.managed ?? MANAGED_SETTINGS_MACOS);
  if (managed) return managed;
  const user = read(join(o.home ?? homedir(), '.claude', 'settings.json'));
  const project = cwd ? read(join(cwd, '.claude', 'settings.json')) : undefined;
  const local = cwd ? read(join(cwd, '.claude', 'settings.local.json')) : undefined;
  if (project === 'refuse' || local === 'refuse') return 'refuse';
  return local ?? project ?? user ?? 'accept';
}
