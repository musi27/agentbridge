import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentLine, type AgentRow } from '../src/cli/main.ts';

const row = (state: string, permission_mode: string): AgentRow => ({ address: 'claude:x', state, permission_mode, short_id: 'abc123' });

test('only a live session with an unknown mode shows "waiting for first prompt"', () => {
  assert.match(agentLine(row('live', 'unknown')), /waiting for first prompt/);
  for (const state of ['closed', 'unreachable', 'gone']) {
    const line = agentLine(row(state, 'unknown'));
    assert.doesNotMatch(line, /waiting for first prompt/, state);
    assert.match(line, new RegExp(`${state}\\s+-\\s+abc123`));
  }
  assert.match(agentLine(row('closed', 'auto')), /closed\s+auto\s+abc123/);
});
