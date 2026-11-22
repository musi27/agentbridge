import { test } from 'node:test';
import assert from 'node:assert/strict';
import { END_REASONS, ulid, shortId } from '@agentbridge/protocol';
import {
  transition, PENDING_END_REASONS, ACTIVE_END_REASONS, resolveTurnLimit, canSend, nextTurn, turnsLeft, turnWarning, checkExtend,
  requesterMode, recipientMode, canConfirm, checkInviteLimits, resolveAddress, uniqueName,
} from '../src/core/rules.ts';

test('§6.2 state machine: pending → active | ended(pending reasons); active → ended(active reasons); ended terminal', () => {
  assert.deepEqual(transition('pending', { type: 'accept' }), { ok: true, state: 'active' });
  assert.equal(transition('active', { type: 'accept' }).ok, false);
  for (const r of END_REASONS) {
    assert.equal(transition('pending', { type: 'end', reason: r }).ok, PENDING_END_REASONS.has(r), `pending/${r}`);
    assert.equal(transition('active', { type: 'end', reason: r }).ok, ACTIVE_END_REASONS.has(r), `active/${r}`);
    assert.deepEqual(transition('ended', { type: 'end', reason: r }), { ok: false, reason: 'conversation_ended' });
  }
  assert.deepEqual(transition('ended', { type: 'accept' }), { ok: false, reason: 'conversation_ended' });
  // the table's exact sets
  assert.deepEqual([...PENDING_END_REASONS].sort(), ['approval_expired', 'declined', 'ended_by_participant', 'invite_expired', 'participant_gone']);
  assert.deepEqual([...ACTIVE_END_REASONS].sort(), ['ended_by_participant', 'manual', 'participant_gone', 'turn_limit']);
});

test('§6.5 turn limit: default 30, max 200', () => {
  assert.equal(resolveTurnLimit(undefined, 30), 30);
  assert.equal(resolveTurnLimit(200, 30), 200);
  assert.equal(resolveTurnLimit(201, 30), null);
  assert.equal(resolveTurnLimit(0, 30), null);
  assert.equal(resolveTurnLimit(2.5, 30), null);
});

test('§6.5 sending: only active, below the limit; the limit message is accepted', () => {
  assert.deepEqual(canSend({ state: 'pending', turn_count: 0, turn_limit: 3 }), { ok: false, reason: 'invalid_message' });
  assert.deepEqual(canSend({ state: 'ended', turn_count: 1, turn_limit: 3 }), { ok: false, reason: 'conversation_ended' });
  assert.deepEqual(canSend({ state: 'active', turn_count: 3, turn_limit: 3 }), { ok: false, reason: 'turn_limit' });
  assert.deepEqual(canSend({ state: 'active', turn_count: 2, turn_limit: 3 }), { ok: true });
  assert.deepEqual(nextTurn({ turn_count: 2, turn_limit: 3 }), { turn: 3, reachesLimit: true });
  assert.deepEqual(nextTurn({ turn_count: 1, turn_limit: 3 }), { turn: 2, reachesLimit: false });
  assert.equal(turnsLeft({ turn_count: 28, turn_limit: 30 }), 2);
  assert.equal(turnWarning(28, 30), true); assert.equal(turnWarning(27, 30), false);
});

test('§6.5 extension: before the limit only, active only, capped at 200', () => {
  assert.deepEqual(checkExtend({ state: 'active', turn_count: 5, turn_limit: 30 }, 10), { ok: true, newLimit: 40 });
  assert.equal(checkExtend({ state: 'active', turn_count: 30, turn_limit: 30 }, 10).ok, false);
  assert.equal((checkExtend({ state: 'ended', turn_count: 3, turn_limit: 30 }, 10) as { reason: string }).reason, 'conversation_ended');
  assert.equal(checkExtend({ state: 'pending', turn_count: 0, turn_limit: 30 }, 10).ok, false);
  assert.equal(checkExtend({ state: 'active', turn_count: 5, turn_limit: 190 }, 11).ok, false);
  assert.equal(checkExtend({ state: 'active', turn_count: 5, turn_limit: 190 }, 10).ok, true);
  assert.equal(checkExtend({ state: 'active', turn_count: 5, turn_limit: 30 }, 0).ok, false);
});

