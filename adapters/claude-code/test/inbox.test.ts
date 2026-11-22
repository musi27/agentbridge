import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { InboxPoster, inboxPayload, postToInbox } from '../src/inbox.ts';
import { FakeInbox, tempDir, waitFor } from './helpers.ts';

// Spacing is checked against a reference taken *before* the first post() call: post k cannot start before
// t0 + (k-1) x spacing, since the poster's own first reading is >= t0 and each later start is >= the previous + spacing.
// This holds with zero slack even if the OS preempts the process between the poster's reading and ours (seen at load ~90).

test('payload is exactly the M0 V2 wire format: auth line then user line, newline-delimited', () => {
  const p = inboxPayload('tok-1', 'hello "x"\nline2');
  const lines = p.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  assert.deepEqual(JSON.parse(lines[0]!), { type: 'auth', token: 'tok-1' });
  assert.deepEqual(JSON.parse(lines[1]!), { type: 'user', message: { role: 'user', content: 'hello "x"\nline2' } });
  assert.equal(lines[0], '{"type":"auth","token":"tok-1"}');
});

test('postToInbox writes auth + user on one connection', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const inbox = await new FakeInbox(join(dir, 'in.sock')).listen(); t.after(() => inbox.close());
  await postToInbox({ socket: inbox.path, token: 'T' }, 'first');
  await waitFor(() => inbox.connections[0]?.lines.length === 2, 'two lines');
  assert.deepEqual(inbox.connections[0]!.lines.map((l) => JSON.parse(l)), [
    { type: 'auth', token: 'T' }, { type: 'user', message: { role: 'user', content: 'first' } },
  ]);
});

test('postToInbox rejects when the socket is missing', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  await assert.rejects(postToInbox({ socket: join(dir, 'none.sock'), token: 'T' }, 'x'), /inbox: ENOENT/);
});

test('InboxPoster keeps order and spacing across calls', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const inbox = await new FakeInbox(join(dir, 'in.sock')).listen(); t.after(() => inbox.close());
  const starts: number[] = [];
  const poster = new InboxPoster({ socket: inbox.path, token: 'T' }, { spacingMs: 60, post: (t, s) => { starts.push(performance.now()); return postToInbox(t, s); } });
  const t0 = performance.now();
  await Promise.all(['a', 'b', 'c', 'd'].map((x) => poster.post(x)));
  await waitFor(() => inbox.texts().length === 4, '4 posts');
  assert.deepEqual(inbox.texts(), ['a', 'b', 'c', 'd']);
  starts.forEach((s, k) => assert.ok(s - t0 >= k * 60, `post ${k + 1} started ${s - t0} ms after t0, expected >= ${k * 60}`));
});

test('InboxPoster: a failed write rejects that post only; later posts still go out', async () => {
  const sent: string[] = [];
  const poster = new InboxPoster({ socket: 's', token: 't' }, {
    spacingMs: 0,
    post: async (_t, text) => { if (text === 'bad') throw new Error('boom'); sent.push(text); },
  });
  const r = await Promise.allSettled([poster.post('ok1'), poster.post('bad'), poster.post('ok2')]);
  assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(sent, ['ok1', 'ok2']);
});

test('default spacing is LIMITS.inboxPostSpacingMs (200 ms)', async () => {
  // The dedicated check of the real spacing (LIMITS.inboxPostSpacingMs), with no tolerance (see the bound above).
  const at: number[] = [];
  const poster = new InboxPoster({ socket: 's', token: 't' }, { post: async () => { at.push(performance.now()); } });
  const t0 = performance.now();
  await Promise.all([poster.post('1'), poster.post('2'), poster.post('3')]);
  assert.ok(at[1]! - t0 >= 200, `second post ${at[1]! - t0} ms after t0`);
  assert.ok(at[2]! - t0 >= 400, `third post ${at[2]! - t0} ms after t0`);
});
