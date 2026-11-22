import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayPendingMessage, zRelayPendingResponse, relayX25519Statement, relayRotateStatement, botTokenHash, zRelayIdentityRequest, RELAY_PATHS } from '../src/index.ts';

test('relay key statements are fixed byte strings', () => {
  assert.equal(relayX25519Statement('u'.repeat(26), 'AAA=').toString(), `agentbridge-relay-x25519-v1\n${'u'.repeat(26)}\nAAA=`);
  assert.equal(relayRotateStatement('u'.repeat(26), 'E=', 'X=').toString(), `agentbridge-relay-rotate-v1\n${'u'.repeat(26)}\nE=\nX=`);
});

test('bot token hash is hex sha256', () => {
  assert.equal(botTokenHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(zRelayIdentityRequest.safeParse({ ed25519_pub: 'a', x25519_pub: 'b', sig: 'c' }).success);
  assert.equal(RELAY_PATHS.connect, '/v1/connect');
});

test('pending check: signed bytes and answer shape', () => {
  assert.equal(relayPendingMessage('relay.musi.live', 1700000000000).toString(), 'agentbridge-relay-pending-v1\nrelay.musi.live\n1700000000000');
  assert.ok(zRelayPendingResponse.safeParse({ pending: 0, oldest_ms: null }).success);
  assert.ok(!zRelayPendingResponse.safeParse({ pending: -1, oldest_ms: 0 }).success);
});
