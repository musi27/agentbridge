# Troubleshooting

Start with:

```bash
agentbridge doctor
```

`doctor` checks:

- Claude Code (2.1.330 or later) and Node.js (24 or later) versions
- the deny rules in your Claude Code settings, and that Claude Code isn't in bare mode
- each session's effective `crossSessionInbound` setting, and which sessions run in auto mode
- the Touch ID helper and the launchd agent
- the relay: that it is reachable and knows your identity, and how many messages are waiting
- policy integrity and the permissions of the database and socket

Each failed check prints a fix. `agentbridge doctor grok:<name>` runs the round-trip check for one Grok bot.
`agentbridge status` shows the service, relay, participants and pending approvals, and `agentbridge logs` shows recent
events (never message bodies).

Problems connecting a Grok bot are covered in [setup-grok.md](setup-grok.md#troubleshooting).

- [A Claude session doesn't receive messages (`recipient_unreachable`)](#a-claude-session-doesnt-receive-messages-recipient_unreachable)
- [Deliveries to a new session are held](#deliveries-to-a-new-session-are-held)
- [A session is refused: unsafe permission mode](#a-session-is-refused-unsafe-permission-mode)
- [The approval prompt is denied without asking](#the-approval-prompt-is-denied-without-asking)
- [The confirm is refused (`approval_mismatch`)](#the-confirm-is-refused-approval_mismatch)
- [Claude Code is too old](#claude-code-is-too-old)
- [The bridge isn't running](#the-bridge-isnt-running)
- [Using a different home folder or JSON output](#using-a-different-home-folder-or-json-output)
- [Relay offline or slow](#relay-offline-or-slow)
- [Touch ID is unavailable](#touch-id-is-unavailable)
- [The bridge stopped all conversations (policy tamper)](#the-bridge-stopped-all-conversations-policy-tamper)

## A Claude session doesn't receive messages (`recipient_unreachable`)

**Symptom.** The sender is told `recipient_unreachable`, and a notification says agentbridge cannot reach a Claude
session because its `crossSessionInbound` is `hold` or `refuse`. The messages stay queued.

**Cause.** agentbridge delivers into a session through Claude Code's cross-session inbox. Claude Code's
`crossSessionInbound` setting applies to these posts too:

- under `hold`, every post is held, and you see only a notice in the session
- under `refuse`, every post is dropped without a trace

Claude Code gives no delivery result in either case, so the bridge reads the effective setting itself (from user,
project, local and managed settings for the session's folder) and refuses to send instead of losing messages.

**Fix.** Set `crossSessionInbound` to `"accept"` in the Claude Code settings file that applies to that folder, for
example `~/.claude/settings.json`:

```json
{
  "crossSessionInbound": "accept"
}
```

A project's `.claude/settings.json` or `.claude/settings.local.json`, or a managed settings file, can override your user
setting; check those too. Then restart the session. Queued messages are delivered once the session is reachable again.

## Deliveries to a new session are held

**Symptom.** A message or invite to a session you just opened doesn't appear, and `status` shows its permission mode as
`unknown`.

**Cause.** Claude Code's SessionStart hook does not report the session's permission mode. The bridge learns it from
the first event that carries it (your first prompt or the first tool call). Until then, deliveries and invites are
held, not failed, so that agentbridge never delivers into a session that might be in bypass mode.

**Fix.** Send any prompt in the session. Held items are delivered once the mode is known. If the mode stays `unknown`
after that, a newer Claude Code version may report a mode name agentbridge doesn't recognise; check `agentbridge doctor`
and report it.

## A session is refused: unsafe permission mode

| Reason | Cause | Fix |
|---|---|---|
| `requester_unsafe_mode` | The session is in **bypass** mode (`--dangerously-skip-permissions`) and tried to start or accept a conversation | Restart the session in default mode. To allow bypass sessions anyway, set `delivery.allow_bypass_sessions = true` with `agentbridge config set` (needs user presence). |
| `recipient_unsafe_mode` | The receiving session is in bypass mode | As above |
| Warning line "This session is in auto mode …" | The session is in **auto** mode. It is allowed, but Claude Code may run shell commands that tamper with agentbridge without asking. | Read the approval prompt carefully, or switch the session to default mode. See [security.md](security.md#unsafe-permission-modes). |

## The approval prompt is denied without asking

**Symptom.** `bridge_confirm` is denied with "Permission … has been denied because Claude Code is running in don't ask
mode", or with `approval_unavailable`.

**Cause.** The session is in `dontAsk` mode, or runs headless (`claude -p`). There, Claude Code denies tools that need
user interaction instead of prompting.

**Fix.** Approve from a terminal:

```bash
agentbridge approve <approval-id>
```

It needs Touch ID or your password. The approval ID is in the notice. `agentbridge decline <approval-id>` declines.
The approval stays open for 10 minutes.

## The confirm is refused (`approval_mismatch`)

**Cause.** The facts in `bridge_confirm` differ from the issued approval, or it came from a different session. This
happens when you edit a field with "Tab to amend" or a PreToolUse hook rewrites the arguments.

**Fix.** Approve the facts exactly as issued, or cancel. To change the topic or turn limit, start a new request.

## Claude Code is too old

**Symptom.** `init` or `doctor` reports that Claude Code is older than 2.1.330.

**Cause.** agentbridge's approval prompt and inbox delivery were verified on Claude Code 2.1.330. Older versions were
not tested.

**Fix.** Update Claude Code and restart your sessions:

```bash
claude update
```

```bash
claude --version
```

`doctor` also fails if Claude Code runs in bare mode, where plugins don't load. Start Claude Code without bare mode.

## The bridge isn't running

**Symptom.** CLI commands say they can't connect to the bridge, or Claude sessions report that agentbridge is
unavailable.

The bridge normally runs as a launchd agent installed by `init`. A Claude Code session's SessionStart hook also starts
it if it isn't running.

**Fix.**

```bash
agentbridge start
```

```bash
agentbridge status
```

If it doesn't start:

- **Another instance holds the lock.** The bridge allows one instance (`~/.agentbridge/run/bridge.lock`). Check
  `agentbridge status`; stop the other instance with `agentbridge stop`.
- **Database too new.** If you downgraded agentbridge, the bridge refuses to open a database whose schema is newer
  than it understands. Install the newer version again.
- **Read the logs:** `agentbridge logs` shows bridge events. The launchd agent (`live.musi.agentbridge`, plist in
  `~/Library/LaunchAgents/`) writes the service's output to `~/.agentbridge/logs/bridge.out.log` and
  `~/.agentbridge/logs/bridge.err.log`.
- **Reinstall the login service:** `agentbridge init` (it only rewrites what changed), or run the bridge without it
  using `agentbridge start`.

Grok's messages are not lost while the bridge is down: the relay holds them for up to 7 days. Pending approvals live
only in memory, so they expire on a restart and the requester is told. A notification summarises what
happened while the bridge was down.

## Using a different home folder or JSON output

The bridge keeps its state in `~/.agentbridge`. To use another folder (for example a throwaway test setup), set
`AGENTBRIDGE_HOME` (honoured by the CLI, the bridge and the Claude Code plugin) or pass `--home <dir>` to the CLI. The
CLI, the bridge and the plugin must all use the same folder, or the plugin won't find the bridge's socket. `--json`
prints machine-readable output. For privileged commands, put global options **after** the subcommand (`agentbridge config set … --json`); the CLI rejects them before it.

## Relay offline or slow

**How the connection works.** To stay inside free hosting tiers, the bridge connects to the relay only while a Grok
conversation is active and for 10 minutes after the last activity. Otherwise it checks the relay once every 60 seconds. On a relay you run yourself, `agentbridge config set
transport.relay_mode always` keeps it connected permanently (see [self-hosting.md](self-hosting.md)).

| Symptom | Cause | What to do |
|---|---|---|
| A conversation Grok starts takes up to about a minute to reach your approval prompt | Idle-mode checking every 60 seconds | Expected. Nothing to fix. |
| Grok says a message is **held** (`held_relay`) | The bridge was not connected or didn't answer within 20 seconds | Expected while idle or offline. The bridge picks it up on its next check or connect. |
| Grok's read tools fail with `bridge_offline` | The bridge isn't connected | Reads only happen during active conversations, when the bridge is connected. If this persists, check the bridge is running and online. |
| Notification "relay disconnected" (after 5 minutes) | Your Mac is offline, the relay is down, or the relay's hosting is paused | Check your network and `agentbridge status`. On a self-hosted relay on Vercel Hobby, check for `503 DEPLOYMENT_PAUSED` ([self-hosting.md](self-hosting.md#vercel-hobby-can-pause-your-whole-team)). |
| Notification that the daily connected-time cap was reached | The bridge was connected for 6 hours today (`transport.max_connected_hours_per_day`) | It stays in 60-second checking mode until the next day. Conversations keep working, with up to 60 seconds' delay for Grok's messages. End stuck conversations with `agentbridge end --inactive <duration>`. |

Messages held at the relay expire after 7 days. If any expire, both you (notification) and Grok (a notice) are told.

## Touch ID is unavailable

Privileged commands use macOS LocalAuthentication with `deviceOwnerAuthentication`: Touch ID, **falling back to your
macOS account password**. You don't need Touch ID hardware; the password dialog works without it.

| Message | Meaning | Fix |
|---|---|---|
| Cancelled | You (or the dialog) cancelled | Run the command again. |
| Authentication failed | The fingerprint or password wasn't accepted | Run the command again. |
| Cancelled by the system | macOS interrupted the dialog, for example by locking the screen or switching users | Unlock and run the command again. |
| Not available | LocalAuthentication can't run on this Mac or in this context | Check that your account has a login password, then run `agentbridge doctor`. |
| Helper missing | The Touch ID helper (`agentbridge-helper`) wasn't found | The npm package ships it prebuilt; reinstall with `npm install -g agentbridge`. From source, build it with `npm run build:helper -w @agentbridge/presence`. Then run `agentbridge doctor`. |

Without a working presence check, the bridge refuses privileged commands. Conversations keep working.

## The bridge stopped all conversations (policy tamper)

**Symptom.** A notification says policy tampering was detected, and the bridge refuses deliveries, starts and confirms.

**Cause.** The stored policy doesn't match its integrity check, or was rolled back to an older version. That happens
if something edited `~/.agentbridge/agentbridge.db` directly.

**Fix.**

```bash
agentbridge config verify
```

It needs user presence. It shows the current policy against the last verified one; re-approve the current policy if
you made the change, or restore the last verified one. Then find out what edited the file.
