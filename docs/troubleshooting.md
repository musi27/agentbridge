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
events (never message bodies). `agentbridge status --watch` keeps a live view open: what waits on you (approvals,
messages held for a session's first prompt), active conversations, live agents, recent notices and health.

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
- [Uninstall](#uninstall)

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

The sender is told the message is held until someone types in that session. If it is still held after 30 seconds,
you get a macOS notification ("agentbridge: message waiting"), and `agentbridge status` shows the session as
`waiting for first prompt`.

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

## After an upgrade, the bridge still runs the old version

**Symptom.** `agentbridge status` or `agentbridge doctor` says *the running bridge is 0.x.y but this agentbridge is
0.x.z*, or a fix you upgraded for isn't there.

`npm install -g` replaces the files, but the bridge already running keeps the old code. The launchd agent's settings
don't change on an upgrade, so nothing restarts it until you next log in.

**Fix.**

```bash
agentbridge init
```

`init` restarts the bridge on the installed version. Pending approvals expire on the restart; settings, identity and
conversations are kept. Then restart open Claude Code sessions (or `/reload-plugins`) and Codex sessions.

Upgrading a Grok bot to 0.2.3 from an earlier version: paste the routine instruction again
([setup-grok.md, step 2](setup-grok.md#step-2-of-4-routine-instruction)). Until you do, Grok says it can't search in the
routine.

If you run the bridge without the login service (`init --skip-service`), restart it yourself with
`agentbridge stop` and then `agentbridge start`.

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
| Grok says a reply is waiting "until your computer is back online" every time, while `agentbridge doctor` shows the relay `connected`, and `agentbridge doctor grok:<name>` fails with no calls seen | Grok's `agentbridge` connector still points at an older address: one set up before agentbridge was reinstalled or its data purged. The relay still accepts that old connector, so replies queue at an address no bridge reads | In Grok, edit the `agentbridge` connector so its URL is the one `agentbridge doctor grok:<name>` prints (`…/v1/u/<user id>/b/<bot id>/mcp`), or delete it yourself at [grok.com/connectors](https://grok.com/connectors) (Grok won't delete it) and run `agentbridge add grok` again. If you no longer have the current token, run `agentbridge revoke grok:<name>` for a new one. Then run `agentbridge doctor grok:<name>` again. |
| During `agentbridge add grok`, Grok says removing the old `agentbridge` connector is refused, or offers to add a second connector under another name | Grok won't delete connectors itself | Don't accept a second connector: tool names clash and the old one's token no longer works, so replies get lost. Delete the old connector yourself at [grok.com/connectors](https://grok.com/connectors) (signed in: open it, then remove it), and any old "Inbox from agentbridge" routine in the Grok Bot app. Then send the setup prompt again. |
| Grok's read tools fail with `bridge_offline` | The bridge isn't connected | Reads only happen during active conversations, when the bridge is connected. If this persists, check the bridge is running and online. |
| Notification "relay disconnected" (after 5 minutes) | Your Mac is offline, the relay is down, or the relay's hosting is paused | Check your network and `agentbridge status`. On a self-hosted relay on Vercel Hobby, check for `503 DEPLOYMENT_PAUSED` ([self-hosting.md](self-hosting.md#vercel-hobby-can-pause-your-whole-team)). |
| Notification that the daily connected-time cap was reached | The bridge was connected for 6 hours today (`transport.max_connected_hours_per_day`) | It stays in 60-second checking mode until the next day. Conversations keep working, with up to 60 seconds' delay for Grok's messages. End stuck conversations with `agentbridge end --inactive <duration>`. |

Messages held at the relay expire after 7 days. If any expire, both you (notification) and Grok (a notice) are told.

## After an upgrade, macOS asks to use the "agentbridge" keychain items

**Symptom.** After `npm install -g @musi27/agentbridge` and `agentbridge init`, macOS shows one or more dialogs:
"AgentBridge wants to use your confidential information stored in "agentbridge" in your keychain."

**Cause.** The keychain lets an item be read silently only by the program identity that saved it. Up to 0.2.5 the
helper (`AgentBridge.app`) was ad-hoc signed, so that identity was the exact build, and every release that changed
the helper asked once per item: the identity keys, the policy key, version and snapshot, and three items per Grok bot
(about 7 with one bot). The helper is now signed with the project's Apple Developer ID, so the identity is "this
team's AgentBridge", which later releases keep. **The first signed release asks one last time** for each item saved
by an ad-hoc build. After that, updates don't ask.

**Fix.** Enter your login password and choose **Always Allow** in each dialog. **Deny** makes that read fail, so the
command or the bridge stops with a keychain error. Run it again (`agentbridge init` restarts the bridge) and allow it.

If a signed release keeps asking on every update, check the installed helper's signature:
`codesign -dv "$(npm root -g)/@musi27/agentbridge/bin/AgentBridge.app" 2>&1 | grep -E 'TeamIdentifier|Signature'`
should show `TeamIdentifier=67B9AY2VHJ` and no `Signature=adhoc`. A helper built from source (`npm run build:helper`)
is ad-hoc signed and behaves like the old releases.

## Touch ID is unavailable

Privileged commands use macOS LocalAuthentication with `deviceOwnerAuthentication`: Touch ID, **falling back to your
macOS account password**. You don't need Touch ID hardware; the password dialog works without it.

| Message | Meaning | Fix |
|---|---|---|
| Cancelled | You (or the dialog) cancelled | Run the command again. |
| Authentication failed | The fingerprint or password wasn't accepted | Run the command again. |
| Cancelled by the system | macOS interrupted the dialog, for example by locking the screen or switching users | Unlock and run the command again. |
| Not available | LocalAuthentication can't run on this Mac or in this context | Check that your account has a login password, then run `agentbridge doctor`. |
| Helper missing | The Touch ID helper (`AgentBridge.app` in the package's `bin/`) wasn't found | The npm package ships it prebuilt; reinstall with `npm install -g @musi27/agentbridge`. From source, build it with `npm run build:helper -w @agentbridge/presence`. Then run `agentbridge doctor`. |

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

## Uninstall

`agentbridge uninstall` removes the plugin, the launchd agent and the deny rules, and stops the bridge; add
`--purge-data` to also delete `~/.agentbridge` and the Keychain items. See [the README](../README.md#uninstall). Lines
marked `FAIL` come with a fix; `absent` means that part was already gone. Running it again is safe.

**By hand.** If `agentbridge uninstall` can't run (for example the Touch ID helper is missing), do the same steps
yourself:

1. Stop the bridge:

   ```bash
   agentbridge stop
   ```

   `stop` needs the Touch ID helper too. If it fails, step 2 stops a bridge launchd runs; quit Claude Code sessions so
   the plugin doesn't start it again.

2. Remove the launchd agent:

   ```bash
   launchctl bootout gui/$(id -u)/live.musi.agentbridge
   ```

   ```bash
   rm ~/Library/LaunchAgents/live.musi.agentbridge.plist
   ```

3. Remove the Claude Code plugin and its marketplace:

   ```bash
   claude plugin uninstall agentbridge@agentbridge
   ```

   ```bash
   claude plugin marketplace remove agentbridge
   ```

4. In `~/.claude/settings.json`, delete the agentbridge entries from `permissions.deny`: every
   `Bash(agentbridge …:*)` rule and `Edit(~/.agentbridge/**)`. Leave everything else as it is.
5. Optional, deletes your conversation history and keys: remove the data folder, then the Keychain items. Run the
   `security` command repeatedly until it says the item could not be found.

   ```bash
   rm -rf ~/.agentbridge
   ```

   ```bash
   security delete-generic-password -s agentbridge
   ```

6. In Grok, for each bot, delete the `agentbridge` connector at [grok.com/connectors](https://grok.com/connectors)
   (signed in: open the connector, then remove it) and the "Inbox from agentbridge" routine. Grok won't delete them
   itself.
7. Last:

   ```bash
   npm uninstall -g @musi27/agentbridge
   ```

## Codex: tools work but messages never arrive

**Symptom.** A Codex session can call agentbridge tools, but invites and replies never show up in it, and
`agentbridge status` shows the `codex:` session as `waiting for first prompt`, or doesn't list it at all.

**Cause.** Codex hasn't run the agentbridge hooks. Codex runs only hooks you've trusted, and without them the bridge
never learns the Codex session id that `codex queue` needs.

**Fix.** In Codex, run `/hooks` and trust the 5 "agentbridge: …" hooks (see
[Connect Codex CLI sessions](setup-codex.md#set-up), step 3), then start a new session. Hooks marked **modified** need
trusting again too: that happens after an upgrade that changes them, or if you changed agentbridge's install location
and ran `agentbridge add codex` again.

## Codex: "Codex auto-review is on" when confirming

**Cause.** The session runs with auto-review (`--approve-for-me` or `approvals_reviewer = "auto_review"`), so a model
would answer the approval prompt instead of you. agentbridge refuses those approvals.

**Fix.** Approve in a terminal with `agentbridge approve <id>` (the id is in the message), or start Codex without
auto-review and ask it to confirm again.
