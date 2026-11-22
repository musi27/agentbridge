// The plugin's MCP server (§11.2, §11.4): exactly CLAUDE_TOOLS, standing instruction with this process's nonce.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CLAUDE_TOOLS, renderStandingInstruction } from '@agentbridge/protocol';
import type { ToolResult } from '@agentbridge/protocol';
import { renderToolResult } from './render.ts';
import { MCP_SERVER_NAME } from './version.ts';

export interface ToolCaller { callTool(name: string, args: unknown): Promise<ToolResult> }

const TOOL_NAMES: ReadonlySet<string> = new Set(CLAUDE_TOOLS.map((t) => t.name));

export function createMcpServer(opts: { nonce: string; version: string; caller: ToolCaller }): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: opts.version },
    // No other capabilities: in particular never `claude/channel/permission` (§11.3).
    { capabilities: { tools: {} }, instructions: renderStandingInstruction(opts.nonce) },
  );
  // Tool defs are passed through verbatim, including bridge_confirm's `_meta["anthropic/requiresUserInteraction"]`.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: CLAUDE_TOOLS.map((t) => ({ ...t })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const result: ToolResult = TOOL_NAMES.has(name)
      ? await opts.caller.callTool(name, args ?? {})
      : { status: 'failed', reason: 'invalid_message', hint: `Unknown tool ${name}.` };
    const { text, isError } = renderToolResult(result, opts.nonce);
    return { content: [{ type: 'text', text }], isError };
  });
  return server;
}
