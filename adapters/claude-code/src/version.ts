/**
 * Plugin and adapter version: the agentbridge release version (packaging/npm/package.json), so Claude Code's
 * `claude plugin list` shows the release a user installed. A test keeps it equal to that and to plugin.json.
 */
export const PLUGIN_VERSION = '0.2.4';
export const PLUGIN_NAME = 'agentbridge';
/** MCP server name inside the plugin. Claude Code names its tools `mcp__plugin_<plugin>_<server>__<tool>`. */
export const MCP_SERVER_NAME = 'agentbridge';
export const TOOL_NAME_PREFIX = `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_NAME}__`;
