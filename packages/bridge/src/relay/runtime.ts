// Relay client wiring for the service (§13.2–§13.4). Builds the bridge-side RelayClient (from @agentbridge/relay/client,
// loaded through a factory seam), persists its ack cursor and daily connected time in the DB, turns trimmed entries
// into notice-only Grok deliveries (§13.4) and raises a must-act popup when the daily connected-time cap is reached.
import type { Store } from '../db/store.ts';
import type { Engine } from '../core/engine.ts';
import * as N from '../core/notices.ts';
import type { Policy } from '../policy/policy.ts';
import { signerFor, type Identity, type Signer } from './identity.ts';

/** Mirrors `IncomingRelayCall` / `RelayCallResponse` / `ExpiryEntry` in @agentbridge/relay/client. */
export interface RelayCallInLike { reqId: string; entryId?: string; call: { method: string; params: Record<string, unknown>; caller: string; token: string; received_at: number }; deadlineMs?: number; held: boolean }
export type RelayCallOutLike = { result: unknown } | { error: { code: string; message: string } };
export interface ExpiryEntryLike { req_id: string; method: string; conversation_id?: string | undefined }

/** The options of @agentbridge/relay/client's RelayClient that the bridge sets. */
export interface RelayClientOptionsLike {
  url: string; userId: string; signer: Signer; x25519: { publicKey: Uint8Array; privateKey: Uint8Array };
  mode: 'on_demand' | 'always'; maxConnectedMsPerDay: number; usage?: { day: string; ms: number };
  onCall(call: RelayCallInLike): Promise<RelayCallOutLike | null>;
  loadCursor(): string | undefined; saveCursor(cursor: string): void; onExpiry(entries: ExpiryEntryLike[]): void | Promise<void>;
}
/** The parts of RelayClient the bridge uses (structural, so the bridge builds without the relay package). */
export interface RelayClientLike {
  start(): Promise<void>; stop(): Promise<void>;
  control(method: string, params: unknown): Promise<unknown>;
  markActive(): void; ensureConnected(graceMs?: number): Promise<void>;
  readonly connected: boolean; readonly connectedToday: { day: string; ms: number };
  on(event: string, fn: (...args: unknown[]) => void): unknown;
}
export type RelayClientFactory = (o: RelayClientOptionsLike) => RelayClientLike | Promise<RelayClientLike>;

/** Default factory: @agentbridge/relay/client (PR #3). Throws if the package is not installed. */
export const defaultRelayClientFactory: RelayClientFactory = async (o) => {
  // literal specifier so the release bundle (esbuild) includes the client
  const mod = (await import('@agentbridge/relay/client')) as unknown as { RelayClient: new (o: RelayClientOptionsLike) => RelayClientLike };
  return new mod.RelayClient(o);
};

export const KV = { cursor: 'relay.cursor', usage: 'relay.usage' } as const;

export interface RelayRuntimeOptions {
  engine: Engine; store: Store; policy: Policy; identity: Identity;
  /** Grok calls → engine (RelayLink.handleCall). */
  onCall(call: RelayCallInLike): Promise<RelayCallOutLike | null>;
  /** Called with the client before it starts (RelayLink.attach), so control calls and markActive work from the first call. */
  beforeStart?(client: RelayClientLike, endpoint: { origin: string; userId: string }): void;
  factory?: RelayClientFactory;
  /** Extra RelayClient options (tests: short pendingPollMs / activeWindowMs). */
  clientOptions?: Record<string, unknown>;
  /** Persist connected-time usage this often (default 60 s) and on stop. */
  usageSaveEveryMs?: number;
  log?(line: string): void;
}

export class RelayRuntime {
  readonly client: RelayClientLike;
  readonly endpoint: { origin: string; userId: string };
  private readonly store: Store; private readonly timer: NodeJS.Timeout;
  private constructor(client: RelayClientLike, endpoint: { origin: string; userId: string }, store: Store, saveEveryMs: number) {
    this.client = client; this.endpoint = endpoint; this.store = store;
    this.timer = setInterval(() => this.saveUsage(), saveEveryMs); this.timer.unref?.();
  }

