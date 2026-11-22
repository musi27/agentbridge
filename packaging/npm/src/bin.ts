#!/usr/bin/env node
// `agentbridge` bin of the published package: always runs the CLI (npm's global bin is a symlink, so the CLI module's
// own "am I main?" check would not match here).
import { main } from '../../../packages/bridge/src/cli/main.ts';

const code = await main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
