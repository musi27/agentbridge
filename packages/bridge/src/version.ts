/**
 * The agentbridge release version (CLI, bridge and plugin ship together in one npm package). Tests keep it equal to
 * packaging/npm/package.json, the plugin's PLUGIN_VERSION and plugin/.claude-plugin/plugin.json (docs/releasing.md).
 */
export const BRIDGE_VERSION = '0.2.7';

/** One line when the CLI and the running bridge differ (e.g. after `npm install -g` without a restart), else null. */
export function versionMismatch(bridgeVersion: string | null | undefined, cliVersion: string = BRIDGE_VERSION): string | null {
  if (!bridgeVersion || bridgeVersion === cliVersion) return null;
  return `the running bridge is ${bridgeVersion} but this agentbridge is ${cliVersion}`;
}
