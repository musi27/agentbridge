// The plugin's MCP server (§11.2, §11.4): exactly CLAUDE_TOOLS, standing instruction with this process's nonce.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CLAUDE_TOOLS, renderStandingInstruction } from '@agentbridge/protocol';
import type { ToolResult } from '@agentbridge/protocol';
import { codexConfirmDisplay, codexConfirmGuard, codexConfirmTool } from './codex.ts';
import type { Host } from './codex.ts';
import { renderToolResult } from './render.ts';
import { MCP_SERVER_NAME } from './version.ts';

export interface ToolCaller { callTool(name: string, args: unknown): Promise<ToolResult> }

const TOOL_NAMES: ReadonlySet<string> = new Set(CLAUDE_TOOLS.map((t) => t.name));

export function createMcpServer(opts: { nonce: string; version: string; caller: ToolCaller; host?: Host }): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: opts.version },
    // No other capabilities: in particular never `claude/channel/permission` (§11.3).
    // Codex doesn't show MCP instructions to the model (§11a); its SessionStart hook injects the Codex wording instead.
    { capabilities: { tools: {} }, instructions: renderStandingInstruction(opts.nonce, opts.host ?? 'claude') },
  );
  // Tool defs are passed through verbatim, including bridge_confirm's `_meta["anthropic/requiresUserInteraction"]`.
  // Under Codex, bridge_confirm also takes the display copies Codex's approval prompt shows (see codexConfirmTool).
  const codex = opts.host === 'codex';
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CLAUDE_TOOLS.map((t) => (codex && t.name === 'bridge_confirm' ? codexConfirmTool(t) : { ...t })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    let args: unknown = req.params.arguments;
    let guard: ToolResult | null = null;
    if (codex && name === 'bridge_confirm') {
      guard = codexConfirmGuard(req.params._meta, (args as Record<string, unknown> | undefined)?.['approval_id']);
      if (!guard) {
        const shown = codexConfirmDisplay(args);
        if ('refused' in shown) guard = shown.refused; else args = shown.args;
      }
    }
    const result: ToolResult = guard ?? (TOOL_NAMES.has(name)
      ? await opts.caller.callTool(name, args ?? {})
      : { status: 'failed', reason: 'invalid_message', hint: `Unknown tool ${name}.` });
    const { text, isError } = renderToolResult(result, opts.nonce, opts.host);
    return { content: [{ type: 'text', text }], isError };
  });
  return server;
}
