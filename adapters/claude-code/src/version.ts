/** Plugin and adapter version. A test keeps it equal to package.json and plugin/.claude-plugin/plugin.json. */
export const PLUGIN_VERSION = '0.4.0';
export const PLUGIN_NAME = 'agentbridge';
/** MCP server name inside the plugin. Claude Code names its tools `mcp__plugin_<plugin>_<server>__<tool>`. */
export const MCP_SERVER_NAME = 'agentbridge';
export const TOOL_NAME_PREFIX = `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_NAME}__`;
