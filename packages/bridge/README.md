# @agentbridge/bridge

The bridge service core (SPEC v0.4 §4.1): the single sequencer and source of truth for conversations between local
Claude Code sessions and Grok bots. It stores state in SQLite, holds approvals in memory, enforces policy, runs the
delivery queue, serves the local IPC socket, and ships the `agentbridge` CLI.

It depends on `@agentbridge/protocol` and `@agentbridge/adapter-grok` (loaded by default for `grok` participants). The
Claude Code plugin, the macOS presence/keychain/notification helpers and the relay are separate packages that plug in
through protocol interfaces (the relay client through the small `RelayTransport` interface in `relay/link.ts`).

## Layout

```
src/
  paths.ts              ~/.agentbridge layout (root overridable; macOS caps socket paths at 104 bytes)
  clock.ts              injectable clock (FakeClock drives every timer in tests)
  db/                   node:sqlite storage: schema v1 (§15.4), transactional migrations, typed Store
  policy/               policy document (§15.2), allowlist (§7.5), HMAC + version integrity (§9.3)
  core/
    rules.ts            pure rules: state machine, turns, extension, modes, invite limits, addressing
    approvals.ts        in-memory approvals bound to participant + epoch, exact-match confirm, expiry
    notices.ts          §9.1 notices with Claude `parts` and Grok `text`
    engine.ts           tool calls, sequencing, idempotency, Grok rules, timers, registration, restart recovery
  delivery/
    pipeline.ts         durable queue, per-participant ordering, retries (2 s/10 s/30 s), queue expiry
    claude-adapter.ts   renders items with the session nonce and hands them to the live plugin link
  ipc/
    server.ts           Unix socket, NDJSON ≤ 256 KB, hello/registration/tool.*/cli.*/deliver/post_result
    peer.ts             peer pid/uid via lsof + ps (best effort, §2.3)
    cli-methods.ts      bridge side of the CLI; privileged methods run the presence check here
    client.ts           IPC client (CLI, tests, reference for the plugin)
  relay/link.ts         RelayLink: relay calls → Grok tool handlers; token re-verification; markActive (§12.3, §13.2–13.3)
  grok/setup.ts         bridge side of add grok / revoke grok / doctor round trip (§12.5, §12.6)
  cli/grok.ts           interactive add grok / revoke grok (clipboard, hidden input)
  inbound.ts            effective Claude Code crossSessionInbound for a cwd (§11.3)
  platform.ts           loads @agentbridge/presence; fails closed without it
  service.ts            startBridge(): lock file, storage, policy, engine, IPC
  cli/main.ts           `agentbridge` bin
```

## Run

```bash
npm install
npm run check                       # tsc -b + all tests (root)
node --conditions=agentbridge-source --test packages/bridge/test/*.test.ts
```

Development service without the macOS helpers (secrets in a 0600 file, privileged commands refused):

```bash
AGENTBRIDGE_DEV_SECRETS=1 node --conditions=agentbridge-source packages/bridge/src/cli/main.ts start --home /tmp/abdev
```

```bash
node --conditions=agentbridge-source packages/bridge/src/cli/main.ts status --home /tmp/abdev
```

After `npm run build`, the bin is `packages/bridge/dist/cli/main.js`.

## Install and run (macOS)

```bash
npm install && npm run build
node packages/bridge/dist/cli/main.js init            # public relay; --relay <url> for a self-hosted one
```

`init` is idempotent and re-runnable: Claude Code version check, plugin install from the in-repo marketplace (user
scope), deny rules, crossSessionInbound check, one Touch ID check, identity keys in the keychain, relay registration
(`transport.relay_url`), approval mode, launchd agent (runs `dist/cli/service-main.js`), doctor. Flags: `--relay <url>`,
`--mode per_conversation|auto`, `--yes`, `--skip-plugin`, `--skip-service`, `--skip-relay`.

