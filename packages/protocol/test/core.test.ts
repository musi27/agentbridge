import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid, isUlid, shortId, newNonce, NONCE_RE, parseAddress, slugifyName, sanitizeLabel, sanitizeBody, preview, truncateChars, LIMITS, DIRECTION_FOR_KIND, REASONS } from '../src/index.ts';

test('ulid: format, uniqueness, monotonic within a millisecond', () => {
  const now = Date.now(); const ids = Array.from({ length: 2000 }, () => ulid(now));
  for (const id of ids) assert.ok(isUlid(id), id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ids);
  assert.ok(ulid(now + 1) > ids.at(-1)!);
  assert.equal(shortId('01JD0000000000000000000000').length, 6);
});

test('nonce: 8 lowercase hex, varies', () => {
  const a = newNonce(), b = newNonce();
  assert.match(a, NONCE_RE); assert.notEqual(a, b);
});

test('addresses parse strictly', () => {
  assert.deepEqual(parseAddress('grok:researcher'), { agent: 'grok', name: 'researcher' });
  for (const bad of ['researcher', 'grok:', ':x', 'gpt:x', 'grok:a b', 'grok:' + 'a'.repeat(65), 'claude:x:y']) assert.equal(parseAddress(bad), null, bad);
  assert.equal(slugifyName('Auth Refactor (v2) é'), 'Auth-Refactor-v2-e');
  assert.equal(slugifyName('!!!'), 'unnamed');
});

test('sanitizeLabel strips controls, bidi, zero-width, escapes, newlines; caps', () => {
  const evil = 'Hi‮​there\u0007\u001b[31mRED\u001b[0m\nline2\t\u0085x\u001b]0;title\u0007';
  assert.equal(sanitizeLabel(evil), 'HithereRED line2 x');
  assert.equal(Array.from(sanitizeLabel('😀'.repeat(200))).length, LIMITS.topicChars);
  assert.equal(sanitizeLabel('  a   b  '), 'a b');
});

test('sanitizeBody keeps \\n and \\t, strips others, normalises CR', () => {
  assert.equal(sanitizeBody('a\r\nb\rc\td\u0000e\u001b[2Jf'), 'a\nb\nc\tdef');
});

test('truncate and preview never split surrogates; preview cuts at word boundary', () => {
  assert.equal(truncateChars('😀😀😀', 2), '😀😀');
  const p = preview('word '.repeat(100), 50); assert.ok(Array.from(p).length <= 50); assert.ok(p.endsWith('…')); assert.ok(!p.includes('wor…'));
  assert.equal(preview('short', 50), 'short');
});

test('enum invariants', () => {
  assert.deepEqual(DIRECTION_FOR_KIND, { start: 'outgoing', accept: 'incoming', extend: 'none' });
  assert.ok((REASONS as readonly string[]).includes('recipient_unreachable'));
  assert.equal(new Set(REASONS).size, REASONS.length);
});

test('setup marker: live while its pid runs and it is fresh; stale or malformed markers are ignored', async () => {
  const { formatSetupMarker, setupMarkerLive, SETUP_MARKER_STALE_MS } = await import('../src/setup-marker.ts');
  const now = 1_000_000_000_000;
  assert.equal(setupMarkerLive(formatSetupMarker(42, now), now + 1000, () => true), true);
  assert.equal(setupMarkerLive(formatSetupMarker(42, now), now + 1000, () => false), false); // pid dead
  assert.equal(setupMarkerLive(formatSetupMarker(42, now), now + SETUP_MARKER_STALE_MS, () => true), false); // stale
  assert.equal(setupMarkerLive('garbage', now, () => true), false);
  assert.equal(setupMarkerLive(null, now, () => true), false);
});
