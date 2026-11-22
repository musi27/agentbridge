import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from '../src/index.ts';

const item = (n: number) => ({ item_id: `01JD00000000000000000000${String(n).padStart(2, '0')}`, messages: [{ message_id: 'm', seq: n, from_address: 'fake:a', body: `b${n}`, created_at: 'now' }], notices: [], reply_to: null });
const to = { participant_id: 'p1', address: 'fake:p1', agent: 'fake' as const };

test('fake adapter: records deliveries and scripted outcomes', async () => {
  const a = new FakeAdapter();
  assert.equal(a.describe().agent, 'fake'); assert.equal(a.capabilities().native_confirm, true);
  assert.deepEqual(await a.deliver(item(1), to), { status: 'delivered' });
  a.nextOutcome(() => ({ status: 'failed', reason: 'host_refused', retryable: true }));
  assert.equal((await a.deliver(item(2), to)).status, 'failed');
  a.setParticipantOutcome('p1', () => ({ status: 'queued' }));
  assert.equal((await a.deliver(item(3), to)).status, 'queued');
  a.setParticipantOutcome('p1', null);
  await a.deliver(item(4), to);
  assert.deepEqual(a.bodies('p1'), ['b1', 'b4']);
  assert.equal(a.log.length, 4);
});

test('fake adapter: can pose as grok and waitFor resolves', async () => {
  const g = new FakeAdapter({ agent: 'grok' });
  assert.equal(g.capabilities().native_confirm, false);
  const w = g.waitFor(() => g.inbox('p1').length === 1);
  await g.deliver(item(1), to); await w;
  await assert.rejects(g.waitFor(() => false, 20));
});