Re-running `init` changes only what differs. It stops the bridge only to write identity/relay/policy changes, writing
`run/setup.lock` first so on-demand starts (the plugin's SessionStart hook, `agentbridge start`) wait. It takes the
bridge lock right after stopping (retrying ~5 s, and stopping a bridge another session started if it is ours). It
restores the previous state (launchd plist bootstrapped again, or the manual bridge restarted) on any abort. A plist
refresh alone just reinstalls the agent.

The service starts the relay client (`src/relay/runtime.ts`) when identity keys exist and `@agentbridge/relay` is
installed: mode and daily cap from `transport.relay_mode` (`on_demand`|`always`) and
`transport.max_connected_hours_per_day` (default 6); ack cursor and connected-time usage persist in the `kv` table;
relay expiry records become notice-only Grok deliveries; reaching the cap raises a must-act popup. Grok calls go to `RelayLink.handleCall`, and the link is attached to the client before it starts, so `add grok`, `revoke` and the doctor round trip use the live relay connection.

## Contracts for other workstreams

- **Plugin (B):** connect to `run/bridge.sock`, `hello {client: 'plugin'}`, then `register_session` with `claude_pid`
  = the MCP server's parent pid. Answer every `deliver` event item with `post_result` (ok = inbox write succeeded);
  the bridge already spaces posts ≥ 200 ms apart per session. Hooks send `session_event` on their own `hello {client: 'hook'}` connection; send
  `permission_mode` on every event that carries it (deliveries to a session stay held until its mode is known).
  `reconnect_session` with the secret keeps the epoch while the bridge keeps running; after a bridge restart,
  register again.
- **Presence (E):** `@agentbridge/presence` is an optional peer dependency (it resolves to the workspace once the
  package lands). A rejected `notify()` (e.g. no GUI session under launchd) keeps the popup for the next
  `agentbridge status`. Export `createSecretStore()`, `createPresenceChecker()`, `createNotifier()` from
  `@agentbridge/presence`. The keychain store must accept any secret name (`SECRET_NAMES`, incl. `policy.snapshot`).
- **Relay (C) — stable `RelayLink` API** (`src/relay/link.ts`):
  - `new RelayLink({ engine, transport?, endpoint?, resultBytes? })`, or `startBridge({ relay: { transport, endpoint } })`
    (exposed as `svc.relay`). `transport` is the `RelayClient` from `@agentbridge/relay/client`; it must provide
    `control(method, params)`, `markActive()` and `ensureConnected(graceMs?)`. `endpoint` = `{ origin, userId }`.
  - `link.attach(transport, endpoint)` when the client is created after the service.
  - `onCall: (c) => svc.relay.handleCall(c)`: `handleCall({ reqId, entryId?, call, deadlineMs?, held })` resolves to
    `{ result } | { error: { code, message } }` once the call is stored (SQLite); it throws only if the engine did.
    It checks the caller (relay `caller` bot id + token against the bridge's own hash), whitelists Grok tools and
    parameters, uses the relay-allocated `conversation_id` for starts, pages reads under `LIMITS.relayResultBytes` (one
    message per page at least, up to the client's 1 MB), maps failures to short texts for the model, and turns held
    writes the bridge rejects (other than `duplicate_reply`) into notice-only deliveries.
  - `link.startReplyWatch()` / `stopReplyWatch()` (the service runs it): §13.2 "reply awaited", `markActive()` every
    5 min while a reply from a Grok bot is awaited, until 25 min after the hand-off. The default Grok adapter also calls
    `markActive()` before every delivery. `control()` neither marks activity nor connects: the client does that itself.
  - Not here: constructing the `RelayClient` (keys, cursor, expiry, usage, `cap_reached` popup) — see the TODO in `service.ts`.

## Grok (§12)

- `agentbridge add grok` (privileged): the CLI asks for a name; the bridge (after the presence check) mints `bot_id` and a
  256-bit token, stores the token in the keychain, calls `register_bot { bot_id, token_hash, discovery }` on the relay and
  creates the participant. The CLI copies Appendix A (pbcopy), shows the token once (copy step), copies Appendix B and
  loops until the user confirms the panel shows "You receive deliveries from agentbridge", reads the webhook URL and key
  with hidden input, and runs the mandatory round trip (≤ 90 s; failures list the four causes in order). Follow-up steps
  carry the setup id returned by the first step (256-bit, 30 min) instead of asking for presence again.
- The round trip sends a test delivery through the real adapter; a probe in `RelayLink` answers the run's calls for that
  conversation id, so nothing is stored. `agentbridge doctor grok:<name>` repeats it; plain `doctor` includes the
  adapter's checks.
- The token goes to the clipboard and is printed only if the clipboard fails or the user types `show`; afterwards the
  clipboard is cleared if it still holds the token. An error or Ctrl-C before the webhook step undoes the bot
  (`revoke_bot`, keychain token, participant); so does a setup that expires without its webhook.
- `agentbridge revoke grok:<name>` (privileged) writes the new token to the keychain and the DB first, then re-registers
  it with the relay; if the relay refuses, the old token is restored everywhere. The round trip follows by default.
- `agentbridge remove grok:<name>` also sends `revoke_bot` and clears the bot's keychain entries.
- Round trips: one at a time per bot, at most 6 per bot per hour, each counted as a hand-off in the hourly cap; one 90 s
  budget covers the POST, retries of network errors / 5xx (same payload) and the wait. Network failures are reported
  apart from the four Grok-side causes.
- Grok deliveries: a held conversation merges at most 10 messages / 8 notices into one delivery (then a new one queues
  behind it), and packing never fails on size (it keeps the newest stubs, `truncated: true`). The 25-min hint and the
  1 h notice count from the hand-off to Grok. Grok can reply to, and see in its transcript, only messages it was sent.
- Grok reads: `bridge_get_messages(conversation_id, after_seq?)` returns `{ messages, next_after_seq }` (default: the
  latest delivery that carried messages; only messages the bot sent or that reached it). `bridge_get_transcript` and
  `bridge_list_conversations` take the same size budget.
- A Grok reply that names `in_reply_to` is accepted while that message's delivery is still settling (the run can call
  back before the webhook answer is processed, or after an ambiguous network error that started a run); the retry's run
  then gets `duplicate_reply`.

## Behaviour notes

- Addresses that match several participants return `recipient_ambiguous` with candidates; `<agent>:<short_id>`
  picks one. New Claude participants are named after the cwd basename plus the git branch (unless it is a default
  branch), with `-2`, `-3` suffixes. Claude Code's session title is shown beside the address as a label.
- The message that reaches the turn limit is delivered, then the conversation ends. If that delivery fails, the
  turn is given back and the conversation continues.
- Turn numbers are labels and are never reused. `turn_count` counts consumed turns; a permanently failed or expired
  delivery refunds one. Delivery headers show `turn = turn_count + refunds` and `turn_limit = limit + refunds`, so
  they line up with the message numbers (e.g. after one refund in a 30-turn conversation the last turn is 31/31).
- A newer valid registration for a participant sends the old connection the IPC event `replaced { reason }` and
  closes it; a registration whose own connection closed while it was being checked never displaces the live one.
  `claude --resume` of a session that is still running in another terminal becomes its own participant.
- Approvals are re-checked for bypassPermissions at confirm time (requester and recipient); a refusal leaves the
  approval issued. A Claude sender's own tag code is escaped in everything it writes (topic, bodies).
- Unknown `permission_mode` strings from newer Claude Code versions are treated as `unknown` (deliveries held).
- Pending approvals are never stored. The event log records issue/resolve so that after a restart requesters get an
  `approval_expired` notice, invites already shown end as `approval_expired`, and invites never shown are re-issued.
- Logs (`events`) never contain message bodies or topics.
- In `dontAsk` mode, `bridge_cancel` returns `approval_unavailable` and keeps the approval alive for `agentbridge approve`.
- The pair cooldown (§8.3) counts declines and expiries of invites a human saw, plus queue-expired invites.
