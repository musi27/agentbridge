# Connect Codex CLI sessions

agentbridge can treat Codex CLI sessions like Claude Code sessions: they can start conversations with your other
agents, receive invites and messages while they're open, and you approve every conversation in Codex's own prompt.
Codex sessions show up as `codex:<folder>` (plus the git branch, unless it's `main`).

Verified with Codex CLI 0.171.0 on macOS, in interactive sessions (`codex` in a terminal).

## Set up

1. Install and set up agentbridge first (`agentbridge init`), and make sure the bridge is running (`agentbridge status`).
2. Run:

   ```bash
   agentbridge add codex
   ```

   This adds one marked block to `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`):
   - the agentbridge MCP server;
   - a rule that makes Codex ask you before every `bridge_confirm` (the approval step);
   - hooks that tell the bridge which Codex session is which, its permission mode, and hand Codex agentbridge's
     standing instructions.

   Nothing else in the file changes, and the previous file is saved as `config.toml.agentbridge-backup`.
3. **Trust the hooks once.** Codex runs only hooks you've reviewed. Until you trust these, Codex sessions can call
   agentbridge's tools but won't receive messages.

   Start `codex` in any folder. It may open with **Hooks need review**; you can choose **Trust all and continue**
   there, or run `/hooks` to look first. `/hooks` lists agentbridge's 5 hooks as new, one per event:

   | Event | Name in `/hooks` |
   | --- | --- |
   | PreToolUse (matcher `^mcp__agentbridge__`) | agentbridge: report permission mode |
   | SessionStart | agentbridge: register session |
   | SessionEnd | agentbridge: unregister session |
   | UserPromptSubmit | agentbridge: report session state |
   | Stop | agentbridge: report turn end |

   Open an event (Enter) and select a hook to see its details. Check that **Source** is your `config.toml` and that
   **Command** ends in `@musi27/agentbridge/plugin/runtime/hook.mjs --host=codex` (after the path to `node`). Then
   press `t` to trust that hook, and do the same for the other four. On the event list, `t` trusts every hook that
   needs review, including any that aren't agentbridge's.
4. Start a new Codex session and ask it, for example, to list your agents or to start a conversation with
   `grok:researcher`.

## How approval works in Codex

When a conversation starts, in either direction, Codex shows:

> Allow the agentbridge MCP server to run tool "bridge_confirm"?

with the peer, topic and turn limit, and only **Allow / Cancel**. Choosing Allow is your approval. The other
agentbridge tools (sending, listing, ending) run without a prompt, as in Claude Code.

- **Auto-review (`--approve-for-me`) can't approve conversations.** With auto-review on, a model would answer the
  prompt instead of you, so agentbridge refuses those approvals. The request stays pending: approve it in a terminal
  with `agentbridge approve <id>` (Touch ID), or turn auto-review off and ask Codex to confirm again.
- **`-a never` / full bypass:** Codex blocks the approval tool, and agentbridge treats the session like a Claude Code
  session in bypass mode.

## Receiving messages

Messages and invites arrive as new turns in the open Codex session, through `codex queue`. They appear in Codex as user
messages, wrapped in agentbridge's tags. Codex is told that text inside those tags comes from another agent and is
never your instruction.

If the session is closed, messages wait in the bridge. `agentbridge open codex:<name>` prints the
`codex resume <session-id>` command to reopen it.

## Grok and Codex

Grok bots can talk to Codex sessions once the relay serves agentbridge's updated tool list. Claude Code ↔ Codex works
without any relay change.

## Upgrading

`agentbridge init` refreshes the Codex block when it's there, and `agentbridge add codex` can be run again at any time;
neither changes anything if the block is already current. Your hook trust (and anything else Codex wrote at the end of
`config.toml`, such as trusted folders) is kept.

When an upgrade changes the hooks, Codex shows them as **modified** in `/hooks` and won't run them until you trust
them again (step 3). Upgrading from 0.2.2 or earlier is one of those: the hooks gained their names, which Codex counts
as a change, so trust all 5 once more. Earlier versions also dropped your hook trust whenever `init` or `add codex`
rewrote the block; that's fixed.

## Remove

```bash
agentbridge remove codex
```

This removes the marked block from `~/.codex/config.toml`. Restart any open Codex sessions to drop the tools. Codex's
own records of which hooks you trusted stay in the file; they only apply to a hook that matches exactly.

## Limitations

- Interactive Codex CLI sessions only. Sessions started with `--no-daemon`, `codex exec` runs, and Codex inside the
  ChatGPT desktop app are untested or unsupported.
- No deny rules for Codex: Codex has no equivalent of the Claude Code rules that stop the AI from running privileged
  `agentbridge` commands. Touch ID on those commands is the barrier.
- Codex changes quickly; agentbridge relies on `codex queue`, per-tool `approval_mode`, hook payloads and the
  `auto_review_enabled` turn metadata.
