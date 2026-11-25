// `node --conditions=agentbridge-source packages/presence/scripts/keychain-proof.ts [--show-dialog]`, on the owner's Mac:
// checks the one-item keychain store (src/keychain.ts) against a THROWAWAY keychain file with Developer ID builds. Never
// touches the login keychain or ~/.agentbridge.
//
// It builds three probes of native/main.swift whose keychain calls go to the throwaway file (kSecMatchSearchList /
// kSecUseKeychain) instead of the default keychains, each inside a bundle with the real Info.plist and icon: ad hoc,
// and Developer ID twice (different code, so different cdhashes). The probes run with
// SecKeychainSetUserInteractionAllowed(false), so a read that would show an access dialog fails instead (-25293): a
// passing step proves "no dialog". Then:
//   1. the old layout (one item per secret, 2 Grok bots = 11 items) saved by Developer ID build 1 → migration → no
//      dialog, every secret readable, old items gone, one item "saved keys" left;
//   2. that item read by Developer ID build 2 → silent; control: the ad-hoc build is refused (would ask) and warned;
//   3. migration SIGKILLed after each helper call in turn → the next run (build 2) recovers with nothing lost.
// --show-dialog: last, the ad-hoc probe reads with dialogs allowed, so you see the real dialog text. Click Deny.
// Signing uses the "Developer ID Application" identity of the project's team, by SHA-1 (as sign-helper does).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allSecretNames } from '@agentbridge/protocol';
import { COMBINED_ACCOUNT, MacKeychainStore, STAGING_ACCOUNT } from '../src/keychain.ts';
import { run, type Runner } from '../src/exec.ts';
import { PRESENCE_DIR, TEAM_ID } from './signed-helper.ts';

const SVC = 'agentbridge.test.proof';
const NAMES = allSecretNames(['b1', 'b2']);
const value = (n: string) => `dummy-${n}-${n.length}`;

function buildProbe(dir: string, kc: string, variant: string, identity: string | null): string {
  let src = readFileSync(join(PRESENCE_DIR, 'native', 'main.swift'), 'utf8');
  const patch = (from: string, to: string) => { if (!src.includes(from)) throw new Error(`main.swift changed; update the probe patch near: ${from}`); src = src.replace(from, to); };
  patch('let helperVersion = "0.1.0"', `let helperVersion = "probe-${variant}"
let probeKC: SecKeychain = { var k: SecKeychain?; _ = SecKeychainOpen(${JSON.stringify(kc)}, &k); return k! }()
let probeNoUI: Bool = { let off = FileManager.default.fileExists(atPath: ${JSON.stringify(`${kc}.noui`)}); if off { SecKeychainSetUserInteractionAllowed(false) }; return off }()`);
  patch('   kSecAttrAccount as String: str(req, "account")]', '   kSecAttrAccount as String: str(req, "account"),\n   kSecMatchSearchList as String: [probeKC]]');
  patch('  var add = q\n', '  var add = q\n  add.removeValue(forKey: kSecMatchSearchList as String)\n  add[kSecUseKeychain as String] = probeKC\n');
  patch('let req = readRequest()', '_ = probeNoUI\nlet req = readRequest()');
  const app = join(dir, variant, 'AgentBridge.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true }); mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(dir, variant, 'main.swift'), src);
  execFileSync('swiftc', ['-O', '-module-name', 'AgentBridge', '-suppress-warnings', '-o', join(app, 'Contents', 'MacOS', 'AgentBridge'), join(dir, variant, 'main.swift')], { stdio: ['ignore', 'ignore', 'inherit'] });
  execFileSync('/bin/cp', [join(PRESENCE_DIR, 'native', 'Info.plist'), join(app, 'Contents', 'Info.plist')]);
  execFileSync('/bin/cp', [join(PRESENCE_DIR, 'native', 'AppIcon.icns'), join(app, 'Contents', 'Resources', 'AppIcon.icns')]);
  const sign = identity ? ['--options', 'runtime', '--timestamp', '--sign', identity] : ['--sign', '-'];
  execFileSync('/usr/bin/codesign', ['--force', '--identifier', 'live.musi.agentbridge', ...sign, app], { stdio: 'ignore' });
  return join(app, 'Contents', 'MacOS', 'AgentBridge');
}

const runnerFor = (kc: string): Runner => (file, args, o) => run(file, file === '/usr/bin/security' ? [...args, kc] : args, o);
const storeFor = (kc: string, helperPath: string, stateDir: string, runner: Runner = runnerFor(kc)) => new MacKeychainStore({ runner, helperPath, service: SVC, stateDir });

// child mode (step 3): migrate with build 1, SIGKILL right after the k-th helper call returns
if (process.argv[2] === '--child') {
  const [kc, helper, st, k] = process.argv.slice(3) as [string, string, string, string];
  let n = 0;
  const base = runnerFor(kc);
  const killing: Runner = async (f, a, o) => { const r = await base(f, a, o); if (f === helper && ++n === Number(k)) process.kill(process.pid, 'SIGKILL'); return r; };
  await storeFor(kc, helper, st, killing).prepare({ legacyNames: NAMES, notice: () => {} });
  process.exit(0);
}

if (process.platform !== 'darwin') { console.error('keychain-proof: macOS only'); process.exit(1); }
const ids = [...execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  .matchAll(new RegExp(`^\\s*\\d+\\) ([0-9A-F]{40}) "Developer ID Application: .*\\(${TEAM_ID}\\)"$`, 'gm'))].map((m) => m[1]!);
if (ids.length === 0) { console.error(`keychain-proof: needs the "Developer ID Application" identity of team ${TEAM_ID} (owner's Mac)`); process.exit(1); }

const work = mkdtempSync(join(tmpdir(), 'ab-keychain-proof-'));
const kc = join(work, 'throwaway.keychain-db');
let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed++; };
const sec = (...a: string[]) => execFileSync('/usr/bin/security', a, { encoding: 'utf8' });
const freshKeychain = (noUi: boolean) => {
  if (existsSync(kc)) sec('delete-keychain', kc);
  sec('create-keychain', '-p', 'throwaway', kc); sec('set-keychain-settings', kc); sec('unlock-keychain', '-p', 'throwaway', kc);
  if (noUi) writeFileSync(`${kc}.noui`, ''); else rmSync(`${kc}.noui`, { force: true });
};
const accounts = () => [...sec('dump-keychain', kc).matchAll(/"acct"<blob>="([^"]*)"/g)].map((m) => m[1]!).sort();
const onlyCombined = () => JSON.stringify(accounts()) === JSON.stringify([COMBINED_ACCOUNT]);
const st = () => mkdtempSync(join(work, 'state-'));
const seedOld = async (helper: string) => { const s = storeFor(kc, helper, st()); for (const n of NAMES) await s.items.set(n, value(n)); };
const allPresent = async (s: MacKeychainStore) => { for (const n of NAMES) if ((await s.get(n)) !== value(n)) return false; return true; };

