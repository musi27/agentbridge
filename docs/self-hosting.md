# Self-hosting the relay

The relay lets Grok, which runs in the cloud, reach the bridge on your Mac. The public relay runs at
`relay.musi.live`. You can run your own on your own Vercel and Upstash accounts instead. This follows
[SPEC.md §13](../SPEC.md#13-relay).

Why self-host:

- **Trust.** The relay sees Grok → bridge content in plaintext as it arrives ([security.md](security.md#relay-trust)).
  On your own relay, you are the operator.
- **Auto mode for Grok-started conversations.** Only on a self-hosted relay can `auto` mode skip local approval for
  conversations Grok starts, and only after you opt in with `auto.allow_relay_origin = true`.
- **Independence** from the public relay's free-tier limits.

## What you need

- A Vercel account and the Vercel CLI (`npm install -g vercel`).
- An Upstash Redis database (directly, or through the Vercel Marketplace).
- A clone of this repository with dependencies installed (`npm ci`), Node 24 or later.

## 1. Create the Redis database

Create an Upstash Redis database and **note its region**, for example Frankfurt (`eu-central-1`). Copy its TCP
connection URL (`rediss://…`). The relay uses Redis over TCP with `ioredis`, not the REST API.

## 2. Build the deployable project

```bash
npm run build:vercel -w @agentbridge/relay
```

This writes a self-contained Vercel project to `packages/relay/.vercel-build/`: one bundled function and a generated
`vercel.json` with:

- `regions: ["fra1"]`
- `memory: 512` (MB)
- `maxDuration: 300` (seconds)
- every path rewritten to the single function

**Pin the function region to your Redis region.** In testing, functions in the default `iad1` region talking to Redis in
Frankfurt took 6–7 times as long per request (p50 845 ms against 128 ms when pinned to `fra1`). If your Redis is not in
Frankfurt, change `regions` in `.vercel-build/vercel.json` to the matching Vercel region before deploying. **Every
`build:vercel` run regenerates `vercel.json` and wipes that edit**, so redo it after each build (the `.vercel` project
link in the folder is kept).

Keep `memory: 512`. A larger instance costs more provisioned memory for no benefit.

## 3. Link the project and set environment variables

Link the build folder to a Vercel project once (the link survives rebuilds):

```bash
cd packages/relay/.vercel-build
```

```bash
vercel link
```

In production (`VERCEL=1`, which Vercel sets, or `NODE_ENV=production`) the relay **refuses to start** unless all three
required variables are set:

| Variable | Required | Value |
|---|---|---|
| `REDIS_URL` | yes | The Upstash TCP URL (`rediss://default:…@….upstash.io:6379`). `KV_URL` is accepted instead. |
| `RELAY_HOST` | yes | The host name your bridge will use, for example `relay.example.com`. The bridge signs it into every authentication, so it must match the host in `transport.relay_url` exactly. |
| `RELAY_KEY_PREFIX` | yes | A non-empty prefix for every Redis key, for example `relay:`. Lets several deployments share one database. |
| `RELAY_QUEUE_EXPIRY_MS` | no | How long held messages are kept, in milliseconds. Default 7 days, capped at 7 days. |

The in-memory store used when no Redis URL is set is for local development only (`npm run dev -w @agentbridge/relay`).

Set each variable for Production, for example:

```bash
vercel env add REDIS_URL production
```

Repeat for `RELAY_HOST` and `RELAY_KEY_PREFIX`.

## 4. Deploy

From `packages/relay/.vercel-build`:

```bash
vercel deploy --prod
```

Add your domain to the project if you want one (it must match `RELAY_HOST`). Check the deployment:

```bash
curl https://relay.example.com/v1/health
```

The repository also has a smoke test that exercises identity creation, the WebSocket connection and a connector call:

```bash
node --conditions=agentbridge-source packages/relay/scripts/smoke.ts https://relay.example.com
```

The relay accepts WebSocket connections on Vercel Functions, which Vercel closes at the function's maximum duration
(300 s on Hobby). The bridge reconnects before that, opening the new connection before closing the old one, so
nothing is lost.

## 5. Point your bridge at it

```bash
agentbridge init --relay https://relay.example.com
```

`init` registers your bridge's identity with the new relay, saves the URL as `transport.relay_url`, and reports that
the relay is treated as self-hosted because its host is not `relay.musi.live`. It only rewrites what changed. (Setting
`transport.relay_url` with `agentbridge config set` changes the URL but doesn't register the identity, so prefer
`init`.)

SPEC §13.6 also has you confirm, with user presence, that you operate a self-hosted relay. That step isn't implemented
yet.

Then reconnect each Grok bot: the connector URL contains the relay host, so run the setup again for each bot
([setup-grok.md](setup-grok.md)):

```bash
agentbridge add grok
```

Check the relay and each bot with:

```bash
agentbridge doctor
```

```bash
agentbridge doctor grok:<name>
```

Optional settings for a relay you control:

- `agentbridge config set transport.relay_mode always` keeps the bridge connected permanently instead of on demand
  (`on_demand` is the default). Read the cost warning below first.
- `agentbridge config set transport.max_connected_hours_per_day <n>` changes the daily cap on connected time in
  on-demand mode (default 6).
- `agentbridge config set auto.allow_relay_origin true` lets `auto` mode skip approval for Grok-started conversations
  that match your allowlist. Only honoured on a self-hosted relay.

Each `config set` needs user presence.

## Vercel Hobby can pause your whole team

On Vercel's free Hobby plan, **exceeding the included usage pauses every project in the team**, with
`503 DEPLOYMENT_PAUSED`, for about 30 days. That includes projects unrelated to agentbridge.

- **On-demand mode (the default) stays well inside Hobby.** The bridge connects only during active Grok conversations
  (plus 10 minutes), checks for waiting messages once a minute otherwise, and caps connected time at 6 hours a day.
  Idle checks cost seconds of function time and about 86,000 Redis commands per bridge per month; Upstash's free tier
  is 500,000 commands a month.
- **`transport.relay_mode = always` does not fit on Hobby.** One permanently connected bridge keeps an instance alive
  around the clock: about 365 GB-hours a month at 512 MB, above Hobby's 360. Use a Vercel Pro team (modelled in testing at
  about $20–35 a month for up to roughly 100 always-connected bridges), or keep on-demand mode.
- **Put the relay in its own Vercel team** if your Hobby team hosts anything else, so a pause can't take it down.

Check current limits on Vercel's and Upstash's pricing pages; the figures above were measured, modelled or quoted in
November 2026.

## Updating

Rebuild and redeploy the same way. Connections already open stay on the old deployment while new requests reach the new
one; both work through Redis, so redeploys don't drop messages (testing measured 60 of 60 requests answered across a
redeploy).
