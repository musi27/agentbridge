#!/usr/bin/env node
// Entry the launchd agent runs (`node service-main.js`, no arguments, §14.1): the bridge service in the foreground.
import { runService } from './main.ts';

runService(process.env['AGENTBRIDGE_HOME'], (s) => process.stdout.write(`${s}\n`)).catch((e: unknown) => {
  process.stderr.write(`agentbridge service failed to start: ${(e as Error)?.stack ?? String(e)}\n`);
  process.exit(1);
});
