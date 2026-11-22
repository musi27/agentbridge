# @agentbridge/adapter-claude-code

The Claude Code side of agentbridge (SPEC v0.4 §8.1, §8.4, §10, §11).

- `plugin/` is the Claude Code plugin: an MCP stdio server declared inline in `.claude-plugin/plugin.json`, plus the hooks in `hooks/hooks.json`. It is listed in the in-repo marketplace (`/.claude-plugin/marketplace.json`).
- `src/` holds the sources. The bridge imports `ClaudeCodeAdapter`, `readEffectiveCrossSessionInbound`, `installDenyRules` and `checkDenyRules` from the package root.

## Plugin runtime

An installed plugin has no `node_modules`, so the server and hook are bundled with esbuild into `plugin/runtime/server.mjs` and `plugin/runtime/hook.mjs`. Both files are committed. After changing `src/` (or the protocol package), rebuild them:

```bash
npm run build:plugin -w @agentbridge/adapter-claude-code
```

`test/package.test.ts` fails if the committed bundles are stale.

## Dev loop

```bash
AGENTBRIDGE_SOCKET=/path/to/bridge.sock claude --plugin-dir adapters/claude-code/plugin
```

Run this from a folder that is **not** inside `plugin/`.

Env overrides:

| Variable | Default | What it sets |
|---|---|---|
| `AGENTBRIDGE_SOCKET` | `~/.agentbridge/run/bridge.sock` | Path of the bridge IPC socket |
| `AGENTBRIDGE_HOME` | `~/.agentbridge` | agentbridge home folder |
| `AGENTBRIDGE_CLI` | the `agentbridge` on PATH | CLI the SessionStart hook runs as `agentbridge start` when the bridge is down |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where the user's Claude Code settings are read and written |

## Tool results

Tool results are rendered as plain text, never raw JSON. Bridge-generated fields (status, reason, ids, enums, hint, warning) are printed plainly. Every other string goes inside an `<ab-untrusted-NONCE>` block after nonce escaping, using this session's nonce. That covers topics, transcript bodies (one block per message, labelled with sender and id), folders, summaries and any unknown field. See `src/render.ts`.

## End-to-end check against real Claude Code

```bash
npm run e2e:claude -w @agentbridge/adapter-claude-code
```

This makes one small model call (haiku by default; set `E2E_MODEL` to change it, and `CLAUDE_BIN` to use another `claude`). It runs `claude -p --plugin-dir plugin` from a neutral temp folder against the logging fake bridge in `test/helpers.ts`, then checks:

- the hook frames: start, state and end, all with the same `claude_pid`
- `register_session`
- a tool round trip
- `deliver` → `post_result`
- that the transcript records the post as a verified peer post

## Manual check (2026-11-22, Claude Code 2.1.330)

The test ran headless with a fake bridge that logged every frame:

```bash
claude -p --model haiku --plugin-dir … --allowedTools mcp__plugin_agentbridge_agentbridge__bridge_list_agents
```

What the fake bridge logged:

1. **Hooks.** SessionStart sent `start`/`startup`. UserPromptSubmit, PreToolUse and Stop sent `state` with `permission_mode: auto`. SessionEnd sent `end`. All carried the same `claude_pid`.
2. **Registration.** The MCP server sent `register_session` with that `claude_pid`, its nonce, and the inbox `/tmp/cc-socks/<pid>.sock` plus its token.
3. **Tool call.** `tool.bridge_list_agents` round-tripped, and the model reported the result.
4. **Delivery.** A `deliver` event went out, then `post_result ok`.

In Claude Code's transcript, the post was:

- recorded with `origin: {kind: peer, verifiedPeerPid: <MCP server pid>}`
- queued because the turn was busy, then shown after the tool result

The model quoted the post's line back.
