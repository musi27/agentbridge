// Entry point of the plugin's MCP stdio server (bundled to plugin/runtime/server.mjs).
// stdout carries MCP only; diagnostics go to stderr (Claude Code keeps it in its MCP logs).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { newNonce } from '@agentbridge/protocol';
import { BridgeClient } from './bridge-client.ts';
import { createMcpServer } from './mcp-server.ts';
import { bridgeSocketPath } from './paths.ts';
import { PLUGIN_VERSION } from './version.ts';

const log = (msg: string): void => { process.stderr.write(`[agentbridge] ${msg}\n`); };
const env = process.env;
const nonce = newNonce(); // fresh per process (§8.1)
const inbox = env.CLAUDE_CODE_MESSAGING_SOCKET && env.CLAUDE_CODE_MESSAGING_TOKEN
  ? { socket: env.CLAUDE_CODE_MESSAGING_SOCKET, token: env.CLAUDE_CODE_MESSAGING_TOKEN }
  : null;
if (!inbox) log('CLAUDE_CODE_MESSAGING_SOCKET/TOKEN not set: cannot register with the bridge');

// The MCP server is a direct child of `claude` (M0 V3), so the parent PID is the Claude process.
const client = new BridgeClient({
  socketPath: bridgeSocketPath(env), claudePid: process.ppid, tagNonce: nonce, inbox,
  pluginVersion: PLUGIN_VERSION, cwd: process.cwd(), log,
});
const server = createMcpServer({ nonce, version: PLUGIN_VERSION, caller: client });

let exiting = false;
const shutdown = (): void => {
  if (exiting) return;
  exiting = true;
  client.stop();
  void server.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, shutdown);

await server.connect(new StdioServerTransport());
client.start();
