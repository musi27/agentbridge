// Grok Bot adapter (§12): one webhook POST per bridge delivery. The bridge decides what to send and when
// (serialization, hourly cap, retries — §6.5, §12.4); the adapter packs, authenticates, posts and maps the answer.
// It never touches storage or policy (§11.1). Message bodies never reach the log.
import { LIMITS, SECRET_NAMES, type Adapter, type AdapterCapabilities, type AgentType, type DeliverOutcome, type DoctorCheck, type OutboundItem, type ParticipantRef, type SecretStore } from '@agentbridge/protocol';
import { packItem } from './packing.ts';
import { HINTS, mapWebhookResult, type WebhookResult } from './results.ts';

export const GROK_ADAPTER_VERSION = '0.1.0';
const HOUR = 3600_000;

export interface GrokBotInfo { bot_id: string; address: string }

export interface GrokAdapterOptions {
  secrets: SecretStore;
  /** participant → bot_id (the bridge store knows the mapping). */
  botIdFor(ref: ParticipantRef): string | null | Promise<string | null>;
  /** Bots to check in `doctor()`. */
  listBots?(): GrokBotInfo[] | Promise<GrokBotInfo[]>;
  /** Called before every webhook POST, so the on-demand relay connection is up when the run calls back (§13.2). */
  onActivity?(botId: string): void;
  fetch?: typeof fetch;
  now?: () => number;
  /** Per POST (default 10 s). The webhook answers as soon as the run is queued (M0 V9). */
  timeoutMs?: number;
  /** Backstop for the per-bot cap (default LIMITS.grokDeliveriesPerHour). The bridge gate is the primary check. */
  perHourCap?: number;
  /** doctor(): probe the webhook host with a HEAD request (never POST, which would start a run). Default true. */
  probeReachability?: boolean;
  log?(line: string): void;
}

export class GrokAdapter implements Adapter {
  private readonly o: GrokAdapterOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sent = new Map<string, number[]>(); // bot_id → hand-off times within the last hour

  constructor(o: GrokAdapterOptions) {
    this.o = o; this.fetchImpl = o.fetch ?? globalThis.fetch; this.now = o.now ?? Date.now;
  }

  describe(): { name: string; version: string; agent: AgentType } { return { name: 'grok-bot', version: GROK_ADAPTER_VERSION, agent: 'grok' }; }
  capabilities(): AdapterCapabilities { return { receive: 'webhook', native_confirm: false, delivery_confirmable: false }; }

  /** Hand-offs to this bot in the last hour (as seen by this adapter instance). */
  sentLastHour(botId: string): number { return this.window(botId).length; }

  private window(botId: string): number[] {
    const cutoff = this.now() - HOUR;
    const w = (this.sent.get(botId) ?? []).filter((t) => t > cutoff);
    this.sent.set(botId, w);
    return w;
  }

  private log(line: string): void { try { this.o.log?.(`grok-adapter ${line}`); } catch { /* logging must not fail a delivery */ } }

  async deliver(item: OutboundItem, to: ParticipantRef): Promise<DeliverOutcome> {
    const botId = await this.o.botIdFor(to);
    if (!botId) return { status: 'failed', reason: 'grok_run_not_started', hint: HINTS.unknownBot, retryable: false };
    const cap = this.o.perHourCap ?? LIMITS.grokDeliveriesPerHour;
    if (this.window(botId).length >= cap) {
      // never dropped: the bridge holds it (hold 'cap') and rechecks later (§6.5)
      return { status: 'queued', reason: 'rate_limited', hint: `hourly delivery cap (${cap}) for ${to.address} reached; held` };
    }
    const [url, key] = await Promise.all([this.o.secrets.get(SECRET_NAMES.webhookUrl(botId)), this.o.secrets.get(SECRET_NAMES.webhookKey(botId))]);
    if (!url || !key) return { status: 'failed', reason: 'grok_run_not_started', hint: HINTS.notConfigured, retryable: false };
    const json = packItem(item).json; // never fails on size (keeps the newest stubs, truncated: true)
    try { this.o.onActivity?.(botId); } catch { /* activity hint only */ }
    const res = await this.post(url, key, json);
    const m = mapWebhookResult(res);
    if (m.log) this.log(`bot=${botId} item=${item.item_id} ${m.log}`);
    if (m.outcome.status === 'handed_off') {
      this.window(botId).push(this.now());
      this.log(`bot=${botId} item=${item.item_id} handed_off run=${m.outcome.run_uuid ?? '?'} bytes=${Buffer.byteLength(json, 'utf8')}`);
    }
    return m.outcome;
  }

  private async post(url: string, key: string, json: string): Promise<WebhookResult> {
    try {
      const r = await this.fetchImpl(url, {
        method: 'POST', body: json, redirect: 'error',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
      let body = '';
      try { body = await r.text(); } catch { /* empty */ }
      return { kind: 'response', status: r.status, body };
    } catch (e) {
      return { kind: 'network', error: (e as Error)?.message ?? String(e) };
    }
  }

  async doctor(): Promise<DoctorCheck[]> {
    const bots = (await this.o.listBots?.()) ?? [];
    if (bots.length === 0) return [{ id: 'grok', ok: true, detail: 'no Grok bots set up (agentbridge add grok)' }];
    const out: DoctorCheck[] = [];
    for (const b of bots) out.push(...(await this.checkBot(b)));
    return out;
  }

  /** Secrets present, webhook URL shape, and (optionally) that the webhook host answers HTTP. */
  async checkBot(b: GrokBotInfo): Promise<DoctorCheck[]> {
    const fix = `agentbridge add grok (or agentbridge revoke ${b.address} for a new token)`;
    const [token, url, key] = await Promise.all([
      this.o.secrets.get(SECRET_NAMES.botToken(b.bot_id)), this.o.secrets.get(SECRET_NAMES.webhookUrl(b.bot_id)), this.o.secrets.get(SECRET_NAMES.webhookKey(b.bot_id)),
    ]);
    const missing = [!token && 'bot token', !url && 'webhook URL', !key && 'webhook key'].filter(Boolean) as string[];
    const checks: DoctorCheck[] = [missing.length
      ? { id: `${b.address}:secrets`, ok: false, detail: `missing in the keychain: ${missing.join(', ')}`, fix }
      : { id: `${b.address}:secrets`, ok: true, detail: 'bot token, webhook URL and key are in the keychain' }];
    if (!url) return checks;
    const shape = webhookUrlProblem(url);
    checks.push(shape ? { id: `${b.address}:webhook_url`, ok: false, detail: shape, fix } : { id: `${b.address}:webhook_url`, ok: true, detail: `webhook host ${new URL(url).host}` });
    if (shape || this.o.probeReachability === false) return checks;
    try {
      const r = await this.fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) });
      checks.push({ id: `${b.address}:webhook_reachable`, ok: true, detail: `webhook host answers (HTTP ${r.status} to HEAD; deliveries use POST)` });
    } catch (e) {
      checks.push({ id: `${b.address}:webhook_reachable`, ok: false, detail: `webhook host not reachable: ${(e as Error)?.message ?? e}`, fix: 'check your network; then agentbridge doctor again' });
    }
    return checks;
  }
}

/** Why a pasted webhook URL is unusable, or null. */
export function webhookUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return 'the webhook URL is not a valid URL'; }
  if (u.protocol !== 'https:') return 'the webhook URL must start with https://';
  if (u.username || u.password) return 'the webhook URL must not contain credentials';
  if (!u.hostname.includes('.')) return 'the webhook URL has no public host name';
  return null;
}
