import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packDelivery, DELIVERY_END, LIMITS, type PackInput } from '../src/index.ts';

const conv = { id: '01JD0000000000000000000000', topic: 'Migration plan', peer: 'claude:auth-refactor', turn: 6, turn_limit: 30, state: 'active' as const };
const msg = (i: number, body: string) => ({ message_id: `01JD${String(i).padStart(22, '0')}`, seq: i, from: 'claude:auth-refactor', body, created_at: '2026-11-22T18:00:00.000Z' });
const size = (s: string) => Math.max(s.length, Buffer.byteLength(s, 'utf8'));

test('small delivery carries full bodies, end is the last key', () => {
  const r = packDelivery({ conversation: conv, messages: [msg(1, 'Is the migration done?')], replyTo: msg(1, '').message_id, notices: [] });
  assert.equal(r.truncated, false); assert.equal(r.payload.messages[0]!.body, 'Is the migration done?');
  assert.equal(Object.keys(r.payload).at(-1), 'end'); assert.equal(r.payload.end, DELIVERY_END);
  assert.equal(r.payload.conversation.turns_left, 24);
});

test('large body becomes a preview with length and truncated=true', () => {
  const body = 'This is a long design review. '.repeat(400);
  const r = packDelivery({ conversation: conv, messages: [msg(1, body)], replyTo: null, notices: [] });
  assert.equal(r.truncated, true); assert.equal(r.payload.messages[0]!.body, undefined);
  assert.ok(r.payload.messages[0]!.preview!.length <= LIMITS.grokPreviewChars);
  assert.equal(r.payload.messages[0]!.length, Array.from(body).length);
  assert.ok(size(r.json) <= LIMITS.grokDeliveryChars);
});

test('notice-only delivery', () => {
  const r = packDelivery({ conversation: conv, messages: [], replyTo: null, notices: [{ code: 'approval_expired', severity: 'warning', text: 'The approval expired.' }] });
  assert.deepEqual(r.payload.messages, []); assert.equal(r.payload.truncated, false); assert.equal(r.payload.reply_to, null);
});

test('stress: random inputs (incl. multi-byte) never exceed the budget in chars or bytes', () => {
  const alphabet = ['a', 'é', '😀', '中', ' ', '\n', '"', '\\'];
  let seed = 42; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const text = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
  for (let k = 0; k < 300; k++) {
    const input: PackInput = {
      conversation: { ...conv, topic: text(Math.floor(rnd() * 400)) },
      messages: Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => msg(i, text(Math.floor(rnd() * 6000)))),
      replyTo: null,
      notices: Array.from({ length: Math.floor(rnd() * 3) }, () => ({ code: 'x', severity: 'info' as const, text: text(Math.floor(rnd() * 800)) })),
    };
    const r = packDelivery(input);
    assert.ok(size(r.json) <= LIMITS.grokDeliveryChars, `case ${k}: ${size(r.json)}`);
    assert.equal(JSON.parse(r.json).end, DELIVERY_END);
  }
});
