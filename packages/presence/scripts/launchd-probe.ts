// Opt-in manual test (M0 open question, SPEC §20 M1): do the Touch ID presence check and an osascript
// notification work when launched from a launchd agent (no terminal)?
//
//   npm run launchd-probe -w @agentbridge/presence [-- --notify-only]
//
// --notify-only: one notification after a 5 s delay, no Touch ID panel (isolates the popup question).
// Installs a throwaway agent `live.musi.agentbridge.probe` (plist in a temp dir, NOT in
// ~/Library/LaunchAgents) through LaunchdServiceManager, waits for the job to report, prints the
// result, then boots the job out and deletes everything. A Touch ID / password dialog and a
// notification will appear: approve the dialog (or cancel it, to test that path).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { LaunchdServiceManager } from '../src/launchd.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
execFileSync('/bin/sh', [join(here, '..', 'native', 'build.sh'), '--if-missing'], { stdio: 'inherit' });

const work = mkdtempSync(join(tmpdir(), 'ab-launchd-probe-'));
const out = join(work, 'result.json');
const notifyOnly = process.argv.includes('--notify-only');
const marker = `probe-${randomBytes(2).toString('hex')}`;
const mgr = new LaunchdServiceManager({
  label: 'live.musi.agentbridge.probe',
  launchAgentsDir: work,
  environment: { AB_PROBE_OUT: out, AB_PROBE_MODE: notifyOnly ? 'notify' : 'full', AB_PROBE_MARKER: marker },
});

let exitCode = 1;
try {
  await mgr.install({ nodePath: process.execPath, entry: join(here, 'launchd-probe-job.ts'), logDir: join(work, 'logs') });
  console.log(`installed ${mgr.serviceTarget} (plist ${mgr.plistPath}); status: ${await mgr.status()}`);
  console.log(notifyOnly
    ? `Notify-only: a notification titled "agentbridge ${marker}" should appear in about 5 s.`
    : `Waiting up to 3 minutes: approve the first Touch ID dialog; leave the second ("4-second timeout") alone. Notification marker: ${marker}`);
  const deadline = Date.now() + 180_000;
  while (!existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  if (existsSync(out)) {
    console.log(readFileSync(out, 'utf8'));
    exitCode = 0;
  } else {
    console.log('no result within 3 minutes');
  }
  const errLog = join(work, 'logs', 'bridge.err.log');
  if (existsSync(errLog) && readFileSync(errLog, 'utf8').trim() !== '') console.log(`job stderr:\n${readFileSync(errLog, 'utf8')}`);
} finally {
  await mgr.uninstall();
  console.log(`uninstalled; status: ${await mgr.status()}`);
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
