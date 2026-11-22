// Setup marker (§14.1): `agentbridge init` writes run/setup.lock ("<pid> <ms since epoch>", 0600) before it stops the
// bridge, and removes it when done. While it is live, on-demand starts (the plugin's SessionStart hook, `agentbridge
// start`) must not spawn a bridge, so init can take the single-instance lock. Stale after SETUP_MARKER_STALE_MS or
// when its pid is dead.
export const SETUP_MARKER_FILE = 'setup.lock'; // inside <agentbridge home>/run
export const SETUP_MARKER_STALE_MS = 5 * 60_000;

export function formatSetupMarker(pid: number, now: number): string { return `${pid} ${now}\n`; }

/** Is a marker with this content still in force? `alive(pid)` checks the process exists. */
export function setupMarkerLive(text: string | null, now: number, alive: (pid: number) => boolean): boolean {
  if (!text) return false;
  const m = /^(\d+) (\d+)\s*$/.exec(text);
  if (!m) return false;
  const pid = Number(m[1]); const at = Number(m[2]);
  if (!(now - at < SETUP_MARKER_STALE_MS) || at > now + 60_000) return false;
  return alive(pid);
}

/** process.kill(pid, 0) semantics: EPERM means it exists (another user), ESRCH means gone. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === 'EPERM'; }
}