try {
  console.log('building probes (ad hoc, Developer ID ×2); macOS may ask to allow codesign to use the key');
  const ADHOC = buildProbe(work, kc, 'adhoc', null);
  const DEV1 = buildProbe(work, kc, 'devid1', ids[0]!);
  const DEV2 = buildProbe(work, kc, 'devid2', ids[0]!);

  // 1.
  freshKeychain(true); await seedOld(DEV1);
  check(accounts().length === NAMES.length, `old layout saved by Developer ID build 1: ${accounts().length} items`);
  const s1 = st(); const notes: string[] = [];
  const r = await storeFor(kc, DEV1, s1).prepare({ legacyNames: NAMES, notice: (l) => notes.push(l) });
  check(r.copied === NAMES.length && r.removed === NAMES.length && onlyCombined(), `migration by build 1, dialogs disallowed: copied ${r.copied}, deleted ${r.removed}, items now ${JSON.stringify(accounts())}`);
  console.log(`      notice printed first (no trust marker yet): ${JSON.stringify(notes)}`);
  check(await allPresent(storeFor(kc, DEV1, s1)), `all ${NAMES.length} secrets read back`);
  const desc = [...new Set([...sec('dump-keychain', '-a', kc).matchAll(/description: (.*)/g)].map((m) => m[1]!))];
  console.log(`      the item's access-list description (the name in the dialog): ${JSON.stringify(desc)}`);

  // 2.
  check(await allPresent(storeFor(kc, DEV2, s1)), 'the combined item read by Developer ID build 2 (different code), dialogs disallowed: silent');
  const n2: string[] = []; await storeFor(kc, DEV2, s1).prepare({ legacyNames: NAMES, notice: (l) => n2.push(l) });
  check(n2.length === 0, 'prepare with build 2: no notice (same team)');
  let refused = ''; try { await storeFor(kc, ADHOC, s1).get(NAMES[0]!); } catch (e) { refused = (e as Error).message; }
  check(refused.includes('-25293') || refused.includes('-25308'), `control: the ad-hoc build is refused (it would have asked): ${refused}`);
  const n3: string[] = []; try { await storeFor(kc, ADHOC, s1).prepare({ legacyNames: NAMES, notice: (l) => n3.push(l) }); } catch { /* refused */ }
  check(n3.length === 1, `control: the ad-hoc build gets the notice first: ${JSON.stringify(n3)}`);

  // 3.
  freshKeychain(true); await seedOld(DEV1);
  let calls = 0; const base = runnerFor(kc);
  await storeFor(kc, DEV1, st(), (f, a, o) => { if (f === DEV1) calls++; return base(f, a, o); }).prepare({ legacyNames: NAMES, notice: () => {} });
  let recovered = 0;
  for (let k = 1; k <= calls; k++) {
    freshKeychain(true); await seedOld(DEV1);
    const sk = st();
    const c = spawnSync(process.execPath, ['--conditions=agentbridge-source', new URL(import.meta.url).pathname, '--child', kc, DEV1, sk, String(k)], { encoding: 'utf8' });
    const left = accounts();
    const s = storeFor(kc, DEV2, sk);
    const before = await allPresent(s);
    await s.prepare({ legacyNames: NAMES, notice: () => {} });
    const ok = c.signal === 'SIGKILL' && before && await allPresent(s) && onlyCombined();
    if (ok) recovered++;
    console.log(`      killed after call ${k}: ${left.length} items${left.includes(STAGING_ACCOUNT) ? ' (incl. update item)' : ''}${left.includes(COMBINED_ACCOUNT) ? ' (incl. combined)' : ''} → ${ok ? 'recovered' : 'LOST'}`);
  }
  check(recovered === calls, `migration killed after each of its ${calls} helper calls: ${recovered}/${calls} recovered by build 2, nothing lost`);

  if (process.argv.includes('--show-dialog')) {
    freshKeychain(false); await storeFor(kc, DEV1, st()).set(NAMES[0]!, 'dummy');
    console.log('showing the real dialog (ad-hoc probe reading the item): read its text, then click Deny');
    try { await storeFor(kc, ADHOC, st()).get(NAMES[0]!); } catch { /* denied */ }
  }
} finally {
  if (existsSync(kc)) sec('delete-keychain', kc);
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
