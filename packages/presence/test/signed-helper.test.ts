// The committed Developer ID-signed AgentBridge.app (signed/, what releases ship) and the checks release packing runs.
// Checking a signature needs no key, so this runs for every contributor. A source change since the signing is only a
// diagnostic here (contributors can't re-sign); release packing refuses it (packaging/npm/scripts/build.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkSignature, checkSignedHelper, IDENTIFIER, PRESENCE_DIR, readManifest, SIGNED_APP, SOURCE_FILES, sourceHashes, sourcesHash, TEAM_ID,
} from '../scripts/signed-helper.ts';
import { ensureHelper } from './helpers.ts';

const mac = process.platform === 'darwin';
const failed = (checks: Array<{ id: string; ok: boolean; detail: string }>) => checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);

function copySources(): string {
  const d = mkdtempSync(join(tmpdir(), 'ab-src-'));
  for (const f of SOURCE_FILES) { mkdirSync(dirname(join(d, f)), { recursive: true }); cpSync(join(PRESENCE_DIR, f), join(d, f)); }
  return d;
}

test('sources hash covers every helper source and changes with any of them', () => {
  assert.deepEqual(SOURCE_FILES, ['native/main.swift', 'native/PanelModel.swift', 'native/PanelApp.swift', 'native/Info.plist', 'native/AppIcon.icns', 'native/build.sh']);
  // build.sh compiles exactly the Swift files the manifest covers, and every .swift file in native/ is one of them
  const build = readFileSync(join(PRESENCE_DIR, 'native', 'build.sh'), 'utf8');
  const compiled = [.../swift_files="([^"]+)"/.exec(build)![1]!.matchAll(/\$here\/(\S+\.swift)/g)].map((m) => `native/${m[1]}`);
  assert.deepEqual(compiled, SOURCE_FILES.filter((f) => f.endsWith('.swift')));
  assert.deepEqual(readdirSync(join(PRESENCE_DIR, 'native')).filter((f) => f.endsWith('.swift')).map((f) => `native/${f}`).sort(), [...compiled].sort());
  const d = copySources();
  try {
    const base = sourcesHash(sourceHashes(d));
    assert.equal(base, sourcesHash(sourceHashes()));
    for (const f of SOURCE_FILES) {
      const e = copySources();
      writeFileSync(join(e, f), 'changed');
      assert.notEqual(sourcesHash(sourceHashes(e)), base, f);
      rmSync(e, { recursive: true, force: true });
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('committed signed/AgentBridge.app: Developer ID of our team, hardened runtime, timestamp, designated requirement', { skip: !mac && 'macOS only' }, () => {
  assert.deepEqual(failed(checkSignature(SIGNED_APP)), []);
  const m = readManifest();
  assert.ok(m, 'signed/manifest.json');
  assert.equal(m.teamId, TEAM_ID);
  assert.equal(m.identifier, IDENTIFIER);
});

test('signed bundle matches its manifest; a source change is reported as needing a re-sign', { skip: !mac && 'macOS only' }, (t) => {
  const checks = checkSignedHelper();
  assert.ok(checks.find((c) => c.id === 'signed_manifest')?.ok, failed(checks).join('\n'));
  const sources = checks.find((c) => c.id === 'signed_sources')!;
  if (!sources.ok) t.diagnostic(`${sources.detail} (release packing will refuse until the owner re-signs)`);
  const d = copySources();
  try {
    writeFileSync(join(d, 'native', 'main.swift'), '// edited\n', { flag: 'a' });
    const s = checkSignedHelper(SIGNED_APP, undefined, d).find((c) => c.id === 'signed_sources')!;
    assert.equal(s.ok, false);
    assert.match(s.detail, /native\/main\.swift.*re-sign on your Mac/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the ad-hoc dev build (bin/) does not pass as a release signature', (t) => {
  const h = ensureHelper();
  if ('skip' in h) return t.skip(h.skip);
  const bad = new Set(checkSignature(join(h.path, '..', '..', '..')).filter((c) => !c.ok).map((c) => c.id));
  for (const id of ['signed_not_adhoc', 'signed_runtime', 'signed_timestamp', 'signed_requirement', 'signed_designated']) assert.ok(bad.has(id), id);
});
