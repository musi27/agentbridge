// Fixes from the first real end-to-end run (docs/e2e-run1.md): end summary cut at a word boundary, and the live-session
// hint for Grok when it targets a closed session whose folder has a live one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '@agentbridge/protocol';
import { harness } from './helpers.ts';
import { endSummaryNotice } from '../src/core/notices.ts';
import { RelayLink } from '../src/relay/link.ts';
import { ENDPOINT, FakeTransport, addBot, relayCall, result } from './grok-helpers.ts';

test('§6.6 end summary: each side\'s last message is a word-boundary preview with "…", ≤ 280 chars, in both renderings', () => {
  const long = `${'word '.repeat(54)}and then describe the overall design`; // 270 + 36 chars: the 280 cut falls inside a word
  const n = endSummaryNotice({ conversationId: ulid(), a: 'claude:x', b: 'grok:r', topic: 't', turnsUsed: 4, turnLimit: 30, durationMs: 60_000, reason: 'ended_by_participant', last: [{ from: 'grok:r', body: long }, { from: 'claude:x', body: 'short' }] });
  const part = n.parts.find((p) => p.kind === 'untrusted' && p.label.startsWith('Last message from grok:r'))!;
  assert.ok(part.text.endsWith('…')); assert.ok(Array.from(part.text).length <= 280);
  assert.ok(/(^| )\S+…$/.test(part.text) && long.includes(part.text.slice(0, -1))); // ends on a whole word
  assert.doesNotMatch(part.text, /the o…$/);
  assert.ok(n.text.includes(part.text)); // Grok rendering
  assert.ok(n.parts.some((p) => p.text === 'short'));
});

test('Grok bridge_list_agents shows each agent\'s state; a start aimed at a closed session hints at the live one in its folder', async () => {
  const h = await harness();
  const link = new RelayLink({ engine: h.engine, transport: new FakeTransport(), endpoint: ENDPOINT });
  const bot = addBot(h.engine, 'researcher', 'bot00000000000e1');
  const old = h.engine.registerLocal({ agent: 'claude', name: '_workdir', cwd: '/Users/u/_workdir' });
  h.engine.setLocalLive(old.participant_id, false);
  const live = h.engine.registerLocal({ agent: 'claude', name: '_workdir', cwd: '/Users/u/_workdir' });
  assert.equal(live.address, 'claude:_workdir-2');
  const list = result<{ data: Array<{ address: string; state: string; folder?: string }> }>(await relayCall(link, bot, 'bridge_list_agents', {}));
  assert.deepEqual(list.data.map((x) => [x.address, x.state]), [['claude:_workdir', 'closed'], ['claude:_workdir-2', 'live']]);
  assert.ok(list.data.every((x) => x.folder === undefined)); // addresses and states only
  assert.ok(list.data.every((x) => !('self' in x))); // the bot is not listed, so nothing is marked self
  const r = result<{ status: string; hint: string }>(await relayCall(link, bot, 'bridge_start_conversation', { peer: 'claude:_workdir', topic: 't', first_message: 'hi', conversation_id: ulid() }));
  assert.equal(r.status, 'queued');
  assert.match(r.hint, /^claude:_workdir is closed; claude:_workdir-2 is live; /);
  assert.doesNotMatch(r.hint, /\/Users/); // no paths
  // discovery.relay = none: Grok learns no other addresses (§12.3); local callers still get the hint
  await h.setPolicy('discovery.relay', 'none');
  const hidden = result<{ status: string; hint: string }>(await relayCall(link, bot, 'bridge_start_conversation', { peer: 'claude:_workdir', topic: 't2', first_message: 'hi', conversation_id: ulid() }));
  assert.equal(hidden.status, 'queued');
  assert.doesNotMatch(hidden.hint, /_workdir-2|live/);
  const local = h.engine.registerLocal({ name: 'docs' });
  const lr = await h.tool(local, 'bridge_start_conversation', { peer: 'claude:_workdir', topic: 't3', first_message: 'hi' });
  const lc = await h.tool(local, 'bridge_confirm', lr.approval);
  assert.equal(lc.status, 'queued'); assert.match(lc.hint!, /claude:_workdir-2 is live/);
  await h.setPolicy('discovery.relay', 'names');
  // no sibling → no hint
  const solo = h.engine.registerLocal({ agent: 'claude', name: 'solo', cwd: '/Users/u/solo' }); h.engine.setLocalLive(solo.participant_id, false);
  const r2 = result<{ hint: string }>(await relayCall(link, bot, 'bridge_start_conversation', { peer: 'claude:solo', topic: 't', first_message: 'hi', conversation_id: ulid() }));
  assert.doesNotMatch(r2.hint, /live/);
  h.engine.stop();
});
