// Prints the agent panel for the fake fixture (PR captures): node --conditions=agentbridge-source packages/bridge/test/fixtures/render-panel.ts
import { buildPanel, renderPanel } from '../../src/cli/panel.ts';
import { fixtureStatus, NOW } from './panel-status.ts';

for (const l of renderPanel(buildPanel(fixtureStatus(), { cliVersion: '0.2.3', nowMs: NOW }), { width: 100, clock: '14:32:10', color: process.argv.includes('--color') })) console.log(l);
