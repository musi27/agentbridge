import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DEFAULT_HELPER_PATH } from '../src/exec.ts';

const BUILD = new URL('../native/build.sh', import.meta.url).pathname;

/** Builds the real helper if needed. Returns its path, or a skip reason. */
export function ensureHelper(): { path: string } | { skip: string } {
  if (process.platform !== 'darwin') return { skip: 'macOS only' };
  try {
    execFileSync('/bin/sh', [BUILD, '--if-missing'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    return { skip: `cannot build AgentBridge.app: ${(e as { stderr?: Buffer }).stderr?.toString().trim() ?? String(e)}` };
  }
  return existsSync(DEFAULT_HELPER_PATH) ? { path: DEFAULT_HELPER_PATH } : { skip: 'helper not built' };
}
