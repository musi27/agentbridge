import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInbound } from '../src/inbound.ts';

test('§11.3 effective crossSessionInbound: managed > project/local refuse > local > project > user', () => {
  const d = mkdtempSync('/tmp/ab-in-'); const home = join(d, 'home'); const cwd = join(d, 'proj'); const managed = join(d, 'managed.json');
  const set = (path: string, v: string | null): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, v === null ? '{}' : JSON.stringify({ crossSessionInbound: v })); };
  const user = join(home, '.claude', 'settings.json'); const proj = join(cwd, '.claude', 'settings.json'); const local = join(cwd, '.claude', 'settings.local.json');
  try {
    const eff = (): string => effectiveInbound(cwd, { home, managed });
    assert.equal(eff(), 'accept');
    set(user, 'hold'); assert.equal(eff(), 'hold');
    set(proj, 'accept'); assert.equal(eff(), 'accept');
    set(local, 'hold'); assert.equal(eff(), 'hold');
    set(user, 'accept'); set(proj, 'refuse'); set(local, 'accept'); assert.equal(eff(), 'refuse');
    set(managed, 'accept'); assert.equal(eff(), 'accept');
    writeFileSync(local, '{broken'); set(proj, null); rmSync(managed); assert.equal(eff(), 'accept');
    assert.equal(effectiveInbound(null, { home, managed }), 'accept');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
