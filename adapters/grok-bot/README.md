# @agentbridge/adapter-grok

The Grok Bot adapter (SPEC §12): one webhook POST to the bot's "Inbox from agentbridge" routine per bridge
delivery. It implements the protocol `Adapter` interface and never touches storage or policy.

## What it does

- **Thin delivery (§12.4).** `packItem(item)` turns a bridge `OutboundItem` into the `packDelivery` input; the payload is
  always ≤ 3,500 characters (UTF-16 and UTF-8) and ends with `"end": "agentbridge-delivery-end"`. Notices use their
  plain `text`. Deterministic: a retry sends the same JSON.
- **Auth.** `POST <webhook_url>` with `Authorization: Bearer <webhook_key>`; both come from the `SecretStore`
  (`SECRET_NAMES.webhookUrl(botId)` / `webhookKey(botId)`). `botIdFor(ref)` maps the participant to its `bot_id`.
- **Results (M0 V9).** `mapWebhookResult`:

  | Webhook answer | Outcome |
  |---|---|
  | 200 `{success:true, runUuid}` | `handed_off` with `run_uuid` |
  | network error, 5xx | `failed(grok_run_not_started)`, `retryable: true` |
  | 400 "… is disabled" | `failed`, hint "routine paused — resume it in Grok Bot" |
  | 401 | `failed`, hint "routine deleted or webhook key changed — run `agentbridge add grok` again" |
  | anything else | `failed`, status and body in the log |

  The 2 s / 10 s / 30 s retries with the same item are done by the bridge pipeline (`RETRY_BACKOFF_MS`), which keeps the
  delivery durable across them; the adapter makes one attempt per call.
- **Cap backstop.** At most `LIMITS.grokDeliveriesPerHour` hand-offs per bot per hour in this adapter instance; above
  it the answer is `queued` / `rate_limited` and the bridge holds the delivery (hold `cap`, rechecked), never drops it.
  The bridge's own gate (counted in the DB) is the primary check.
- **Activity.** `onActivity(botId)` runs before every POST so the on-demand relay connection is up when the run calls
  back (§13.2).
- **`capabilities()`** = `{ receive: 'webhook', native_confirm: false, delivery_confirmable: false }`.
- **`doctor()`** per bot: token / webhook URL / key present, URL shape (https, no credentials), and a `HEAD` to the
  webhook host (never `POST`, which would start a run). The full round trip lives in the bridge (`agentbridge doctor grok:<name>`).
- **Ids.** `mintBotId()` (16 base32 chars, `zBotId`), `mintBotToken()` (256-bit, base64url), `botTokenHash()` (hex
  sha256, the relay's `token_hash`; same definition as `botTokenHash` on the relay branch).

Message bodies never reach the log.

## Test

```bash
node --conditions=agentbridge-source --test adapters/grok-bot/test/*.test.ts
```
