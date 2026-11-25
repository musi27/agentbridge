// Versioned, transactional migrations (§15.4). Append only: never edit a released migration.
// All timestamps are integer milliseconds since the epoch. Approvals are never stored (§7.3).

export interface Migration { version: number; name: string; sql: string }

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE participants (
  id              TEXT PRIMARY KEY,
  agent           TEXT NOT NULL,
  name            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  cwd             TEXT,
  claude_pid      INTEGER,
  session_id      TEXT,
  transcript_path TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'unknown',
  inbound         TEXT NOT NULL DEFAULT 'accept',
  state           TEXT NOT NULL DEFAULT 'closed',
  epoch           INTEGER NOT NULL DEFAULT 0,
  bot_id          TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX participants_address ON participants(agent, name);
CREATE INDEX participants_pid ON participants(claude_pid);

CREATE TABLE sessions (
  session_id      TEXT PRIMARY KEY,
  participant_id  TEXT NOT NULL REFERENCES participants(id),
  claude_pid      INTEGER,
  source          TEXT,
  transcript_path TEXT,
  cwd             TEXT,
  linked_from     TEXT,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);
CREATE INDEX sessions_participant ON sessions(participant_id);

CREATE TABLE bots (
  bot_id          TEXT PRIMARY KEY,
  participant_id  TEXT NOT NULL UNIQUE REFERENCES participants(id),
  token_hash      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);

CREATE TABLE conversations (
  id               TEXT PRIMARY KEY,
  initiator_id     TEXT NOT NULL REFERENCES participants(id),
  invitee_id       TEXT NOT NULL REFERENCES participants(id),
  topic            TEXT NOT NULL,
  state            TEXT NOT NULL,
  end_reason       TEXT,
  turn_count       INTEGER NOT NULL DEFAULT 0,
  turn_limit       INTEGER NOT NULL,
  effective_mode   TEXT NOT NULL,
  origin           TEXT NOT NULL,
  continues        TEXT,
  first_message_id TEXT,
  invite_issued_at INTEGER,
  waiting_on       TEXT,
  waiting_since    INTEGER,
  waiting_notified INTEGER NOT NULL DEFAULT 0,
  grok_hint_sent   INTEGER NOT NULL DEFAULT 0,
  queued           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  ended_at         INTEGER
);
CREATE INDEX conversations_initiator ON conversations(initiator_id, state);
CREATE INDEX conversations_invitee ON conversations(invitee_id, state);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq             INTEGER NOT NULL,
  turn            INTEGER,
  from_id         TEXT NOT NULL,
  to_id           TEXT NOT NULL,
  kind            TEXT NOT NULL,
  body            TEXT NOT NULL,
  in_reply_to     TEXT,
  reply_expected  INTEGER NOT NULL DEFAULT 0,
  notice_code     TEXT,
  notice_severity TEXT,
  status          TEXT NOT NULL,
  reason          TEXT,
  replied_by      TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE TABLE deliveries (
  id              TEXT PRIMARY KEY,
  participant_id  TEXT NOT NULL REFERENCES participants(id),
  conversation_id TEXT,
  item            TEXT NOT NULL,
  message_ids     TEXT NOT NULL DEFAULT '[]',
  state           TEXT NOT NULL,
  hold            TEXT,
  reason          TEXT,
  hint            TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  run_uuid        TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE INDEX deliveries_pending ON deliveries(participant_id, state, created_at);

CREATE TABLE idempotency (
  caller     TEXT NOT NULL,
  epoch      INTEGER NOT NULL,
  key        TEXT NOT NULL,
  method     TEXT NOT NULL,
  result     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (caller, epoch, key)
);

CREATE TABLE policy (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  level           TEXT NOT NULL,
  type            TEXT NOT NULL,
  participant_id  TEXT,
  conversation_id TEXT,
  data            TEXT NOT NULL DEFAULT '{}',
  popup           INTEGER NOT NULL DEFAULT 0,
  shown           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX events_type ON events(type, ts);
`,
  },
  {
    version: 2,
    name: 'bridge state key-value (relay cursor, connected-time usage)',
    sql: `
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
  {
    version: 3,
    name: "participant title (Claude Code's session title, shown beside the address)",
    sql: `
ALTER TABLE participants ADD COLUMN title TEXT;
`,
  },
  {
    version: 4,
    name: 'participant project root (git repository root of its folder) and conversation events index (agent panel)',
    sql: `
ALTER TABLE participants ADD COLUMN project_root TEXT;
CREATE INDEX events_conversation ON events(conversation_id, type);
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;
