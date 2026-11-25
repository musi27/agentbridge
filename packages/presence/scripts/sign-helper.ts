// `npm run sign:helper -w @agentbridge/presence`: on the owner's Mac, build AgentBridge.app with native/build.sh and
// sign it with the agentbridge "Developer ID Application" certificate (hardened runtime, secure timestamp, identifier
// live.musi.agentbridge), replace signed/AgentBridge.app and write signed/manifest.json. Commit both afterwards.
// The identity is found in the keychain by Team ID and passed to codesign by its SHA-1, so its name (the company)
// never needs typing and is never printed. The private key never leaves the keychain.
// `--check`: only check the committed bundle and manifest (what release packing checks). Exit 1 on any failure.
// `--identity <sha1>`: use this identity when the keychain has several for the team.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Check, type Manifest, cdhash, checkSignature, checkSignedHelper, IDENTIFIER, MANIFEST, PRESENCE_DIR, SIGNED_APP,
  sourceHashes, sourcesHash, TEAM_ID,
} from './signed-helper.ts';

const report = (checks: Check[]): boolean => {
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
  return checks.every((c) => c.ok);
};

if (process.platform !== 'darwin') { console.error('sign-helper: macOS only'); process.exit(1); }
const args = process.argv.slice(2);
if (args.includes('--check')) process.exit(report(checkSignedHelper()) ? 0 : 1);

/** SHA-1s of the valid "Developer ID Application" identities of TEAM_ID in the user's keychains. */
function findIdentities(): string[] {
  const out = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const re = new RegExp(`^\\s*\\d+\\) ([0-9A-F]{40}) "Developer ID Application: .*\\(${TEAM_ID}\\)"$`, 'gm');
  return [...out.matchAll(re)].map((m) => m[1]!);
}

const i = args.indexOf('--identity');
const wanted = i >= 0 ? args[i + 1]?.toUpperCase() : undefined;
const ids = findIdentities();
const identity = wanted ?? ids[0];
if (!identity || (wanted && !ids.includes(wanted))) {
  console.error(wanted
    ? `sign-helper: ${wanted} is not a valid Developer ID Application identity of team ${TEAM_ID} in your keychain`
    : `sign-helper: no "Developer ID Application" identity of team ${TEAM_ID} in your keychain.\n` +
      'Create one (account holder) at developer.apple.com > Certificates > + > Developer ID Application, and install it in the login keychain.');
  process.exit(1);
}
if (!wanted && ids.length > 1) {
  console.error(`sign-helper: ${ids.length} Developer ID Application identities of team ${TEAM_ID}; pick one with --identity <sha1>:\n${ids.join('\n')}`);
  process.exit(1);
}

function signInto(tmp: string, identity: string): boolean {
  console.log(`building and signing with identity ${identity} (team ${TEAM_ID}); macOS may ask to allow codesign to use the key`);
  execFileSync('/bin/sh', [join(PRESENCE_DIR, 'native', 'build.sh'), '--out', tmp, '--identity', identity], { stdio: 'inherit' });
  const built = join(tmp, 'AgentBridge.app');
  if (!report(checkSignature(built))) { console.error('sign-helper: the new signature failed its checks; signed/ left unchanged'); return false; }
  rmSync(SIGNED_APP, { recursive: true, force: true });
  execFileSync('/usr/bin/ditto', ['--norsrc', '--noextattr', built, SIGNED_APP]);
  const files = sourceHashes();
  const manifest: Manifest = {
    sourcesSha256: sourcesHash(files),
    files,
    identifier: IDENTIFIER,
    teamId: TEAM_ID,
    cdhashes: { arm64: cdhash(SIGNED_APP, 'arm64') ?? '', x86_64: cdhash(SIGNED_APP, 'x86_64') ?? '' },
    swiftc: spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0]?.trim() ?? '',
    signedAt: new Date().toISOString(),
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('');
  const ok = report(checkSignedHelper());
  console.log(ok ? `\nsigned ${SIGNED_APP}\nCommit packages/presence/signed/ (AgentBridge.app + manifest.json).` : '\nsign-helper: checks failed');
  return ok;
}

const tmp = mkdtempSync(join(tmpdir(), 'ab-sign-'));
let ok = false;
try { ok = signInto(tmp, identity); } finally { rmSync(tmp, { recursive: true, force: true }); }
process.exit(ok ? 0 : 1);
