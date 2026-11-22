import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/clock.ts';
import { ApprovalStore, type Approval } from '../src/core/approvals.ts';

function mk() {
  const clock = new FakeClock(); const expired: Approval[] = [];
  const s = new ApprovalStore({ clock, timeoutMs: () => 600_000, onExpire: (a) => expired.push(a) });
  return { clock, s, expired };
}
const ctx = { kind: 'start' as const, recipient_id: 'r', topic: 't', first_message: 'hi', turn_limit: 30, continues: null };

test('approvals: facts carry kind-fixed direction; exact match required', () => {
  const { s } = mk();
  const a = s.issue({ kind: 'start', participant_id: 'p', epoch: 3, peer: 'grok:x', topic: 'Topic', turn_limit: 30, context: ctx });
  assert.equal(a.facts.direction, 'outgoing');
  assert.equal(s.check({ participant_id: 'p', epoch: 3 }, a.facts).ok, true);
  for (const bad of [{ kind: 'accept' }, { peer: 'grok:y' }, { direction: 'incoming' }, { topic: 'topic' }, { topic: 'Topic ' }, { turn_limit: 31 }] as const) {
    assert.deepEqual(s.check({ participant_id: 'p', epoch: 3 }, { ...a.facts, ...bad } as typeof a.facts), { ok: false, reason: 'approval_mismatch' }, JSON.stringify(bad));
  }
  assert.deepEqual(s.check({ participant_id: 'q', epoch: 3 }, a.facts), { ok: false, reason: 'approval_mismatch' });
  assert.deepEqual(s.check({ participant_id: 'p', epoch: 4 }, a.facts), { ok: false, reason: 'approval_mismatch' });
  assert.deepEqual(s.check({ participant_id: 'p', epoch: 3 }, { ...a.facts, approval_id: '01JD0000000000000000000000' }), { ok: false, reason: 'unknown_approval' });
  assert.equal(s.issue({ kind: 'accept', participant_id: 'p', epoch: 3, peer: 'grok:x', topic: 'T', turn_limit: 30, context: { kind: 'accept', conversation_id: 'c' } }).facts.direction, 'incoming');
  assert.equal(s.issue({ kind: 'extend', participant_id: 'p', epoch: 3, peer: 'grok:x', topic: 'T', turn_limit: 40, context: { kind: 'extend', conversation_id: 'c', new_limit: 40 } }).facts.direction, 'none');
});

test('approvals: resolve once; expiry after the timeout fires onExpire', async () => {
  const { s, clock, expired } = mk();
  const a = s.issue({ kind: 'start', participant_id: 'p', epoch: 1, peer: 'grok:x', topic: 'T', turn_limit: 30, context: ctx });
  const b = s.issue({ kind: 'start', participant_id: 'p', epoch: 1, peer: 'grok:x', topic: 'T', turn_limit: 30, context: ctx });
  assert.ok(s.resolve(a.facts.approval_id, 'confirmed'));
  assert.equal(s.resolve(a.facts.approval_id, 'confirmed'), undefined);
  assert.equal(s.check({ participant_id: 'p', epoch: 1 }, a.facts).ok, false);
  await clock.advance(599_999); assert.equal(expired.length, 0);
  await clock.advance(1); assert.deepEqual(expired.map((x) => x.facts.approval_id), [b.facts.approval_id]);
  assert.equal(expired[0]!.state, 'expired');
  assert.equal(s.get(b.facts.approval_id), undefined);
});

test('approvals: deferred timer starts on hand-off (accept)', async () => {
  const { s, clock, expired } = mk();
  const a = s.issue({ kind: 'accept', participant_id: 'p', epoch: 1, peer: 'grok:x', topic: 'T', turn_limit: 30, context: { kind: 'accept', conversation_id: 'c' }, startTimer: false });
  assert.equal(a.expires_at, null);
  await clock.advance(3_600_000); assert.equal(expired.length, 0);
  s.startTimer(a.facts.approval_id);
  assert.equal(a.expires_at, clock.now() + 600_000);
  await clock.advance(600_000); assert.equal(expired.length, 1);
});

test('approvals: clear drops all without callbacks (restart)', async () => {
  const { s, clock, expired } = mk();
  s.issue({ kind: 'start', participant_id: 'p', epoch: 1, peer: 'grok:x', topic: 'T', turn_limit: 30, context: ctx });
  s.clear(); await clock.advance(700_000);
  assert.equal(expired.length, 0); assert.equal(s.all().length, 0);
});
