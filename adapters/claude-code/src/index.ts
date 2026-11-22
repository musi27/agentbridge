// Public surface of @agentbridge/adapter-claude-code (used by the bridge and the CLI).
export { ClaudeCodeAdapter, parseVersion, versionAtLeast } from './adapter.ts';
export type { ClaudeCodeAdapterOptions } from './adapter.ts';
export {
  readEffectiveCrossSessionInbound, claudeSettingsFiles, inboundFix, installDenyRules, checkDenyRules, bareModeConfigured,
  DENY_RULES, INBOUND_VALUES, MACOS_MANAGED_DIR,
} from './settings.ts';
export type { EffectiveInbound, InboundValue, SettingsFiles, SettingsPathOptions, SourceReading, DenyRuleStatus } from './settings.ts';
export { bridgeSocketPath, agentbridgeHome, claudeConfigDir, userSettingsPath } from './paths.ts';
export { PLUGIN_VERSION, PLUGIN_NAME, MCP_SERVER_NAME, TOOL_NAME_PREFIX } from './version.ts';
export { inboxPayload } from './inbox.ts';
