// PR #4 integration: Touch ID reason wording and must-act popups (§9.1, §9.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_METHODS, type CliMethod } from '@agentbridge/protocol';
import { presenceReason } from '../src/ipc/cli-methods.ts';
import { MUST_ACT_POPUPS } from '../src/core/engine.ts';
import { harness } from './helpers.ts';

const VERBS = new Set(['approve', 'decline', 'change', 'verify', 'show', 'end', 'raise', 'stop', 'remove', 'delete', 'revoke', 'add', 'rotate', 'run']);
const privileged = (Object.keys(CLI_METHODS) as CliMethod[]).filter((m) => (CLI_METHODS[m] as { privileged?: boolean }).privileged);

test('every privileged reason is a lowercase verb phrase with no "agentbridge:" prefix ("<app> is trying to <reason>.")', () => {
  assert.ok(privileged.length >= 10);
  const approval = (kind: string) => ({ facts: { kind, peer: 'grok:researcher', turn_limit: 30 } });
  const engines = [
    { approvals: { get: () => undefined } },
    { approvals: { get: () => approval('start') } },
    { approvals: { get: () => approval('accept') } },
    { approvals: { get: () => approval('extend') } },
  ] as unknown as Parameters<typeof presenceReason>[2][];
  const params = { approval_id: 'x', key: 'limits.turns', address: 'grok:researcher' };
  for (const m of privileged) {
    for (const e of engines) {
      const r = presenceReason(m, params, e);
      assert.doesNotMatch(r, /agentbridge:/i, `${m}: ${r}`);
      assert.match(r, /^[a-z]/, `${m}: ${r}`);
      assert.ok(VERBS.has(r.split(' ')[0]!), `${m} starts with a verb: ${r}`);
      assert.doesNotMatch(r, /[.\n]$/, `${m}: ${r}`);
    }
  }
  assert.equal(presenceReason('cli.config_set', params, engines[0]!), 'change the agentbridge setting limits.turns');
  assert.equal(presenceReason('cli.approve', params, engines[2]!), 'approve an agentbridge conversation with grok:researcher (turn limit 30)');
  assert.equal(presenceReason('cli.show', params, engines[0]!), 'show an agentbridge transcript');
});

test('must-act popups stay unshown after a successful notify(); informational ones are marked shown', async () => {
  const h = await harness();
  for (const t of ['approval_needed', 'approval_expired', 'queue_expired', 'grok_delivery_failed', 'policy_tampered', 'relay_disconnected']) assert.ok(MUST_ACT_POPUPS.has(t), t);
  await h.engine.popup('queued', 'agentbridge: message queued', 'informational');
  await h.engine.popup('unsafe', 'agentbridge refused a conversation', 'informational');
  await h.engine.popup('queue_expired', 'agentbridge: queued message expired', 'must act');
  await h.engine.popup('grok_delivery_failed', 'agentbridge: delivery failed', 'must act');
  assert.equal(h.notifier.popups.length, 4); // all four were shown
  assert.deepEqual(h.store.unshownPopups().map((e) => e.type), ['popup:queue_expired', 'popup:grok_delivery_failed']);
  h.engine.stop();
});
