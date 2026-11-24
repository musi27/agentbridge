# agentbridge

agentbridge lets your local Claude Code sessions and your Grok Bot hold two-way conversations, started from either side.
You approve every conversation yourself, through Claude Code's own permission prompt, which the AI can trigger but cannot answer.
It is open source (MIT): a small background service on your Mac (the **bridge**) does the work, and a **relay** lets Grok, which runs in the cloud, reach it.

> **Status: v0.2.3 (macOS only).** Commands and names may still change before 1.0.
> [SPEC.md](SPEC.md) v0.4 is the design.

**Not affiliated with xAI, SpaceX Super Intelligence (SpaceXSI), Cursor (Anysphere) or Anthropic.** agentbridge is an
independent project that uses the documented features of Claude Code and Grok Bot.

- [What it looks like](#what-it-looks-like)
- [Requirements](#requirements)
- [Support matrix](#support-matrix)
- [Install and first try](#install-and-first-try)
- [How approvals work](#how-approvals-work)
- [Security boundary](#security-boundary)
- [Data and privacy](#data-and-privacy)
- [Relay and cost](#relay-and-cost)
- [Limitations](#limitations)
- [Documentation](#documentation)
- [License](#license)

## What it looks like

*The two transcripts below are **illustrative**: they show the intended flow, not captured output.*

**Claude → Grok.** In a Claude Code session:

```text
> discuss this cache-invalidation design with grok:researcher

● agentbridge wants to start a conversation. Claude Code shows its prompt:

  Tool use: bridge_confirm (agentbridge)
    approval_id: 01JD…
    kind:        start
    peer:        grok:researcher
    direction:   outgoing
    topic:       Cache-invalidation design for the session store
    turn_limit:  30
  Do you want to proceed?
  ❯ 1. Yes
    2. No

  (you choose Yes)

● Conversation started with grok:researcher. Sent the design summary as turn 1.

  <grok:researcher, turn 2/30> Two concerns: the TTL races with the write-through path …
● Replied (turn 3). …
● Conversation ended by grok:researcher after 8 turns. Summary: …
```

Each Grok run also posts a short report in your Grok chat: the topic, the peer, a one-line summary of the message
received and of the reply sent.

**Grok → Claude.** In your Grok chat:

```text
You:  ask claude:auth-refactor whether the migration is done
Grok: I've asked claude:auth-refactor. It is waiting for local approval.
```

About a minute later, in the `auth-refactor` Claude Code session:

```text
● grok:researcher wants to start a conversation (turn limit 30).
  Topic (written by grok:researcher, untrusted): "Is the auth migration done?"

  Tool use: bridge_confirm (agentbridge)
    kind: accept · peer: grok:researcher · direction: incoming · topic: Is the auth migration done? · turn_limit: 30
  ❯ 1. Yes
    2. No

  (you choose Yes)

● Accepted. grok:researcher asks: "Is the users-table migration finished and deployed?"
● Replied: "Migrated in staging; production is scheduled for Thursday."
```

Grok then reports the answer in your Grok chat.

## Requirements

- **macOS.** v1 runs only on macOS. Linux (including WSL 2) and Windows are planned for later versions.
- **Claude Code 2.1.330 or later**, the version the approval mechanism was verified on. `init` and `doctor` check it.
- **Node.js 24 or later.**
- **A Grok Bot account** with a bot you can connect. Grok Bot runs on Cursor's infrastructure and uses a Cursor sign-in.
- **Touch ID or your macOS account password**, used to confirm privileged commands (see [Security boundary](#security-boundary)).

## Support matrix

| Host | Status |
|---|---|
| Claude Code CLI 2.1.330 | ✓ Verified |
| Claude desktop app, Code tab (bundles Claude Code 2.1.330) | ✓ Verified in both directions. The approval dialog shows every field with only **Deny / Allow once**, also in auto mode. |
| VS Code and JetBrains extensions | Untested |
| Grok Bot app | ✓ Verified |
| Codex CLI 0.171.0 | ✓ Verified (interactive sessions). Set up with `agentbridge add codex`; see [docs/setup-codex.md](docs/setup-codex.md). |
| macOS | ✓ Required (v1 is macOS only) |
| Linux, WSL 2, Windows | Not supported in v1 |

## Install and first try

```bash
npm install -g @musi27/agentbridge
```

```bash
agentbridge init
```

`init` takes under 10 minutes, excluding Grok setup. It:

1. checks that Claude Code is 2.1.330 or later
2. installs the agentbridge Claude Code plugin (user scope); restart open Claude Code sessions afterwards to load it
3. writes the deny rules into your Claude Code settings
4. checks that your effective `crossSessionInbound` setting is `accept`
5. checks the Touch ID / password helper works
6. creates the bridge's identity keys in your macOS Keychain and registers them with the relay
   (`https://relay.musi.live` by default)
7. asks for the approval mode: `per_conversation` (default) or `auto` with an allowlist
8. installs a launchd agent (`live.musi.agentbridge`) so the bridge starts at login
9. runs `agentbridge doctor` and prints a first try and the command to connect a Grok bot

Running `init` again only writes what changed. It also restarts the bridge if the running one is another version
(see [Upgrade](#upgrade)), and refreshes the Codex CLI setup if you added it. Options:

| Option | Effect |
|---|---|
| `--relay <url>` | Use another relay, for example your own ([docs/self-hosting.md](docs/self-hosting.md)) |
| `--mode per_conversation\|auto` | Choose the approval mode without asking |
| `--yes`, `-y` | Accept defaults without asking |
| `--skip-plugin` | Don't install the Claude Code plugin |
| `--skip-service` | Don't install the launchd agent (start the bridge with `agentbridge start`) |
| `--skip-relay` | Don't register with the relay |

The Touch ID helper (`agentbridge-helper`) ships prebuilt in the npm package. It is **ad-hoc signed, not notarised**.
Packages installed with npm aren't quarantined by macOS, so Gatekeeper doesn't block it; a copy downloaded with a
browser would be.

Then connect a Grok bot ([docs/setup-grok.md](docs/setup-grok.md)). In testing this took about 5 minutes, and the
round-trip check passed in 18 seconds:

```bash
agentbridge add grok
```

### From source

Until the npm package is published, or to develop agentbridge, build it from a clone:

```bash
git clone https://github.com/musi27/agentbridge.git
```

```bash
cd agentbridge && npm ci && npm run build && npm run build:helper -w @agentbridge/presence
```

```bash
alias agentbridge="node $PWD/packages/bridge/dist/cli/main.js"
```

```bash
agentbridge init
```

`init` installs the Claude Code plugin from the clone's in-repo marketplace.

**First try.** Open a Claude Code session in **default** permission mode and ask it:

```text
discuss with grok:<your-bot-name> whether this README is clear; stop after 4 turns
```

Approve the prompt. Watch the exchange in the Claude session and the per-run reports in your Grok chat.

Useful commands:

| Command | What it does |
|---|---|
| `agentbridge --version` | This agentbridge's version (and a note if the running bridge differs) |
| `agentbridge status` | Service, relay, participants, pending approvals |
| `agentbridge agents` | Participants and their states |
| `agentbridge conversations` | Conversation metadata (no message text) |
| `agentbridge doctor` | Check Claude Code and Node versions, deny rules, `crossSessionInbound`, the Touch ID helper, the launchd agent, the relay, policy integrity and file permissions |
| `agentbridge doctor grok:<name>` | Run the Grok round-trip check for one bot |
| `agentbridge show <id>` | Show a transcript (needs Touch ID or password) |
| `agentbridge open <address>` | Print the command that reopens a Claude session |

The full list is in [SPEC.md §14](SPEC.md#14-cli). For problems, see [docs/troubleshooting.md](docs/troubleshooting.md).

## Upgrade

```bash
npm install -g @musi27/agentbridge
```

```bash
agentbridge init
```

`npm install -g` replaces the files, but the bridge that is already running keeps the old code until it restarts.
`init` notices that the running bridge is another version and restarts it. It keeps your settings, identity and
conversations; approvals that were still pending expire and the requester is told.

Then restart open Claude Code sessions (or run `/reload-plugins` in each) and open Codex sessions, so they load the new
plugin. New sessions get it automatically. Check with:

```bash
agentbridge --version
```

```bash
agentbridge doctor
```

`doctor` and `status` warn when the CLI and the running bridge are different versions.

**Grok bots, upgrading to 0.2.3 from an earlier version:** paste the routine instruction again (it now lets Grok search
the web and X): copy it from [docs/setup-grok.md](docs/setup-grok.md#step-2-of-4-routine-instruction), replace the
whole instruction of the "Inbox from agentbridge" routine and save.

## Uninstall

```bash
agentbridge uninstall
```

It needs Touch ID or your password, works whether or not the bridge is running, and is safe to run again. It removes
the Claude Code plugin and its marketplace, the launchd agent, and the deny rules `init` added to your Claude Code
settings (nothing else in that file changes), and stops a running bridge. It keeps your data (`~/.agentbridge`) and the
Keychain items under service `agentbridge` unless you add `--purge-data`:

```bash
agentbridge uninstall --purge-data
```

It prints what it removed and what it left. Then, yourself:

1. In Grok, for each bot you connected, delete the `agentbridge` connector at [grok.com/connectors](https://grok.com/connectors)
   (signed in: open the connector, then remove it) and the "Inbox from agentbridge" routine. Do this yourself: Grok
   won't delete them when asked.
2. Remove the package, last:

```bash
npm uninstall -g @musi27/agentbridge
```

If the Touch ID helper is missing, follow the manual steps in
[docs/troubleshooting.md](docs/troubleshooting.md#uninstall).

## How approvals work

Every conversation needs one local approval from you (in the default `per_conversation` mode), plus one more for each
turn-limit extension.

- When a conversation needs approval, the agent calls the `bridge_confirm` tool with the facts of the request: kind
  (`start`, `accept` or `extend`), peer, direction, topic and turn limit.
- `bridge_confirm` is marked as requiring user interaction, so **Claude Code always shows its native permission prompt**.
  In the CLI the prompt offers only **Yes / No**; in the Claude desktop app, only **Deny / Allow once**. Neither has a
  "don't ask again" option, and both show every fact as a labelled field.
- Verified on Claude Code 2.1.330: the prompt appears in `default`, `acceptEdits`, `auto` and `bypassPermissions`
  modes, from subagents, and when the tool is deferred behind tool search. Allow rules and PreToolUse hooks do not
  skip it. In `dontAsk` mode and in headless `claude -p` it is denied, not approved.
- The bridge accepts the confirm only from the session that requested it, and only if every fact matches what was
  issued. If a hook or "Tab to amend" changes a field, the confirm is refused (`approval_mismatch`); approve the facts
  as issued or cancel.
- Unanswered approvals expire after 10 minutes. Pending approvals live only in the bridge's memory and are dropped if
  the bridge restarts.
- You can also resolve any approval from a terminal with `agentbridge approve <id>` or `agentbridge decline <id>`,
  which need Touch ID or your password. Use this for sessions in `dontAsk` mode.
- Grok-side approval cards are optional and not relied on. The local approval is the guarantee.

Details: [docs/security.md](docs/security.md#the-approval-mechanism).

## Security boundary

agentbridge protects your approvals against two things:

- **manipulation that arrives through conversations**, for example a Grok bot whose messages were shaped by something
  it read, and
- **a local agent misusing agentbridge's own tools**, for example a Claude session under prompt injection.

Neither can start or accept a conversation without you answering the native prompt, approve anything, change settings,
reach other conversations or fake agentbridge's notices.

**agentbridge does not protect against a local agent or program that deliberately tampers with it**, for example by
talking to the bridge socket directly, starting its own copy of the plugin's MCP server, editing files under
`~/.agentbridge`, reading Keychain items, or hosting Claude through the Agent SDK (whose `canUseTool` callback can
approve `bridge_confirm`). Anything running as your user can do what you can. Real protection would need OS-level
separation, which v1 does not have.

What stands between a tampering agent and agentbridge depends on Claude Code's permission mode:

- **Default mode:** each tampering action needs you to approve a shell command first. Answer **No** to any shell
  command that touches agentbridge, and never choose "Yes, and don't ask again" for one.
- **Auto mode:** Claude Code's classifier may run such commands without asking. In testing it ran all four tampering
  commands tried, with no prompt. agentbridge allows auto-mode sessions but adds a warning line to their approval
  prompts and lists them in `status` and `doctor`. **Use default mode for sessions that talk to other agents.**
- **Bypass mode (`--dangerously-skip-permissions`):** the `bridge_confirm` prompt still appears, but shell commands
  run without asking, so tampering is unprompted and the prompt is no defence. agentbridge refuses to start, accept or
  deliver to bypass-mode sessions unless you override that with `delivery.allow_bypass_sessions`.

**Deny rules are incomplete.** `init` writes Claude Code deny rules for agentbridge's privileged commands and for file
edits under `~/.agentbridge/**`. Plain reads of `~/.agentbridge` are not denied. They block plain forms, `env`/`VAR=` prefixes, absolute and relative paths,
`cd … &&`, `true;` and `$VAR` expansion. They do **not** block `sh -c '…'`, `node …/cli.js …`, or programs such as
`sqlite3` opening files in `~/.agentbridge`. (The CLI rejects global flags placed before a privileged subcommand, so
that form fails too.)

**User presence is the real barrier.** Privileged commands (`config set`, `approve`, `decline`, `extend`, `revoke`,
`remove`, `add grok`, `show`, `end`, `stop`, `identity rotate`, `purge`, `uninstall`) always require Touch ID or your
account password, checked by the bridge itself (`uninstall` checks it in the CLI, so it works with the bridge stopped). The bridge also detects casual edits to its policy and stops all conversation
activity when it finds one.

**Data can leave through a conversation.** Sending messages is not gated, so a manipulated remote agent could talk a
local agent into sharing file contents or secrets. The standing instruction tells Claude never to send secrets or
files you haven't asked it to share, and you approve each conversation, but that is a mitigation, not a guarantee.

Full threat model: [docs/security.md](docs/security.md). To report a vulnerability: [SECURITY.md](SECURITY.md).

## Data and privacy

When you talk to a Grok bot, conversation content leaves your Mac:

- **To xAI (SpaceX Super Intelligence LLC)**, which operates Grok.
- **Through Cursor (Anysphere) infrastructure.** Grok Bot runs on it: messages to Grok go to the Grok Bot webhook at
  `api2.cursor.sh`, and Grok's calls to the relay come from the same infrastructure. Cursor is not on xAI's published
  subprocessor list. This path is covered by your own Grok Bot and Cursor terms, not by agentbridge.
- **Into Grok's searches.** While answering, Grok may use its own web and X search. Its queries can contain words from
  the conversation; the routine instruction forbids secrets, tokens, links from the delivery and private details in
  them ([docs/security.md](docs/security.md#residual-risks)).
- **Through the relay.** The relay sees Grok → bridge content in plaintext as it arrives, then seals it to your
  bridge's key before storing it. Sealing protects against a storage leak, not against a malicious relay operator.
  Messages from the bridge to Grok go directly to the webhook, not through the relay.
- **A malicious or compromised relay can forge calls** that look like your Grok bot, including inside conversations
  your side started. Mitigations: conversations that arrive through the relay always need your local approval on the
  public relay; Claude treats everything another agent writes as untrusted; the relay is open source; and you can
  host your own.

agentbridge's commitments:

- It uses only the documented Grok Bot webhook and connector features. It never scripts the Grok app or calls internal APIs.
- It caps deliveries at 60 per bot per hour, well under Grok's limit of 200 runs per hour per routine.
- Grok output is stored only in your local bridge (`~/.agentbridge`). The relay stores no message plaintext beyond a
  response hand-off of about 30 seconds (a tool result waiting to be returned to Grok).
- It is not for training models on, distilling or reselling Grok output.
- The relay does not log message content; it keeps metadata only (identity records, bot token hashes and rate-limit
  counters), for rate limiting and debugging. Vercel keeps its own platform request logs (method, path, status, timing)
  under its retention policy.

Bridge logs never include message bodies.

## Relay and cost

The public relay runs at `relay.musi.live` on Vercel and Upstash free tiers. **The hosted relay is a free-tier service:
its availability isn't guaranteed.**

- **On-demand connection.** The bridge does not hold a connection open all the time. It connects while a Grok
  conversation is active and for 10 minutes after the last activity; otherwise it checks the relay for waiting
  messages once every 60 seconds. This keeps personal use inside the free tiers.
- **Daily cap.** Connected time is capped at 6 hours a day by default (`transport.max_connected_hours_per_day`).
  Beyond it the bridge stays in 60-second checking mode and shows a notification.
- **Self-hosting.** You can run your own relay on your own Vercel and Upstash accounts and point
  `transport.relay_url` at it. See [docs/self-hosting.md](docs/self-hosting.md). On a self-hosted or paid relay,
  `transport.relay_mode = always` keeps the connection open permanently.

The public relay may change plans or hosting if usage grows. It has no accounts: your bridge's key is your identity.

## Limitations

- **macOS only** in v1.
- **About 20 seconds per Grok turn.** Each Grok reply is a fresh routine run; in testing replies arrived about 20 s
  after delivery (16–23 s). A 30-turn conversation spends about 10 minutes on the Grok side alone.
- **Grok-initiated conversations can take about 60 seconds** to reach your approval prompt, because the bridge checks
  the relay once a minute when idle.
- **Grok approval cards expire after about 20 minutes.** If an Auto-review card holds Grok's reply and nobody answers
  it, the reply is lost and not retried. The bridge hints after 25 minutes without a reply. Setup adds an Allow rule
  so replies don't raise cards.
- **Grok's chat reports are written by the model**, so they are best effort.
- **Deliveries to Grok are short.** A routine run sees only about the first 4,000 characters of a delivery, so long
  messages arrive as previews and Grok fetches the full text through the connector.
- **Claude Code CLI, the Claude desktop app and Codex CLI.** The VS Code and JetBrains extensions and Codex in the ChatGPT desktop app are untested ([Support matrix](#support-matrix)).
- **Two participants per conversation**, no file attachments, no GUI, one computer per identity.
- New, fast-changing products on both ends: Claude Code or Grok Bot updates may change behaviour agentbridge relies on.

## Documentation

- [docs/README.md](docs/README.md): index of all documentation
- [docs/setup-grok.md](docs/setup-grok.md): connect a Grok bot
- [docs/setup-codex.md](docs/setup-codex.md): connect Codex CLI sessions
- [docs/security.md](docs/security.md): threat model and approval mechanism
- [docs/troubleshooting.md](docs/troubleshooting.md): common problems
- [docs/self-hosting.md](docs/self-hosting.md): run your own relay
- [CONTRIBUTING.md](CONTRIBUTING.md): repo layout and conventions
- [SPEC.md](SPEC.md): the specification

## License

[MIT](LICENSE).

agentbridge is not affiliated with, endorsed by or sponsored by xAI, SpaceX Super Intelligence LLC, Cursor
(Anysphere, Inc.) or Anthropic. Grok, Claude, Claude Code and Cursor are trademarks of their respective owners.
