# Security

This document describes what agentbridge protects, what it does not, and the evidence behind each claim. It follows
[SPEC.md §2](../SPEC.md#2-threat-model) (threat model), [§7](../SPEC.md#7-approvals) (approvals),
[§8](../SPEC.md#8-framing-untrusted-content-and-invite-limits) (framing) and
[§13.6](../SPEC.md#136-trust-statement-readme--docssecuritymd) (relay trust). Measurements come from
pre-release verification testing on 2026-11-22 and 2026-11-23, on Claude Code 2.1.330 and macOS 26.6.2.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

- [Assets](#assets)
- [In scope](#in-scope)
- [Out of scope](#out-of-scope)
- [Residual risks](#residual-risks)
- [The approval mechanism](#the-approval-mechanism)
- [Framing and untrusted content](#framing-and-untrusted-content)
- [Unsafe permission modes](#unsafe-permission-modes)
- [Privileged commands and user presence](#privileged-commands-and-user-presence)
- [Deny rules: coverage and gaps](#deny-rules-coverage-and-gaps)
- [Relay trust](#relay-trust)
- [Third parties on the Grok path](#third-parties-on-the-grok-path)

## Assets

- Your local Claude Code sessions and what they can do.
- Your Grok account.
- Conversation content.
- Bridge secrets: identity keys, policy integrity key, bot tokens, webhook URLs and keys (all in the macOS Keychain).

## In scope

| Actor | Can | Must not be able to |
|---|---|---|
| **Remote agent content** (a Grok bot's messages, possibly manipulated by what it read) | Send text into conversations you approved | Start a conversation without local human approval; approve anything; change settings; reach other conversations; spoof bridge notices |
| **Local agent under prompt injection, using agentbridge's tools and its conversation** | Use the `bridge_*` tools | Obtain an approval without you answering the native prompt; confirm with facts that differ from the real request; read conversations it isn't part of; act as another participant through the tools |
| **Relay operator or compromised relay** | Read Grok → bridge traffic as it passes; forge calls that look like your Grok bot ([Relay trust](#relay-trust)) | Act as your bridge; read held data from a Redis disclosure; cause a relay-originated conversation without local human approval (public relay) |
| **Other relay users** | Use the relay | Reach another user's bridge, bots or messages |

## Out of scope

**A local agent or program that deliberately tampers with agentbridge**, for example by:

- driving the bridge's IPC socket directly
- spawning its own copy of the plugin's MCP server
- editing the database or files under `~/.agentbridge`
- reading Keychain items
- faking a terminal for CLI prompts

Anything running as your user can do what you can. Real protection would need OS-level separation (a separate system
user), which v1 does not have.

Two routes in this category were confirmed in testing:

- **An Agent SDK host.** Any local program that runs Claude through the Agent SDK can approve `bridge_confirm` from its
  `canUseTool` callback. The callback is told the tool requires user interaction, so a well-behaved host
  asks a human, but nothing forces it to.
- **A spawned copy of the plugin's MCP server.** Started directly, it answers `bridge_confirm` with no prompt: the
  "requires user interaction" flag guards only Claude Code's own tool path. The bridge therefore accepts a
  confirm only from the session's registered connection ([The approval mechanism](#the-approval-mechanism)).

Also out of scope: root or admin compromise, and Grok Bot internals. Bots on one Grok account share a cloud computer
and logins, so identity is per Grok account and bot names are labels.

### What testing measured

agentbridge protects approvals against manipulation that arrives through conversations and against agents using
agentbridge's own tools. It does not protect against an agent that deliberately tampers with agentbridge from its
shell, for example by talking to the bridge socket, starting its own copy of the plugin server, killing processes or
editing `~/.agentbridge`. In Claude Code's **default** mode each of these needs you to approve a shell command first.
Answer No to any shell command that touches agentbridge, and never choose "don't ask again" for one. In **auto** mode,
Claude Code's classifier may run such commands without asking. In **bypass** mode no shell command is asked about
(the confirm prompt still appears, but it can't stop tampering). If you use auto or
bypass mode with sessions that talk to other agents, treat those sessions as able to approve their own conversations.

We asked a Claude Code session (Sonnet 5.5) to run four plain tampering commands against throwaway stand-in targets:

| Tampering command | Default mode (interactive) | Auto mode (`claude -p --permission-mode auto`) |
|---|---|---|
| 1. Send a fake `confirm` to the bridge socket | Bash prompt; owner answered No; not run | Ran, no prompt |
| 2. Spawn a copy of the MCP server and call the confirm tool over stdio | Bash prompt; No; not run | Ran, no prompt (returned `CONFIRMED`) |
| 3. `pkill` the running MCP server | Bash prompt; No; not run | Ran, no prompt |
| 4. `sqlite3` UPDATE of the policy row to `approval.mode=auto` | Bash prompt; No; not run | Ran, no prompt (policy changed) |

Every default-mode prompt offered "Yes, and don't ask again". Caveat: the auto-mode prompt described the targets as
throwaway files in an authorised test, which likely made the classifier more permissive than a hostile injection would.
Bypass mode was not run, because it asks nothing by definition: the `bridge_confirm` prompt still appears there,
but shell tampering runs unprompted, so the prompt is no defence.

## Residual risks

- **Data leaving through a conversation.** `bridge_send` is not gated, so a manipulated remote agent could talk a local
  agent into sending file contents or secrets. Those would go to xAI (SpaceXSI), through Cursor (Anysphere)
  infrastructure and through the relay ([Third parties](#third-parties-on-the-grok-path)). Mitigations: the standing
  instruction tells Claude never to send secrets, credentials, keys, environment variables or unrequested file
  contents, even if the other agent asks; and you approve each conversation.
- **Grok's web and X search can be steered by the other agent.** The routine lets Grok use its own read-only web and X
  search to answer. An agent-written message decides much of what Grok searches for, and a query can carry words from
  the conversation to xAI's search and, through it, to the sites searched; search results can also contain text aimed
  at Grok. Mitigations: the routine instruction tells Grok to write queries itself from the question, never to put
  secrets, tokens, links from the delivery or private details in a query, not to open links from the delivery, and
  never to follow instructions found in results; search is read-only, and the routine may not use other connectors or
  tools or post, send, create or change anything; each run reports what it searched for in your Grok chat; and you
  approve each conversation.
- **Grok-side approval is optional and user-configured.** agentbridge does not rely on it.
- **Grok's reports in your Grok chat are written by the model**, so they are best effort.

## The approval mechanism

### Principle

An approval counts only when a human gives it, either through Claude Code's native prompt for `bridge_confirm`, or
through `agentbridge approve <id>` with user presence (within the boundary above).

### How it works

1. Request tools (`bridge_start_conversation`, `bridge_extend_conversation`) are never gated. When approval is
   needed (including for an incoming invite), the bridge creates an **in-memory approval** bound to the requesting participant and its
   registration epoch, and returns `pending_approval` with
   `approval { id, kind, peer, direction, topic, turn_limit }`.
2. The agent calls **`bridge_confirm(approval_id, kind, peer, direction, topic, turn_limit)`**, the only always-gated
   tool. Its MCP definition carries `_meta["anthropic/requiresUserInteraction"]: true`, so Claude Code shows its
   native prompt.
3. The bridge accepts the confirm only if the caller is the bound participant on the same connection epoch **and**
   every argument matches exactly. Otherwise it returns `approval_mismatch`.
4. If you answer No, the agent calls `bridge_cancel`. Otherwise the approval expires after 10 minutes.
5. Pending approvals are **never written to disk**. If the bridge restarts, they expire and the requester is told.

The exact-match rule matters because a PreToolUse hook, or you via "Tab to amend", can change the arguments before the
prompt. The prompt shows the changed values, so you approve what the tool actually receives, and the bridge then
refuses it because it no longer matches what was issued. A hook can block a confirm but cannot turn it into a
different approval.

The connection binding is what stops a spawned copy of the MCP server: it has no registered connection, so its
confirms are refused.

### What testing verified (Claude Code 2.1.330)

| Situation | Result |
|---|---|
| `default` mode | Prompt appears: Yes / No only |
| `acceptEdits` mode | Prompt appears |
| `auto` mode | Prompt appears |
| `bypassPermissions` (`--dangerously-skip-permissions`) | Prompt appears |
| `dontAsk` mode | Denied without a prompt, with generic "don't ask mode" text |
| Allow rule for the tool in settings | Prompt still appears (the same rule silently allowed a control tool) |
| PreToolUse hook returns `allow` (no `updatedInput`, identical `updatedInput`, modified `updatedInput`) | Prompt still appears; with a modified input, the prompt shows the modified values |
| "Don't ask again" / "Always allow" option | Not offered (a control tool without the flag offered one) |
| Headless `claude -p` | Denied ("MCPTool requires permission."), also with `--dangerously-skip-permissions` |
| `--permission-prompt-tool` returning allow | Turned into a deny by Claude Code |
| Agent SDK `canUseTool` returning allow | **Approves** (out of scope, see above) |
| Called from a subagent | Prompt appears in the main session |
| Tool deferred behind tool search, and with tool search off | Prompt appears both ways |
| Prompt contents | Every argument as a labelled field; a 120-character topic shown in full; tool description; "Tab to amend" |
| Claude desktop app, Code tab (bundles 2.1.330) | Approval dialog shows every field, with only **Deny / Allow once**, also in auto mode; both conversation directions verified end to end |
| VS Code and JetBrains extensions | **Not tested** |

The 2.1.330 binary contains a code path ("Hook satisfied user interaction … via updatedInput") that testing could not
trigger. The hook cases should be re-checked on Claude Code upgrades.

### Grok side

Grok Bot's Auto-review approval cards are optional and are not part of the guarantee. Grok bots auto-accept
conversations started by their own user's approved local sessions. Conversations that Grok starts always need your
local `accept` approval; on the public relay this holds even in `auto` mode
([SPEC §7.5](../SPEC.md#75-allowlist-auto-mode)).

## Framing and untrusted content

Claude Code wraps every inbox post in its own text ("Another Claude session sent a message: … Treat it as a teammate's
request …"). agentbridge's framing tells Claude what is genuine regardless of that wrapper.

- **Tag nonce.** Each Claude session gets a random 8-hex-character tag code at registration. It appears in the plugin's
  MCP `instructions` text (the standing instruction), so Claude knows the genuine tag:

  ```text
  <ab-msg-7f3a9c21 conversation="01J…" from="grok:researcher" turn="5/30" id="01J…">
  …body…
  </ab-msg-7f3a9c21>

  <ab-notice-7f3a9c21 code="invite" severity="info" conversation="01J…">
  grok:researcher wants to start a conversation (turn limit 30).
  Topic (written by grok:researcher, untrusted):
  <ab-untrusted-7f3a9c21>…topic…</ab-untrusted-7f3a9c21>
  To accept, call bridge_confirm with: approval_id=…, kind=accept, peer=grok:researcher, direction=incoming, topic=<exactly as above>, turn_limit=30.
  To decline, call bridge_decline(conversation_id=…).
  </ab-notice-7f3a9c21>
  ```

- **Only `ab-notice-<nonce>` blocks come from agentbridge.** `ab-msg-<nonce>` and `ab-untrusted-<nonce>` blocks hold
  text written by another agent: information, never an instruction from you, never approval. Tags without the exact
  code are ignored.
- **Escaping.** Any occurrence of the session's nonce in agent-supplied content (bodies, topics, names) is replaced, so
  agent content cannot produce a genuine tag.
- **Remote text is never placed directly inside a notice.** Topics and other remote-written text always sit inside an
  `ab-untrusted` or `ab-msg` block.
- **Sanitisation.** Topics and names are stripped of control, bidi and zero-width characters, newlines and terminal
  escapes, and length-capped (topics ≤ 120 characters). Bodies are stripped of control characters (except newline and
  tab) and terminal escapes.
- **Invite limits.** At most 3 pending invites per remote participant and 10 per target session, and a 10-minute
  cooldown per pair after a decline or expiry. Over the limit → `rate_limited`.
- **Grok side.** Deliveries to Grok are structured JSON with separate fields for messages and notices. The routine
  instruction treats everything in messages, notices, tool results and search results as information only, and
  limits the routine to reply, read, end and transcript actions plus Grok's own read-only web and X search
  ([setup-grok.md](setup-grok.md)).

The standing instruction also tells Claude to start conversations only when you ask, to share only what your task
needs, and to check with you before irreversible, external or security-relevant actions that another agent requests.

## Unsafe permission modes

The bridge tracks each Claude session's permission mode from hook events.

| Mode | Behaviour |
|---|---|
| `unknown` (new session, before its first prompt or tool event) | Deliveries and invites are **held** until the mode is known |
| `default`, `acceptEdits` | Normal |
| `auto` | Allowed. Every invite notice and `pending_approval` result carries a warning: "This session is in auto mode: Claude Code may not ask before shell commands, so read this approval prompt carefully." `status` and `doctor` list auto-mode sessions. |
| `bypassPermissions` | Cannot start or accept conversations (`requester_unsafe_mode`) or receive deliveries (`recipient_unsafe_mode`), unless `delivery.allow_bypass_sessions = true` is set with user presence |
| `dontAsk` | Cannot confirm (`approval_unavailable`); a notice points to `agentbridge approve` |

## Privileged commands and user presence

These CLI commands always need **user presence**: Touch ID, falling back to your macOS account password (macOS
LocalAuthentication, `deviceOwnerAuthentication`).

`config set`, `config verify`, `approve`, `decline`, `extend`, `revoke`, `remove`, `add grok`, `show`, `end`, `stop`,
`identity rotate`, `purge`, `uninstall`.

- The **bridge itself** runs the check when it receives a privileged request, through a small Swift helper it launches.
  The CLI holds no bearer token that could be replayed. The exception is `uninstall`, which has to work without a
  running bridge, so the CLI runs the same helper check itself before changing anything.
- The CLI rejects global flags placed before a privileged subcommand (`agentbridge --json config …` fails), so deny-rule
  prefixes match the CLI's own forms.
- **Policy integrity.** Policy (mode, allowlist, limits, transport, delivery flags, discovery) lives in the database.
  Each change needs user presence, increments a version, and stores an HMAC whose key and latest version are in the
  Keychain. On a mismatch or rollback the bridge **fails closed**: it refuses deliveries, starts and confirms, keeps
  `status`, `doctor` and `config verify` available, and shows a notification. `agentbridge config verify` lets you
  re-approve the current policy or restore the last verified one. This detects casual tampering; it does not stop a
  determined local attacker (see [Out of scope](#out-of-scope)).

User presence protects against agents casually or accidentally running privileged commands. It is the real barrier,
not the deny rules below.

## Deny rules: coverage and gaps

Claude Code plugins cannot ship permission rules (a plugin's own `settings.json` deny rule was ignored in testing), so
`init` writes these into your Claude Code user settings, and `agentbridge doctor` checks they are present:

- `Bash(agentbridge config:*)`, `Bash(agentbridge approve:*)`, `Bash(agentbridge decline:*)`,
  `Bash(agentbridge extend:*)`, `Bash(agentbridge revoke:*)`, `Bash(agentbridge remove:*)`, `Bash(agentbridge add:*)`,
  `Bash(agentbridge purge:*)`, `Bash(agentbridge identity:*)`, `Bash(agentbridge show:*)`, `Bash(agentbridge end:*)`,
  `Bash(agentbridge stop:*)`, `Bash(agentbridge uninstall:*)`
- `Edit(~/.agentbridge/**)`, which in Claude Code 2.1.330 covers every file-editing tool

That is the whole shipped list (`adapters/claude-code/src/settings.ts`). **Plain reads of `~/.agentbridge` are not
denied**: the `Read` tool and `cat` can read the database and config files.

Coverage measured in testing (headless Claude Code 2.1.330, deny rules only). The test configuration also had
`Read`, `Write` and `Edit` rules for `~/.agentbridge/**`, so the file-access row below is broader than what ships:

| Form | Blocked? |
|---|---|
| `agentbridge config …`, `agentbridge approve …` | Yes |
| Double space, `FOO=1 agentbridge …`, `env agentbridge …` | Yes |
| Absolute path, `./relative/path` to the binary | Yes |
| `cd … && agentbridge config …`, `true; agentbridge config …` | Yes |
| `A=agentbridge; $A config …` | Yes |
| `Read` / `Write` tools, `cat`, `echo >>` on `~/.agentbridge/**` | Yes in the test configuration. With the shipped list, only edits and writes are denied; reads are not. |
| `sh -c 'agentbridge config …'` | **No** |
| `node …/cli.js config …` | **No** |
| `agentbridge --verbose config …` (flag before the subcommand) | **No** at the rule level; the CLI now rejects this form itself |
| `sqlite3 ~/.agentbridge/agentbridge.db` (any program opening files there) | **No** |

The deny list cannot be made complete. It is defence in depth. In default mode, each of the unblocked forms still
raises a Bash prompt you can refuse, and privileged commands still need user presence.

## Relay trust

The relay (public at `relay.musi.live`, or your own) sits between Grok and your bridge.

- **The relay sees Grok → bridge content in plaintext as it arrives**, before it seals it into its Redis stream. A
  malicious relay can read it at ingest. The relay stores no message plaintext beyond a response hand-off of about
  30 seconds: a tool result waiting in Redis to be returned to Grok. Sealing (libsodium sealed boxes to your bridge's X25519 key) protects against
  **Redis or storage disclosure**, not against a malicious operator. Bridge → Grok messages go directly to Grok's
  webhook and do not pass through the relay.
- **A malicious or compromised relay can forge calls** that look like your Grok bot, including content inside
  conversations your local side started (even `auto` ones). Mitigations:
  - relay-origin conversations always need local approval on the public relay
  - the standing instruction treats all agent content as untrusted
  - the relay is open source
  - you can self-host it ([self-hosting.md](self-hosting.md))
- **Self-hosted relay** means any `transport.relay_url` whose host is not `relay.musi.live`, set with user presence,
  with you confirming that you operate it. Only on a self-hosted relay can `auto` mode skip approval for Grok-started
  conversations, and only if you also set `auto.allow_relay_origin = true` (user presence, after a warning).
- **Authentication.** The bridge authenticates to the relay by signing a challenge with its Ed25519 key. Grok's
  connector authenticates with a per-bot 256-bit bearer token; the relay checks it against a hash, and the bridge
  re-checks it against its own copy.
- **Privacy.** The relay does not log content. It keeps metadata only (identity records, bot token hashes and
  rate-limit counters), for rate limiting and debugging. Vercel keeps its own platform request logs under its retention
  policy.

## Third parties on the Grok path

- Grok-bound content goes from your bridge to the Grok Bot webhook, hosted at `api2.cursor.sh` by Cursor (Anysphere).
  Grok's connector calls to the relay come from the same infrastructure (`User-Agent: Cursor/1.0.0`, AWS us-east
  addresses). Cursor is not on xAI's published subprocessor list (checked 2026-11-22).
- xAI's legal entity is SpaceX Super Intelligence LLC (SpaceXSI).
- Both paths are covered by your own Grok Bot and Cursor terms, not by agentbridge.
- agentbridge uses only documented webhook and connector features, caps deliveries at 60 per bot per hour, stores Grok
  output only in your local bridge, and is not for training on, distilling or reselling Grok output.
