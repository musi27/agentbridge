// The Developer ID-signed AgentBridge.app that releases ship (docs/release-signing.md).
// The owner builds and signs it on their Mac (scripts/sign-helper.ts) and commits it at signed/AgentBridge.app with
// signed/manifest.json next to it. Release packing (packaging/npm/scripts/build.ts) copies it as is and never sees the
// key; it refuses to pack if the helper sources changed since the signing. Dev and tests keep the ad-hoc bin/ build.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Apple Developer Team ID of the signing certificate (public: it is in every signature it makes). */
export const TEAM_ID = '67B9AY2VHJ';
/** Code signing identifier = the bundle id, in the ad-hoc and the Developer ID signature alike. */
export const IDENTIFIER = 'live.musi.agentbridge';

export const PRESENCE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const SIGNED_DIR = join(PRESENCE_DIR, 'signed');
export const SIGNED_APP = join(SIGNED_DIR, 'AgentBridge.app');
export const MANIFEST = join(SIGNED_DIR, 'manifest.json');

/** Everything the bundle is built from. A change to any of these means the committed bundle is stale. */
export const SOURCE_FILES = ['native/main.swift', 'native/Info.plist', 'native/AppIcon.icns', 'native/build.sh'] as const;

/**
 * What the signature must satisfy: Apple-anchored Developer ID Application certificate (OID ...6.1.13) of our team,
 * signing our identifier. This is also what the keychain then trusts, so any later signed build reads silently.
 */
export const REQUIREMENT = `anchor apple generic and identifier "${IDENTIFIER}" and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${TEAM_ID}"`;

export interface Manifest {
  /** sha256 over SOURCE_FILES (see sourcesHash) */
  sourcesSha256: string;
  files: Record<string, string>;
  identifier: string;
  teamId: string;
  /** cdhash per architecture slice of the signed executable */
  cdhashes: Record<string, string>;
  swiftc: string;
  signedAt: string;
}

export function sourceHashes(dir = PRESENCE_DIR): Record<string, string> {
  return Object.fromEntries(SOURCE_FILES.map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]));
}

/** sha256 of "<path> <sha256>\n" lines in SOURCE_FILES order. */
export function sourcesHash(files = sourceHashes()): string {
  return createHash('sha256').update(SOURCE_FILES.map((f) => `${f} ${files[f]}\n`).join('')).digest('hex');
}

export function readManifest(path = MANIFEST): Manifest | undefined {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Manifest : undefined;
}

const codesign = (args: string[]) => {
  const r = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};

/** cdhash of one architecture slice, from `codesign -dvvv`. */
export function cdhash(app: string, arch: string): string | undefined {
  return /^CDHash=([0-9a-f]+)$/m.exec(codesign(['-dvvv', '--arch', arch, app]).out)?.[1];
}

export interface Check { id: string; ok: boolean; detail: string }

/**
 * Checks a bundle's Developer ID signature: seal valid (--strict), not ad hoc, hardened runtime, secure timestamp,
 * team + identifier, and a designated requirement of anchor apple generic + identifier + team. Never prints the
 * certificate's subject name (it names the company; it stays inside the signature, out of logs and repo text).
 */
export function checkSignature(app: string): Check[] {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string) => { checks.push({ id, ok, detail }); };
  if (!existsSync(join(app, 'Contents', 'MacOS', 'AgentBridge'))) return [{ id: 'signed_present', ok: false, detail: `no bundle at ${app}` }];
  const strict = codesign(['--verify', '--strict', app]);
  add('signed_seal', strict.ok, strict.ok ? 'codesign --verify --strict: valid' : `seal broken: ${strict.out.trim().slice(0, 300)}`);
  const d = codesign(['-dvvv', app]).out;
  const field = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(d)?.[1];
  add('signed_not_adhoc', !/Signature=adhoc/.test(d) && field('TeamIdentifier') === TEAM_ID,
    `TeamIdentifier=${field('TeamIdentifier') ?? 'none'}${/Signature=adhoc/.test(d) ? ', ad hoc' : ''}`);
  add('signed_identifier', field('Identifier') === IDENTIFIER, `Identifier=${field('Identifier') ?? 'none'}`);
  add('signed_runtime', /flags=0x[0-9a-f]*\([^)]*\bruntime\b[^)]*\)/.test(d), 'hardened runtime flag');
  add('signed_timestamp', field('Timestamp') !== undefined, `secure timestamp ${field('Timestamp') ?? 'missing'}`);
  const req = codesign(['--verify', '--strict', `-R=${REQUIREMENT}`, app]);
  add('signed_requirement', req.ok, req.ok ? 'satisfies Developer ID Application + team + identifier' : req.out.trim().slice(0, 300));
  const dr = /designated => (.*)$/m.exec(codesign(['-d', '-r-', app]).out)?.[1] ?? '';
  // codesign writes it as: identifier "…" and anchor apple generic and … certificate leaf[subject.OU] = "TEAM"
  const drOk = /\banchor apple generic\b/.test(dr) && dr.includes(`identifier "${IDENTIFIER}"`) && dr.includes(`certificate leaf[subject.OU] = "${TEAM_ID}"`);
  add('signed_designated', drOk, drOk ? `designated requirement: anchor apple generic + identifier ${IDENTIFIER} + team ${TEAM_ID}` : `designated requirement is not anchor apple generic + identifier + team: ${dr.slice(0, 160) || 'missing'}`);
  return checks;
}

/** checkSignature plus: the manifest matches the bundle (cdhashes) and the current sources (sourcesSha256). */
export function checkSignedHelper(app = SIGNED_APP, manifestPath = MANIFEST, dir = PRESENCE_DIR): Check[] {
  const checks = checkSignature(app);
  const m = readManifest(manifestPath);
  if (!m) return [...checks, { id: 'signed_manifest', ok: false, detail: `no manifest at ${manifestPath}` }];
  const archs = Object.keys(m.cdhashes).sort();
  const actual = Object.fromEntries(archs.map((a) => [a, cdhash(app, a)]));
  checks.push({ id: 'signed_manifest', ok: archs.join(',') === 'arm64,x86_64' && archs.every((a) => actual[a] === m.cdhashes[a]),
    detail: archs.every((a) => actual[a] === m.cdhashes[a]) ? `bundle cdhashes match the manifest (signed ${m.signedAt})` : 'bundle does not match signed/manifest.json: re-sign on your Mac (npm run sign:helper -w @agentbridge/presence)' });
  const now = sourceHashes(dir);
  const changed = SOURCE_FILES.filter((f) => now[f] !== m.files[f]);
  checks.push({ id: 'signed_sources', ok: sourcesHash(now) === m.sourcesSha256 && changed.length === 0,
    detail: changed.length === 0 ? 'helper sources unchanged since signing' : `helper sources changed (${changed.join(', ')}): re-sign on your Mac (npm run sign:helper -w @agentbridge/presence)` });
  return checks;
}
