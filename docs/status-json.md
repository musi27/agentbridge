# `agentbridge status --json`: the agent panel data contract

`agentbridge status --json` prints one snapshot of everything the bridge knows that a panel needs: what waits on you, your agents grouped by project, the conversations between them, recent notices and the bridge's health. `agentbridge status --watch --json` prints the same snapshot as one JSON object per line, each time something changes. AgentBridge.app's menu-bar dropdown and graph window read this; scripts can too.

Both commands are read-only: no Touch ID, nothing is changed, and notices are not marked as shown (plain `agentbridge status` still reports them once). They read the same bridge call as `agentbridge status --watch`, so the terminal panel and the JSON always agree.

## What it never contains

No message bodies, transcript text, tokens, keys, session secrets, tag codes, inbox paths or transcript paths. The snapshot is built field by field from an allowlist, and a test seeds a conversation with known message text and checks that it never appears. It contains no absolute paths either: projects are identified by an opaque hash, `folder` is a folder name only, and any absolute path inside free text (topics, titles, notices, warnings, errors) is cut to its last segment (`…/notes.md`). What it does contain, and that you should treat as personal when you share output: agent addresses and titles (Claude Code's session title), conversation topics, notice text, and folder and repository names.

Every agent-written string (addresses, titles, topics, notice text) is plain text: escape sequences, control characters and bidi overrides are removed, and whitespace is collapsed.

## Commands

| Command | Prints | Exit code |
|---|---|---|
| `agentbridge status --json` | One snapshot, pretty-printed | `0`; `1` when the bridge can't be reached (the snapshot then says `"bridge": {"running": false, …}`) |
| `agentbridge status --watch --json` | One JSON object per line: a `snapshot` when the state changes, a `heartbeat` after 15 s without a change | `0` on Ctrl-C (SIGINT), SIGTERM, or when the reader closes the pipe (`… \| head -1`) |

The stream:

- polls the bridge every 1.5 s and prints a snapshot only when it differs from the last one printed (`generated_at` aside), so two consecutive snapshot lines are never equal;
- prints `{"schema": 1, "kind": "heartbeat", "generated_at": "…"}` when nothing changed for 15 s, so a reader can tell a quiet bridge from a dead stream;
- keeps going when the bridge stops: it prints a `running: false` snapshot, keeps polling, and prints a full snapshot when the bridge is back;
- writes each line whole and at once (no buffering across lines), never colour or other ANSI codes.

Stdout carries only JSON. Errors are part of the snapshot (`bridge.error`), never extra human text.

## Versioning

`schema` is `1`. Within one schema version:

- **May change:** new fields can appear anywhere, new values can appear in string enums (`state`, `activity`, `hold`, `via`, warning `code`, …), and lists can get longer (more notices, a higher cap on ended conversations). Readers should ignore what they don't know.
- **Won't change:** existing fields keep their name, type and meaning; they are not removed.

A breaking change bumps `schema`. Check it and refuse (or degrade) on a version you don't know.

## Ordering

Output is stable, so two snapshots of the same state are byte-identical and diffs are meaningful:

- `needs_you`: approvals first, soonest `expires_at` first (no expiry last), then held messages by agent and reason;
- `agents`: by `project.label`, then `project.key`, then `address`; agents without a project (Grok bots) last;
- `conversations`: most recent `last_activity_at` first, then `id`;
- `notices`: newest first;
- `warnings`: in the order listed under [warnings](#warnings).

## Snapshot

Times are ISO 8601 UTC strings. A field documented as "or null" is always present.

| Field | Type | Meaning |
|---|---|---|
| `schema` | number | Schema version (see [Versioning](#versioning)) |
| `kind` | `"snapshot"` | `"heartbeat"` lines have only `schema`, `kind` and `generated_at` |
| `generated_at` | time | When the CLI built this snapshot |
| `bridge` | object | [Bridge health](#bridge) |
| `warnings` | array | [Things to fix](#warnings) |
| `needs_you` | array | [Approvals and held messages](#needs_you) waiting on a human |
| `agents` | array | [Agents](#agents): live ones, plus closed ones that a listed conversation names |
| `closed_agents` | number | Closed sessions not listed in `agents` |
| `conversations` | array | [Conversations](#conversations): pending and active, plus up to 20 that ended today (bridge local time), most recently ended first |
| `notices` | array | The last 5 [notices](#notices) the bridge showed or queued |

### bridge

| Field | Type | Meaning |
|---|---|---|
| `running` | boolean | `false` when the bridge can't be reached; then only `error` and `cli_version` follow, and every list is empty |
| `error` | string | Only when `running` is `false`: why |
| `version`, `pid`, `started_at` | string, number, time or null | The running bridge |
| `cli_version` | string | This CLI |
| `version_mismatch` | string or null | Set when the CLI and the bridge are different releases (`agentbridge init` restarts the bridge on the CLI's version) |
| `complete` | boolean | `false` when the bridge is older than the CLI and sent no panel fields: `conversations` and `notices` are then empty and every `project` is null |
| `policy` | object | `{ok: true, version, mode}` (mode: `per_conversation`, `auto`, …) or `{ok: false, reason}` when the policy failed its integrity check |
| `relay` | object | `{state, mode}`; state: `connected`, `idle` (configured, not connected), `not_configured`, `unknown`; mode: `on_demand`, `always` or null |

### warnings

`{code, text, agents?}`, in this order:

| `code` | When |
|---|---|
| `version_mismatch` | The CLI and the bridge are different releases |
| `policy_tampered` | The policy failed its integrity check; run `agentbridge config verify` |
| `auto_mode` | Sessions in Claude Code auto mode (`agents` lists them): Claude Code may not ask before shell commands |
| `relay_disconnected` | The relay should always be connected (`relay_mode: always`) and isn't |

### needs_you

An approval: `type: "approval"`.

| Field | Type | Meaning |
|---|---|---|
| `approval_id` | string | The approval's id (for `agentbridge approve <id>` / `decline <id>`) |
| `kind` | string | `start` (an agent wants to start a conversation), `accept` (an invitation), `extend` (more turns) |
| `from`, `to` | address | Who asks and who is asked: for `accept`, `from` is the inviter |
| `topic` | string | The proposed topic (agent-written) |
| `turn_limit` | number or null | Turns asked for |
| `expires_at` | time or null | When it expires; null while an invitation hasn't reached the session yet |
| `conversation_id` | string or null | Null for `start` (no conversation exists yet) |
| `answer_in` | address | The agent whose own permission prompt shows this approval |
| `answer_with` | `prompt` or `cli` | `prompt`: answer in that agent's prompt. `cli`: that session can't show prompts (`dontAsk` mode), so use `agentbridge approve <approval_id>` |

Held messages: `type: "held_messages"`, `{agent, hold, count, text}`. `hold` says why they wait: `unknown_mode` (until someone types in the session), `closed`, `unreachable`, `policy`, `serialized`, `cap`, `retry`, `invite_wait`. `text` is the same sentence the terminal panel shows. Messages being delivered right now are not listed.

### agents

| Field | Type | Meaning |
|---|---|---|
| `address` | string | `claude:<name>`, `codex:<name>`, `grok:<name>`, … |
| `app` | string | The part before the colon: `claude` (Claude Code), `codex` (Codex CLI), `grok` (Grok bot), … |
| `name`, `short_id` | string | The part after the colon; a short stable id (`agentbridge open claude:<short_id>` works when names collide) |
| `title` | string or null | Claude Code's session title |
| `mode` | string or null | Permission mode of a Claude Code or Codex session (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, …); null for bots and before a session's first prompt |
| `state` | string | `live`, `unreachable` (the session doesn't accept cross-session messages), `closed` |
| `activity` | string | What the panel shows: `waiting_first_prompt`, `approval` (an approval waits in its prompt), `in_conversation`, `unreachable`, `live`, `closed` |
| `folder` | string or null | Name of the session's working folder |
| `project` | object or null | `{key, label}`: see below. Null for Grok bots and sessions with no known folder |

**Projects.** A project is the git repository the session's working folder is in. `project.label` is the repository folder's name. `project.key` is an opaque id: `p_` and 16 hex characters, the start of the SHA-256 of the repository's root path. It contains no path and can't be turned back into one by reading it. It is stable: the same repository on this Mac always gets the same key, across snapshots and bridge restarts, and two repositories get different keys (two folders with the same name included, which is why you group by `key` and display `label`). The hash is not salted, so two Macs with a repository at the same path give the same key; that's fine, keys only group agents within one snapshot. The bridge keeps the real root path in its local database and never sends it out. Sessions in the same repository share a key: subfolders, `-2` sessions, and linked worktrees (`git worktree add`, `.claude/worktrees/…`) all resolve to the main repository's folder. A submodule is its own project. A folder outside any repository is its own project (keyed by that folder's path). Symlinks are resolved, so two spellings of one folder give one key. The bridge works the key out once, when it first learns a session's folder, by reading `.git` files (it doesn't run `git`).

### conversations

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Conversation id |
| `from`, `to` | address | Initiator and invitee |
| `topic` | string | Agent-written topic |
| `state` | string | `pending` (invitation not accepted yet), `active`, `ended` |
| `end_reason` | string or null | When ended: `ended_by_participant`, `turn_limit`, `declined`, `manual`, `approval_expired`, `invite_expired`, `participant_gone` |
| `turns` | object | `{used, limit}` |
| `origin` | string or null | `local` or `relay` (started by a Grok bot) |
| `queued` | boolean | The invitation waits for the invitee's session to open |
| `started_at`, `ended_at` | time or null | Created and ended |
| `last_activity_at` | time | Last change (message, approval, end) |
| `approvals` | array | Who let it happen, oldest first: `{kind, via, agent, at, turn_limit?}` |

**Approval provenance.** Each entry in `approvals` is one approval that took effect. `kind` is `start`, `accept` or `extend` (`turn_limit` is the new limit). `agent` is the agent the approval belonged to. `via` says how it was given:

| `via` | Meaning |
|---|---|
| `prompt` | A human answered in `agent`'s own permission prompt |
| `cli` | A human ran `agentbridge approve` (Touch ID) for `agent`'s approval |
| `allow_rule` | No prompt: an auto allow rule in the policy matched (`agent` is the initiator) |
| `bot` | A Grok bot invitee accepted by itself (`agent` is the bot) |

A Grok-started conversation has no `start` entry: the bot started it, and the human's approval is the `accept`. Conversations from before this version have an empty list.

### notices

`{at, title, body}`: the bridge's own notices (desktop notifications), newest first. They are the bridge's wording and never quote a message body; they can name agents.

## Example

Made-up data (`agentbridge status --json`, trimmed to a few agents and conversations):

```json
{
  "schema": 1,
  "kind": "snapshot",
  "generated_at": "2026-11-24T14:32:10.000Z",
  "bridge": {
    "running": true,
    "version": "0.2.9",
    "pid": 4182,
    "started_at": "2026-11-24T13:32:10.000Z",
    "cli_version": "0.2.9",
    "version_mismatch": null,
    "complete": true,
    "policy": {
      "ok": true,
      "version": 7,
      "mode": "per_conversation"
    },
    "relay": {
      "state": "connected",
      "mode": "on_demand"
    }
  },
  "warnings": [
    {
      "code": "auto_mode",
      "agents": [
        "claude:video-notes"
      ],
      "text": "Claude Code may not ask before shell commands in these sessions"
    }
  ],
  "needs_you": [
    {
      "type": "approval",
      "approval_id": "01JAPPROVAL",
      "kind": "accept",
      "from": "grok:researcher",
      "to": "codex:trading-bot",
      "topic": "funding-rate summary",
      "turn_limit": 10,
      "expires_at": "2026-11-24T14:41:10.000Z",
      "conversation_id": "01JCONVPENDING",
      "answer_in": "codex:trading-bot",
      "answer_with": "prompt"
    },
    {
      "type": "held_messages",
      "agent": "claude:landing",
      "hold": "unknown_mode",
      "count": 2,
      "text": "2 messages held until someone types in it (waiting for first prompt)"
    }
  ],
  "agents": [
    {
      "address": "claude:agentbridge",
      "app": "claude",
      "name": "agentbridge",
      "short_id": "a1b2c3",
      "title": "status --watch",
      "mode": "default",
      "state": "live",
      "activity": "live",
      "folder": "agentbridge",
      "project": {
        "key": "p_cc29a77f2c3b0f8b",
        "label": "agentbridge"
      }
    },
    {
      "address": "claude:old-docs",
      "app": "claude",
      "name": "old-docs",
      "short_id": "c0c0c0",
      "title": null,
      "mode": null,
      "state": "closed",
      "activity": "closed",
      "folder": "old-docs",
      "project": {
        "key": "p_cd660e17800ea364",
        "label": "old-docs"
      }
    },
    {
      "address": "grok:researcher",
      "app": "grok",
      "name": "researcher",
      "short_id": "g00001",
      "title": null,
      "mode": null,
      "state": "live",
      "activity": "in_conversation",
      "folder": null,
      "project": null
    }
  ],
  "closed_agents": 2,
  "conversations": [
    {
      "id": "01JCONVACTIVE",
      "from": "claude:video-notes",
      "to": "grok:researcher",
      "topic": "b-roll ideas for this week",
      "state": "active",
      "end_reason": null,
      "turns": {
        "used": 6,
        "limit": 30
      },
      "origin": "local",
      "queued": false,
      "started_at": "2026-11-24T14:07:10.000Z",
      "ended_at": null,
      "last_activity_at": "2026-11-24T14:30:10.000Z",
      "approvals": [
        {
          "kind": "start",
          "via": "prompt",
          "agent": "claude:video-notes",
          "at": "2026-11-24T14:07:20.000Z"
        },
        {
          "kind": "accept",
          "via": "bot",
          "agent": "grok:researcher",
          "at": "2026-11-24T14:07:20.000Z"
        }
      ]
    },
    {
      "id": "01JCONVENDED",
      "from": "claude:agentbridge",
      "to": "claude:old-docs",
      "topic": "changelog wording",
      "state": "ended",
      "end_reason": "ended_by_participant",
      "turns": {
        "used": 4,
        "limit": 10
      },
      "origin": "local",
      "queued": false,
      "started_at": "2026-11-24T13:42:10.000Z",
      "ended_at": "2026-11-24T13:52:10.000Z",
      "last_activity_at": "2026-11-24T13:52:10.000Z",
      "approvals": [
        {
          "kind": "start",
          "via": "prompt",
          "agent": "claude:agentbridge",
          "at": "2026-11-24T13:42:20.000Z"
        },
        {
          "kind": "accept",
          "via": "cli",
          "agent": "claude:old-docs",
          "at": "2026-11-24T13:43:50.000Z"
        }
      ]
    }
  ],
  "notices": [
    {
      "at": "2026-11-24T14:27:10.000Z",
      "title": "agentbridge: message waiting",
      "body": "claude:landing has a message; type anything in it to receive it"
    }
  ]
}
```

A stream (`agentbridge status --watch --json`), shortened:

```text
{"schema":1,"kind":"snapshot","generated_at":"2026-11-24T14:32:10.000Z","bridge":{"running":true,…},…}
{"schema":1,"kind":"snapshot","generated_at":"2026-11-24T14:32:17.500Z","bridge":{"running":true,…},…}
{"schema":1,"kind":"heartbeat","generated_at":"2026-11-24T14:32:33.000Z"}
{"schema":1,"kind":"snapshot","generated_at":"2026-11-24T14:32:40.500Z","bridge":{"running":false,"error":"agentbridge is not running (start it with: agentbridge start)","cli_version":"0.2.9"},"warnings":[],"needs_you":[],"agents":[],"closed_agents":0,"conversations":[],"notices":[]}
```

Reading it from a script:

```bash
agentbridge status --watch --json | while read -r line; do echo "$line" | jq -c '{kind, waiting: (.needs_you // [] | length)}'; done
```
