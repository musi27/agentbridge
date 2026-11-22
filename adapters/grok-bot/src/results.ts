// Webhook response → delivery outcome, exactly as measured in M0 V9 (§12.4 "Results").
// Retries for network errors and 5xx are the bridge pipeline's job (2 s / 10 s / 30 s, same item): this module only
// says whether an outcome is retryable. Every failure reason is grok_run_not_started.
import type { DeliverOutcome } from '@agentbridge/protocol';

export const HINTS = {
  paused: 'routine paused — resume it in Grok Bot',
  deleted: 'routine deleted or webhook key changed — run `agentbridge add grok` again',
  network: 'could not reach the Grok webhook (network error)',
  server: 'the Grok webhook had a server error',
  notConfigured: 'webhook URL or key missing — run `agentbridge add grok` again',
  unknownBot: 'this Grok bot is not set up — run `agentbridge add grok`',
} as const;

export type WebhookResult =
  | { kind: 'response'; status: number; body: string }
  | { kind: 'network'; error: string };

export interface Mapped { outcome: DeliverOutcome; log?: string }

const failed = (hint: string, retryable: boolean): DeliverOutcome => ({ status: 'failed', reason: 'grok_run_not_started', hint, retryable });
const clip = (s: string, n = 500): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

export function mapWebhookResult(r: WebhookResult): Mapped {
  if (r.kind === 'network') return { outcome: failed(HINTS.network, true), log: `network error: ${clip(r.error, 200)}` };
  const { status, body } = r;
  if (status === 200) {
    let j: unknown = null;
    try { j = JSON.parse(body); } catch { /* not JSON */ }
    const o = (j && typeof j === 'object' ? j : {}) as { success?: unknown; runUuid?: unknown };
    if (o.success === true) return { outcome: { status: 'handed_off', ...(typeof o.runUuid === 'string' ? { run_uuid: o.runUuid } : {}) } };
    return { outcome: failed('the Grok webhook answered 200 without starting a run', false), log: `webhook 200 without success: ${clip(body)}` };
  }
  if (status >= 500) return { outcome: failed(HINTS.server, true), log: `webhook ${status}: ${clip(body)}` };
  if (status === 400 && /is disabled/i.test(body)) return { outcome: failed(HINTS.paused, false), log: `webhook 400 (paused): ${clip(body)}` };
  if (status === 401) return { outcome: failed(HINTS.deleted, false), log: `webhook 401: ${clip(body)}` };
  return { outcome: failed(`the Grok webhook answered HTTP ${status}`, false), log: `webhook ${status}: ${clip(body)}` };
}
