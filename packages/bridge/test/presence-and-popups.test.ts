// PR #4 integration: Touch ID reason wording and must-act popups (§9.1, §9.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_METHODS, type CliMethod } from '@agentbridge/protocol';
import { presenceReason } from '../src/ipc/cli-methods.ts';
import { MUST_ACT_POPUPS } from '../src/core/engine.ts';
import { harness } from './helpers.ts';

const VERBS = new Set(['approve', 'allow', 'decline', 'change', 'check', 'show', 'end', 'raise', 'stop', 'remove', 'delete', 'replace', 'add', 'rotate', 'run']);
const privileged = (Object.keys(CLI_METHODS) as CliMethod[]).filter((m) => (CLI_METHODS[m] as { privileged?: boolean }).privileged);

test('every privileged reason is a lowercase verb phrase that does not repeat the app name ("AgentBridge is trying to <reason>.")', () => {
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
      assert.doesNotMatch(r, /agentbridge/i, `${m}: ${r}`);
      assert.match(r, /^[a-z]/, `${m}: ${r}`);
      assert.ok(VERBS.has(r.split(' ')[0]!), `${m} starts with a verb: ${r}`);
      assert.doesNotMatch(r, /[.\n]$/, `${m}: ${r}`);
    }
  }
  // The wording the owner picked on 2026-11-25 (TODO item 15).
  const want: Array<[CliMethod, number, string]> = [
    ['cli.approve', 2, 'approve a conversation with grok:researcher, up to 30 turns'],
    ['cli.approve', 3, 'approve a longer conversation with grok:researcher, up to 30 turns'],
    ['cli.approve', 0, 'allow a request'],
    ['cli.decline', 0, 'decline a request'],
    ['cli.config_set', 0, 'change its setting limits.turns'],
    ['cli.config_verify', 0, 'check its policy'],
    ['cli.show', 0, 'show a conversation transcript'],
    ['cli.end', 0, 'end its conversations'],
    ['cli.extend', 0, "raise a conversation's turn limit"],
    ['cli.stop', 0, 'stop its background service'],
    ['cli.remove', 0, 'remove grok:researcher from its agents'],
    ['cli.purge', 0, 'delete its ended transcripts'],
    ['cli.revoke', 0, 'replace the token of grok:researcher with a new one'],
    ['cli.add_grok', 0, 'add a Grok bot to its agents'],
    ['cli.identity_rotate', 0, 'rotate its identity keys'],
  ];
  for (const [m, e, r] of want) assert.equal(presenceReason(m, params, engines[e]!), r);
  assert.equal(presenceReason('cli.not_a_method' as CliMethod, params, engines[0]!), 'run the command not a method');
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