  static async start(o: RelayRuntimeOptions): Promise<RelayRuntime> {
    const { store, engine, policy, identity } = o;
    const usageRaw = store.kvGet(KV.usage);
    let usage: { day: string; ms: number } | undefined;
    try { const u = usageRaw ? (JSON.parse(usageRaw) as { day?: unknown; ms?: unknown }) : null; if (u && typeof u.day === 'string' && typeof u.ms === 'number') usage = { day: u.day, ms: u.ms }; } catch { usage = undefined; }
    const client = await (o.factory ?? defaultRelayClientFactory)({
      url: policy.transport.relay_url, userId: identity.userId, signer: signerFor(identity),
      x25519: { publicKey: identity.x25519.publicKey, privateKey: identity.x25519.privateKey },
      mode: policy.transport.relay_mode, maxConnectedMsPerDay: policy.transport.max_connected_hours_per_day * 3600_000,
      ...(usage ? { usage } : {}),
      ...o.clientOptions,
      onCall: (c) => o.onCall(c),
      loadCursor: () => store.kvGet(KV.cursor),
      saveCursor: (cursor) => store.kvSet(KV.cursor, cursor),
      onExpiry: (entries) => handleExpiry(engine, entries),
    });
    client.on('cap_reached', (...a: unknown[]) => {
      const info = (a[0] ?? {}) as { capMs?: number };
      const hours = Math.round((info.capMs ?? policy.transport.max_connected_hours_per_day * 3600_000) / 3600_000);
      void engine.popup('relay_cap_reached', 'agentbridge: Grok paused until tomorrow',
        `The relay connection reached today's ${hours} h limit, so Grok messages wait at the relay until tomorrow. Raise it with: agentbridge config set transport.max_connected_hours_per_day <hours>`);
      engine.event('warning', 'relay_cap_reached', { cap_hours: hours });
    });
    client.on('error', (...a: unknown[]) => o.log?.(`relay: ${String((a[0] as Error)?.message ?? a[0])}`));
    const rt = new RelayRuntime(client, { origin: policy.transport.relay_url, userId: identity.userId }, store, o.usageSaveEveryMs ?? 60_000);
    o.beforeStart?.(client, rt.endpoint);
    await client.start();
    engine.event('info', 'relay_started', { mode: policy.transport.relay_mode });
    return rt;
  }

  saveUsage(): void { try { this.store.kvSet(KV.usage, JSON.stringify(this.client.connectedToday)); } catch { /* db closed */ } }

  async stop(): Promise<void> { clearInterval(this.timer); this.saveUsage(); await this.client.stop(); }
}

/** §13.4: trimmed, never-acked entries → notice-only deliveries to the Grok side of affected conversations + catch-up popup. */
export async function handleExpiry(engine: Engine, entries: ExpiryEntryLike[]): Promise<void> {
  if (entries.length === 0) return;
  const byConv = new Map<string, string[]>();
  for (const e of entries) if (e.conversation_id) byConv.set(e.conversation_id, [...(byConv.get(e.conversation_id) ?? []), e.method]);
  for (const [cid, methods] of byConv) {
    const c = engine.store.conversation(cid);
    if (!c) continue;
    for (const pid of [c.initiator_id, c.invitee_id]) {
      if (engine.store.participant(pid)?.agent === 'grok') engine.notify(pid, c, N.relayExpiredNotice(methods.length));
    }
  }
  engine.event('warning', 'relay_entries_expired', { count: entries.length, conversations: byConv.size });
  await engine.popup('relay_expired', 'agentbridge: Grok messages expired at the relay',
    `${entries.length} Grok ${entries.length === 1 ? 'call' : 'calls'} waited at the relay longer than the queue expiry and ${entries.length === 1 ? 'was' : 'were'} dropped.`);
}
