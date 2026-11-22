// Grok test helpers: a fake relay transport, relay-call builders, and a simulated Grok routine run that reacts to a
// webhook delivery the way Appendix B tells it to (read when truncated, reply once to reply_to).
import { ulid, type DeliveryPayload } from '@agentbridge/protocol';
import { botTokenHash } from '@agentbridge/adapter-grok';
import type { RelayCallOut, RelayLink, RelayTransport } from '../src/relay/link.ts';
import type { Engine } from '../src/core/engine.ts';

export class FakeTransport implements RelayTransport {
  readonly controls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly graces: Array<number | undefined> = [];
  active = 0; connects = 0;
  failWith: string | null = null;
  failCode = 'timeout';
  /** Runs inside control() before it answers (to observe state at that moment). */
  onControl: ((method: string) => void) | null = null;
  async control(method: string, params: unknown): Promise<unknown> {
    this.controls.push({ method, params: params as Record<string, unknown> });
    this.onControl?.(method);
    if (this.failWith) throw Object.assign(new Error(this.failWith), { code: this.failCode });
    return { ok: true };
  }
  markActive(): void { this.active++; }
  async ensureConnected(graceMs?: number): Promise<void> { this.connects++; this.graces.push(graceMs); }
}

export const ENDPOINT = { origin: 'https://relay.musi.live', userId: 'abcdefghijklmnopqrstuvwxyz' };

/** A bot participant with a real token (hash in the DB, as `add grok` leaves it). */
export function addBot(engine: Engine, name: string, botId: string, token = `tok-${botId}`): { pid: string; botId: string; token: string; address: string } {
  const p = engine.createBot({ name, bot_id: botId, token_hash: botTokenHash(token) });
  return { pid: p.id, botId, token, address: `grok:${p.name}` };
}

export function relayCall(link: RelayLink, bot: { botId: string; token: string }, method: string, params: Record<string, unknown>, o: { held?: boolean; token?: string; caller?: string } = {}): Promise<RelayCallOut | null> {
  return link.handleCall({ reqId: ulid(), entryId: '1-0', call: { method, params, caller: o.caller ?? bot.botId, token: o.token ?? bot.token, received_at: Date.now() }, deadlineMs: Date.now() + 20_000, held: o.held ?? false });
}

export const result = <T = Record<string, unknown>>(r: RelayCallOut | null): T => {
  if (!r || !('result' in r)) throw new Error(`expected a result, got ${JSON.stringify(r)}`);
  return r.result as T;
};
export const errorOf = (r: RelayCallOut | null): { code: string; message: string } => {
  if (!r || !('error' in r)) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
  return r.error;
};

/** What a routine run does with one delivery (Appendix B): get_messages if truncated (or asked), then one reply. */
export async function simulateRun(link: RelayLink, bot: { botId: string; token: string }, payload: DeliveryPayload, o: { reply?: (p: DeliveryPayload, full: Array<{ body: string }>) => string; alwaysRead?: boolean } = {}): Promise<{ calls: string[]; send?: RelayCallOut | null }> {
  const calls: string[] = [];
  let full: Array<{ body: string }> = payload.messages.map((m) => ({ body: m.body ?? '' }));
  if (payload.truncated || o.alwaysRead || payload.end !== 'agentbridge-delivery-end') {
    calls.push('bridge_get_messages');
    const r = result<{ data: { messages: Array<{ body: string }> } }>(await relayCall(link, bot, 'bridge_get_messages', { conversation_id: payload.conversation.id }));
    full = r.data.messages;
  }
  if (!payload.reply_to) return { calls };
  calls.push('bridge_send');
  const body = o.reply ? o.reply(payload, full) : `re: ${full.at(-1)?.body.slice(0, 40) ?? ''}`;
  const send = await relayCall(link, bot, 'bridge_send', { conversation_id: payload.conversation.id, body, in_reply_to: payload.reply_to });
  return { calls, send };
}