test('§8.4 modes: bypass refused (unless overridden), auto warns, unknown holds, dontAsk cannot confirm', () => {
  assert.deepEqual(requesterMode('bypassPermissions', false), { ok: false, reason: 'requester_unsafe_mode' });
  assert.equal(requesterMode('bypassPermissions', true).ok, true);
  assert.deepEqual(requesterMode('auto', false), { ok: true, warning: true });
  assert.deepEqual(requesterMode('default', false), { ok: true, warning: false });
  assert.deepEqual(recipientMode('unknown', false), { ok: false, hold: true });
  assert.deepEqual(recipientMode('bypassPermissions', false), { ok: false, reason: 'recipient_unsafe_mode' });
  assert.equal(recipientMode('bypassPermissions', true).ok, true);
  assert.deepEqual(recipientMode('auto', false), { ok: true, warning: true });
  for (const m of ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'] as const) assert.equal(canConfirm(m), true, m);
  assert.equal(canConfirm('dontAsk'), false);
});

test('§8.3 invite limits: 3 per requester, 10 per target, 10-minute pair cooldown', () => {
  const l = { max_pending_per_remote: 3, max_pending_per_target: 10, cooldown_ms: 600_000 };
  const now = 1_000_000_000;
  assert.equal(checkInviteLimits({ pendingByRequester: 2, pendingForTarget: 9, lastPairRefusalAt: null }, l, now).ok, true);
  assert.equal(checkInviteLimits({ pendingByRequester: 3, pendingForTarget: 0, lastPairRefusalAt: null }, l, now).ok, false);
  assert.equal(checkInviteLimits({ pendingByRequester: 0, pendingForTarget: 10, lastPairRefusalAt: null }, l, now).ok, false);
  assert.equal(checkInviteLimits({ pendingByRequester: 0, pendingForTarget: 0, lastPairRefusalAt: now - 599_000 }, l, now).ok, false);
  assert.equal(checkInviteLimits({ pendingByRequester: 0, pendingForTarget: 0, lastPairRefusalAt: now - 600_000 }, l, now).ok, true);
});

test('§5 addressing: unique match, ambiguity with candidates, short id, gone ignored, folders local only', () => {
  const id1 = ulid(), id2 = ulid(), id3 = ulid();
  const all = [
    { id: id1, agent: 'claude' as const, name: 'api', state: 'live', cwd: '/w/api-one' },
    { id: id2, agent: 'claude' as const, name: 'api', state: 'closed', cwd: '/w/api-two' },
    { id: id3, agent: 'grok' as const, name: 'researcher', state: 'live', cwd: null },
  ];
  assert.deepEqual(resolveAddress(all, 'grok:researcher', { local: true }), { ok: true, id: id3 });
  const amb = resolveAddress(all, 'claude:api', { local: true });
  assert.equal(amb.ok, false);
  assert.equal(!amb.ok && amb.reason, 'recipient_ambiguous');
  assert.deepEqual(!amb.ok && amb.candidates?.map((c) => c.folder), ['api-one', 'api-two']);
  const ambRelay = resolveAddress(all, 'claude:api', { local: false });
  assert.deepEqual(!ambRelay.ok && ambRelay.candidates?.map((c) => c.folder), [undefined, undefined]);
  assert.deepEqual(resolveAddress(all, `claude:${shortId(id2)}`, { local: true }), { ok: true, id: id2 });
  assert.deepEqual(resolveAddress(all.map((p) => (p.id === id2 ? { ...p, state: 'gone' } : p)), 'claude:api', { local: true }), { ok: true, id: id1 });
  assert.equal((resolveAddress(all, 'grok:nobody', { local: true }) as { reason: string }).reason, 'recipient_gone');
  assert.equal((resolveAddress(all, 'not an address', { local: true }) as { reason: string }).reason, 'invalid_message');
  assert.equal((resolveAddress(all, 'grok:researcher', { local: true, excludeId: id3 }) as { reason: string }).reason, 'recipient_gone');
});

test('unique names get numeric suffixes', () => {
  assert.equal(uniqueName('api', new Set()), 'api');
  assert.equal(uniqueName('api', new Set(['api'])), 'api-2');
  assert.equal(uniqueName('api', new Set(['api', 'api-2'])), 'api-3');
  assert.equal(uniqueName('x'.repeat(64), new Set(['x'.repeat(64)])).length, 64);
});
