// Numeric limits from SPEC v0.4. Change them here only.
export const LIMITS = {
  topicChars: 120,
  nameChars: 64,
  bodyBytes: 32 * 1024,
  turnLimitDefault: 30,
  turnLimitMax: 200,
  turnWarningAt: 2, // "2 turns left" header when turns_left <= this
  ipcFrameBytes: 256 * 1024,
  approvalTimeoutMs: 10 * 60 * 1000,
  inactivityNoticeMs: 60 * 60 * 1000,
  grokNoReplyHintMs: 25 * 60 * 1000,
  queueExpiryMs: 7 * 24 * 60 * 60 * 1000,
  grokDeliveryChars: 3500, // run sees ~4,000 chars (M0 V9)
  grokPreviewChars: 300,
  grokNoticeChars: 300,
  grokDeliveriesPerHour: 60,
  grokRoundTripMs: 90_000, // setup round-trip check waits this long for the run's bridge_send (§12.5)
  relayResultBytes: 64 * 1024, // bridge keeps each Grok tool result (relay `res`) under this; reads page beyond it (§12.3)
  grokSerializeAfterMs: 5 * 60 * 1000,
  unknownModePopupMs: 30 * 1000, // popup when a delivery waits this long on a session that hasn't reported its mode
  titleRefreshMs: 15 * 1000,
  codexContextWaitMs: 3000, // Codex SessionStart hook waits this long for the MCP server to register (§11a) // re-read a session's Claude Code title at most this often
  invitesPendingPerRemote: 3,
  invitesPendingPerTarget: 10,
  inviteCooldownMs: 10 * 60 * 1000,
  relayResponseWaitMs: 20_000,
  relayReconnectAtMs: 270_000,
  relayOverlapMs: 30_000,
  relayPollMs: 60_000, // relay re-reads the stream this often in case a wake was lost (§13.4; 10 s in v0.3)
  relayHeartbeatMs: 15_000, // relay pings (ws) and sends a `wake` frame this often; 2 missed pongs = dead; client treats 3x silence as dead
  relayHandshakeTimeoutMs: 15_000, // client gives up on a connection not `ready` within this
  relayPendingPollMs: 60_000, // on-demand idle check interval (§13.2), jittered by the client
  relayPendingPerMinute: 10, // per-user rate limit on POST /v1/pending
  relayActiveWindowMs: 10 * 60 * 1000, // stay connected this long after the last Grok activity (§13.2)
  relayMaxConnectedHoursPerDay: 6, // default transport.max_connected_hours_per_day (§13.2)
  relayEnsureGraceMs: 15_000, // a CLI-driven connection stays this long after its last control call
  relayRequestBytes: 80 * 1024, // MCP transport cap: 2 x bodyBytes (JSON escaping) + envelope; the 32 KB body check after parsing is the real limit (§13.5)
  relayResponseBytes: 1024 * 1024, // largest bridge `res` frame; bigger results are refused by the client with a short error
  relayUserRpm: 120,
  relayHeldEntries: 1000,
  relayHeldBytes: 5 * 1024 * 1024,
  relayIdentityPerIpPerDay: 5,
  relayBotsPerUser: 32,
  inboxPostSpacingMs: 200,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  grokDedupWindowMs: 120_000,
  minClaudeCodeVersion: '2.1.330',
  standingInstructionChars: 4000,
} as const;
