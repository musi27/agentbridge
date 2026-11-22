import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHelperResponse, presenceResultFrom, presenceMessage, encodeHelperRequest, HelperProtocolError, LA_ERROR } from '../src/protocol.ts';

test('parseHelperResponse accepts each documented response shape', () => {
  assert.deepEqual(parseHelperResponse('{"ok":true}\n'), { ok: true });
  assert.deepEqual(parseHelperResponse('{"ok":true,"value":null}'), { ok: true, value: null });
  assert.deepEqual(parseHelperResponse('{"ok":true,"value":"x\\"y"}'), { ok: true, value: 'x"y' });
  assert.deepEqual(parseHelperResponse('{"deleted":false,"ok":true}'), { ok: true, deleted: false });
  assert.deepEqual(parseHelperResponse('{"ok":true,"protocol":1,"version":"0.1.0"}'), { ok: true, protocol: 1, version: '0.1.0' });
  assert.deepEqual(
    parseHelperResponse('{"detail":"Authentication canceled.","la_code":-2,"ok":false,"stage":"evaluate"}'),
    { ok: false, detail: 'Authentication canceled.', la_code: -2, stage: 'evaluate' },
  );
  assert.deepEqual(parseHelperResponse('{"detail":"x","error":"keychain","ok":false,"os_status":-25293}'), { ok: false, detail: 'x', error: 'keychain', os_status: -25293 });
});

test('parseHelperResponse rejects malformed output', () => {
  for (const bad of ['', '   ', 'not json', '[]', 'null', '"ok"', '{}', '{"ok":"true"}', '{"ok":true}\n{"ok":true}',
    '{"ok":false,"la_code":"-2"}', '{"ok":false,"la_code":1.5}', '{"ok":true,"value":5}', '{"ok":true,"deleted":"no"}', '{"ok":false,"detail":{}}']) {
    assert.throws(() => parseHelperResponse(bad), HelperProtocolError, JSON.stringify(bad));
  }
});

test('encodeHelperRequest produces one JSON line', () => {
  const line = encodeHelperRequest({ service: 's', account: 'a', value: 'line1\nline2 "q" \\' });
  assert.equal(line.split('\n').length, 2);
  assert.deepEqual(JSON.parse(line), { service: 's', account: 'a', value: 'line1\nline2 "q" \\' });
});

test('LAError codes map to PresenceResult codes (§9.2)', () => {
  const code = (la_code: number) => {
    const r = presenceResultFrom({ ok: false, la_code, detail: 'd' });
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(code(LA_ERROR.userCancel), 'cancelled');
  assert.equal(code(-2), 'cancelled');
  assert.equal(code(-1), 'failed');
  assert.equal(code(-4), 'system_cancel');
  assert.equal(code(-5), 'unavailable');
  assert.equal(code(-6), 'unavailable');
  assert.equal(code(-7), 'unavailable');
  assert.equal(code(-8), 'unavailable');
  assert.equal(code(-1004), 'unavailable');
  assert.equal(code(-11), 'unavailable');
  assert.equal(code(-12), 'unavailable');
  assert.equal(code(-13), 'unavailable');
  assert.equal(code(-3), 'error');
  assert.equal(code(-9), 'error');
  assert.equal(code(-10), 'error');
  assert.equal(code(-99), 'error');
});

test('presenceResultFrom keeps detail, and handles ok / missing la_code', () => {
  assert.deepEqual(presenceResultFrom({ ok: true }), { ok: true, method: 'biometric_or_password' });
  assert.deepEqual(presenceResultFrom({ ok: false, la_code: -2, detail: 'Authentication canceled.' }), { ok: false, code: 'cancelled', detail: 'Authentication canceled.' });
  assert.deepEqual(presenceResultFrom({ ok: false, la_code: -2 }), { ok: false, code: 'cancelled' });
  assert.deepEqual(presenceResultFrom({ ok: false, error: 'bad_request', detail: 'missing reason' }), { ok: false, code: 'error', detail: 'missing reason' });
  assert.deepEqual(presenceResultFrom({ ok: false, la_code: -9, detail: 'x' }), { ok: false, code: 'error', detail: 'LAError -9: x' });
  assert.deepEqual(presenceResultFrom({ ok: false, stage: 'timeout', la_code: -9, detail: 'no response within 5 ms' }), { ok: false, code: 'error', detail: 'timed out: no response within 5 ms' });
});

test('presenceMessage has a distinct message per code', () => {
  const msgs = (['cancelled', 'failed', 'system_cancel', 'unavailable', 'error'] as const).map((c) => presenceMessage({ ok: false, code: c }));
  assert.equal(new Set(msgs).size, msgs.length);
  assert.equal(presenceMessage({ ok: true, method: 'biometric_or_password' }), 'Confirmed.');
  assert.match(presenceMessage({ ok: false, code: 'error', detail: 'boom' }), /boom/);
});
