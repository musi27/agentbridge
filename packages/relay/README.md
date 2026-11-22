# @agentbridge/relay

The relay between a user's Grok Bot (MCP connector, in the cloud) and their local bridge (WebSocket), per SPEC v0.4 §13.
Also exports the bridge-side client at `@agentbridge/relay/client`.

## Routes

| Route | What |
|---|---|
| `GET /v1/connect` (WebSocket) | Bridge connection: `challenge` → `auth` (Ed25519 over `relayAuthMessage`) → `ready`; then `req`/`res`/`ack`/`ctl`/`ctl_res`/`expiry` frames (`zRelayFrame`). |
| `POST /v1/u/<user>/b/<bot>/mcp` | Grok's connector: stateless Streamable HTTP, JSON responses, `Authorization: Bearer <bot token>`. `GET` → 405. |
| `POST /v1/pending` | On-demand idle check: headers `x-agentbridge-user-id`, `x-agentbridge-ts`, `x-agentbridge-sig` (Ed25519 over `relayPendingMessage(host, ts)`, ts ±60 s). Answers `{ pending, oldest_ms }`; 10/min per user; 3 Redis commands with a warm key cache. |
| `POST /v1/identity` | Create an identity: `{ ed25519_pub, x25519_pub, sig }` (`zRelayIdentityRequest`). |
| `GET /v1/health` | Liveness. |

## Storage (Redis)

All keys carry `RELAY_KEY_PREFIX`. `user:<id>` identity record; `user:<id>:bot:<bot>` token hash + discovery;
`user:<id>:inbox` stream of sealed calls (fields `v r m c d s n`: format, req id, method, conversation id, deadline,
sealed box, size); `user:<id>:expired` expiry records; `user:<id>:conn` newest connection (presence `"<auth ms>|<conn id>"`, 3 polls);
`res:<id>:<req_id>` response (30 s); `nonce:*`, `rl:*`, `ipc:*` (hashed IP) for the handshake and limits.

Call content and bot tokens exist in plaintext only while a request is handled; the stream holds libsodium sealed boxes
to the user's X25519 key. Method name and conversation id stay in clear so age trims can produce expiry records.

Each relay instance holds **one** pattern subscription (`<prefix>user:*:wake`) shared by all its sockets, and re-reads
the stream every 60 s in case a wake was lost (§13.4).

## Client

```ts
import { RelayClient } from '@agentbridge/relay/client';
const c = new RelayClient({
  url: 'https://relay.musi.live', userId, mode: 'on_demand', signer /* { publicKey, sign(msg) } */, x25519 /* { publicKey, privateKey } */,
  onCall: async ({ call, held }) => { /* store durably, verify call.token */ return { result: { status: 'queued' } }; },
  loadCursor, saveCursor, onExpiry,
});
await c.start();
await c.control('register_bot', { bot_id, token_hash: botTokenHash(token), discovery: 'names' });
```

Liveness: the relay pings every 15 s (two missed pongs = terminated) and sends a `wake` frame; the client drops a
connection that is silent for 45 s or not `ready` within 15 s. `req.deadline_in_ms` is relative, so clock skew is
harmless. Results over 1 MB are refused by the client with a short `too_large` error.

**Connection policy (§13.2).** `mode: 'on_demand'` (default) keeps no socket open while idle: it calls
`/v1/pending` every 60 s (jittered) and connects when entries wait. Call `client.markActive()` on Grok activity (a
delivery to Grok, an awaited reply; calls from Grok count automatically): it connects and stays connected for 10 min.
`control()` connects just for the call (`ensureConnected()`, plus a 15 s grace), regardless of the cap. Connected time is
capped per local day (`maxConnectedMsPerDay`, default 6 h; persist `client.connectedToday` and pass it back as `usage`);
beyond it the client stays idle and emits `cap_reached` (show a popup). `mode: 'always'` holds the connection
permanently (self-hosted or paid relays).

`onCall` resolving = stored: the client then acks in stream order (the relay deletes acked entries). Throwing keeps the
entry for redelivery after reconnect. `result` is any JSON; the relay shows it to Grok as text content. `error`
`{ code, message }` becomes a tool error `{ status: 'failed', reason, message }` (message reaches the model verbatim).

## Run and deploy

```bash
npm run dev -w @agentbridge/relay                 # local, in-memory store, port 8787
npm run build:vercel -w @agentbridge/relay        # -> packages/relay/.vercel-build (deploy that folder)
npm run smoke -w @agentbridge/relay -- https://<your-relay-host>
```

In production (`VERCEL=1` or `NODE_ENV=production`) the relay refuses to start without `REDIS_URL`, `RELAY_HOST` and
`RELAY_KEY_PREFIX`. Vercel env: `REDIS_URL` (Upstash, TCP), `RELAY_KEY_PREFIX`, `RELAY_HOST` (host the bridge signs), optional
`RELAY_QUEUE_EXPIRY_MS`. `vercel.json` (generated): `regions: ["fra1"]`, `memory: 512`, `maxDuration: 300`, every path
rewritten to the single function.
