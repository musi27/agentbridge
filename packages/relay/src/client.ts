// Bridge-side relay client (§13.2, §13.4): authenticates with the caller's Ed25519 key, reconnects make-before-break at
// ~270 s and with jittered backoff after drops, unseals `req` frames with the caller's X25519 key, emits calls, sends
// `res`, acks in stream order after the caller has stored each call, and runs control requests.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import {
  HOLDABLE_GROK_TOOLS, LIMITS, RELAY_CLOSE, RELAY_PATHS, RELAY_PENDING_HEADERS, RELAY_PROTOCOL, RELAY_STREAM_FORMAT, relayAuthMessage, relayPendingMessage,
  zRelayCall, zRelayFrame, zRelayPendingResponse,
  type RelayCall, type RelayFrame,
} from '@agentbridge/protocol';
import { b64, unseal, type Ed25519Signer, type X25519KeyPair } from './crypto.ts';
import { cmpStreamId, isStreamId } from './store.ts';

export type { Ed25519Signer, X25519KeyPair } from './crypto.ts';
export { ed25519Signer, ed25519SignerFromRaw, x25519KeyPair } from './crypto.ts';

export interface IncomingRelayCall {
  reqId: string;
  entryId: string;
  call: RelayCall;
  /** Local epoch ms after which the relay stops waiting (from the relay's relative `deadline_in_ms`). */
  deadlineMs: number;
  /** True when the relay is no longer waiting: the result is not read by anyone (a held item, §13.3). */
  held: boolean;
}
export type RelayCallResponse = { result: unknown } | { error: { code: string; message: string } };
export type ExpiryEntry = Extract<RelayFrame, { type: 'expiry' }>['entries'][number];

export interface RelayClientOptions {
  /** Relay base URL: https://relay.musi.live (ws/wss/http/https accepted). */
  url: string;
  /** Host signed in the handshake. Defaults to the URL's host (with port). */
  relayHost?: string;
  userId: string;
  signer: Ed25519Signer;
  x25519: X25519KeyPair;
  /**
   * Handle one call. Resolve only after the call is durably stored: the client then acks it (and the relay deletes it).
   * Return the result for Grok, or null to send no `res`. Throwing leaves the entry unacked; it is redelivered after reconnect.
   */
  onCall(call: IncomingRelayCall): Promise<RelayCallResponse | null>;
  loadCursor?(): string | undefined | Promise<string | undefined>;
  saveCursor?(cursor: string): void | Promise<void>;
  /** Trimmed, never-acked entries reported by the relay on connect (§13.4). */
  onExpiry?(entries: ExpiryEntry[]): void | Promise<void>;
  reconnectAtMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  controlTimeoutMs?: number;
  /** Give up on a connection that is not `ready` after this long (default LIMITS.relayHandshakeTimeoutMs). */
  handshakeTimeoutMs?: number;
  /** Treat a ready connection with no frame for this long as dead (default 3 x LIMITS.relayHeartbeatMs; the relay sends `wake` every heartbeat). */
  silenceTimeoutMs?: number;
  /**
   * Connection policy (§13.2). `on_demand` (default): idle with a signed `/v1/pending` check every `pendingPollMs`;
   * connected while there is Grok activity (`markActive`, calls from Grok), pending entries, or a control call.
   * `always`: hold the connection permanently (self-hosted or paid relays).
   */
  mode?: 'on_demand' | 'always';
  pendingPollMs?: number;
  /** Stay connected this long after the last activity (default 10 min). */
  activeWindowMs?: number;
  /** Daily connected-time cap in on_demand mode (default 6 h); beyond it the client stays idle and emits 'cap_reached'. */
  maxConnectedMsPerDay?: number;
  /** Connected time already used today, e.g. persisted by the bridge: { day: 'YYYY-MM-DD' (local), ms }. */
  usage?: { day: string; ms: number };
  /** How long a connection opened for a control call or a pending check stays after it (default 15 s). */
  ensureGraceMs?: number;
  /** WebSocket implementation (defaults to the global one, Node >= 22). */
  WebSocket?: typeof WebSocket;
  fetch?: typeof fetch;
  now?: () => number;
}

export class RelayControlError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RelayControlError'; this.code = code; }
}

interface Conn { ws: WebSocket; connId: string; ready: boolean; planned: boolean; dead: boolean; lastFrameAt: number; timers: NodeJS.Timeout[] }
interface Pending { done: boolean; failed: boolean; reqId: string }

const SEEN_CAP = 10_000;

const localDay = (t = Date.now()): string => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * Events: 'ready' (connId), 'disconnected' ({ code, reason }), 'idle' (on_demand: no connection wanted),
 * 'pending' ({ pending, oldest_ms }), 'cap_reached' ({ connectedMs, capMs }: show the user a popup),
 * 'error' (Error), 'call_error' (Error).
 */
export class RelayClient extends EventEmitter {
  private o: Required<Pick<RelayClientOptions, 'reconnectAtMs' | 'backoffBaseMs' | 'backoffMaxMs' | 'controlTimeoutMs' | 'handshakeTimeoutMs' | 'silenceTimeoutMs' | 'now'
    | 'mode' | 'pendingPollMs' | 'activeWindowMs' | 'maxConnectedMsPerDay' | 'ensureGraceMs'>> & RelayClientOptions;
  private httpBase: string;
  private activeUntil = 0;
  private drainUntil = 0;
  private ensureUntil = 0;
  private ctlInFlight = 0;
  private usage: { day: string; ms: number };
  private lastTick = Date.now();
  private capNotified = '';
  private policyTimer: NodeJS.Timeout | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private checking = false;
  private wsUrl: string;
  private host: string;
  private active: Conn | null = null;
  private connecting: Conn | null = null;
  private conns = new Set<Conn>(); // every socket not yet closed, so stop() can't miss one
  private stopped = true;
  private attempts = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private cursor: string | undefined;
  private pending = new Map<string, Pending>(); // by entry id, until acked
  private seen = new Map<string, true>(); // req ids handled (dedupe across reconnects)
  private ctl = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readyWaiters: (() => void)[] = [];
  private ackChain: Promise<void> = Promise.resolve();

  constructor(opts: RelayClientOptions) {
    super();
    this.o = { reconnectAtMs: LIMITS.relayReconnectAtMs, backoffBaseMs: 250, backoffMaxMs: 30_000, controlTimeoutMs: 10_000,
      handshakeTimeoutMs: LIMITS.relayHandshakeTimeoutMs, silenceTimeoutMs: 3 * LIMITS.relayHeartbeatMs, now: Date.now,
      mode: 'on_demand', pendingPollMs: LIMITS.relayPendingPollMs, activeWindowMs: LIMITS.relayActiveWindowMs,
      maxConnectedMsPerDay: LIMITS.relayMaxConnectedHoursPerDay * 3_600_000, ensureGraceMs: LIMITS.relayEnsureGraceMs, ...opts };
    this.usage = opts.usage && opts.usage.day === localDay() ? { ...opts.usage } : { day: localDay(), ms: 0 };
    const h = new URL(opts.url);
    h.protocol = h.protocol === 'wss:' || h.protocol === 'https:' ? 'https:' : 'http:';
    h.pathname = h.pathname.replace(/\/$/, '') + RELAY_PATHS.pending;
    this.httpBase = h.toString();
    const u = new URL(opts.url);
    u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
    u.pathname = u.pathname.replace(/\/$/, '') + RELAY_PATHS.connect;
    this.wsUrl = u.toString();
    this.host = opts.relayHost ?? new URL(opts.url).host;
  }

  get connected(): boolean { return !!this.active?.ready; }
  get ackCursor(): string | undefined { return this.cursor; }
  get mode(): 'on_demand' | 'always' { return this.o.mode; }
  /** Connected time used today (local day), for persistence by the bridge. */
  get connectedToday(): { day: string; ms: number } { this.tick(); return { ...this.usage }; }
  get capReached(): boolean { return this.o.mode === 'on_demand' && this.usage.day === localDay() && this.usage.ms >= this.o.maxConnectedMsPerDay; }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    const c = await this.o.loadCursor?.();
    if (c && isStreamId(c)) this.cursor = c;
    this.lastTick = Date.now();
    const tickMs = Math.max(20, Math.min(5000, this.o.activeWindowMs / 4, this.o.ensureGraceMs / 4, this.o.maxConnectedMsPerDay / 4));
    this.policyTimer = setInterval(() => { this.tick(); this.apply(); }, tickMs);
    if (this.o.mode === 'always') this.open();
    else { this.emit('idle'); this.schedulePending(0); }
  }

  /**
   * Grok activity (a delivery to Grok, a call from Grok, an awaited reply): connect if needed and stay connected for
   * `activeWindowMs`. Calls from Grok received over the relay count automatically.
   */
  markActive(): void {
    this.activeUntil = Date.now() + this.o.activeWindowMs;
    this.apply();
  }

  /** Connect for a CLI-driven request (register_bot, revoke, rotate, doctor), regardless of the cap; kept for `graceMs` after. */
  async ensureConnected(graceMs = this.o.ensureGraceMs): Promise<void> {
    this.ctlInFlight++; // wanted while we wait for `ready`
    try {
      this.apply();
      await this.waitReady(this.o.handshakeTimeoutMs + this.o.backoffMaxMs);
    } finally {
      this.ctlInFlight--;
      this.ensureUntil = Math.max(this.ensureUntil, Date.now() + graceMs);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.policyTimer) clearInterval(this.policyTimer);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.policyTimer = this.pendingTimer = null;
    this.tick();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const c of this.conns) this.closeConn(c, 'stopped');
    this.conns.clear();
    this.active = this.connecting = null;
    for (const [id, p] of this.ctl) { clearTimeout(p.timer); p.reject(new RelayControlError('bridge_offline', 'client stopped')); this.ctl.delete(id); }
    await this.ackChain.catch(() => {});
  }

  /** Resolves when a connection is ready (or rejects after `timeoutMs`). */
  waitReady(timeoutMs = this.o.controlTimeoutMs): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.readyWaiters = this.readyWaiters.filter((w) => w !== done); reject(new RelayControlError('bridge_offline', 'relay not connected')); }, timeoutMs);
      const done = () => { clearTimeout(t); resolve(); };
      this.readyWaiters.push(done);
    });
  }

  /** Send a control request (§13.3) and await its `ctl_res`. Throws RelayControlError on an error answer or timeout. */
  async control(method: string, params: unknown): Promise<unknown> {
    this.ctlInFlight++;
    try {
      if (this.o.mode === 'on_demand') await this.ensureConnected(); else await this.waitReady();
      return await this.sendControl(method, params);
    } finally {
      this.ctlInFlight--;
      this.ensureUntil = Math.max(this.ensureUntil, Date.now() + this.o.ensureGraceMs);
    }
  }

  private sendControl(method: string, params: unknown): Promise<unknown> {
    const id = randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.ctl.delete(id); reject(new RelayControlError('timeout', `${method} timed out`)); }, this.o.controlTimeoutMs);
      this.ctl.set(id, { resolve, reject, timer });
      if (!this.sendFrame({ type: 'ctl', id, method, params })) { clearTimeout(timer); this.ctl.delete(id); reject(new RelayControlError('bridge_offline', 'relay not connected')); }
    });
  }

  // --- connection policy (§13.2) -------------------------------------------------------------------------------------

  private wantConnected(): boolean {
    if (this.stopped) return false;
    if (this.o.mode === 'always') return true;
    const now = Date.now();
    if (this.ctlInFlight > 0 || now < this.ensureUntil) return true; // explicit CLI request: not subject to the cap
    if (this.capReached) return false;
    return now < this.activeUntil || now < this.drainUntil;
  }

  /** Account connected time (per local day) and raise the cap event once per day. */
  private tick(): void {
    const now = Date.now(), day = localDay(now);
    if (day !== this.usage.day) this.usage = { day, ms: 0 };
    if (this.connected) this.usage.ms += Math.max(0, now - this.lastTick);
    this.lastTick = now;
    if (this.capReached && this.capNotified !== day && (now < this.activeUntil || now < this.drainUntil || this.connected)) {
      this.capNotified = day;
      this.emit('cap_reached', { connectedMs: this.usage.ms, capMs: this.o.maxConnectedMsPerDay });
    }
  }

  /** Bring the connection state in line with the policy. */
  private apply(): void {
    if (this.stopped) return;
    const want = this.wantConnected();
    if (want && !this.active && !this.connecting && !this.retryTimer) {
      if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
      this.open();
    } else if (!want && (this.active || this.connecting || this.retryTimer)) {
      this.goIdle();
    } else if (!want && !this.pendingTimer && this.o.mode === 'on_demand') {
      this.schedulePending();
    }
  }

  private goIdle(): void {
    this.tick();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const wasActive = !!this.active;
    for (const c of this.conns) this.closeConn(c, 'idle');
    this.active = this.connecting = null;
    if (wasActive) this.emit('disconnected', { code: 1000, reason: 'idle' });
    this.emit('idle');
    this.schedulePending();
  }

  private schedulePending(delayMs?: number): void {
    if (this.stopped || this.o.mode !== 'on_demand' || this.pendingTimer) return;
    const d = delayMs ?? this.o.pendingPollMs * (0.8 + Math.random() * 0.4); // jittered
    this.pendingTimer = setTimeout(() => { this.pendingTimer = null; void this.checkPending(); }, d);
  }

  /** One signed `POST /v1/pending`; connects and drains when entries are waiting. */
  async checkPending(): Promise<number | null> {
    if (this.stopped || this.checking) return null;
    if (this.active || this.connecting || this.capReached) { this.schedulePending(); return null; }
    this.checking = true;
    try {
      const ts = Date.now();
      const sig = await this.o.signer.sign(relayPendingMessage(this.host, ts));
      const r = await (this.o.fetch ?? fetch)(this.httpBase, {
        method: 'POST',
        headers: { [RELAY_PENDING_HEADERS.userId]: this.o.userId, [RELAY_PENDING_HEADERS.ts]: String(ts), [RELAY_PENDING_HEADERS.sig]: b64(sig) },
        signal: AbortSignal.timeout(15_000),
      });
      const body = zRelayPendingResponse.safeParse(await r.json().catch(() => null));
      if (!r.ok || !body.success) { this.emit('error', new Error(`pending check failed (${r.status})`)); return null; }
      this.emit('pending', body.data);
      if (body.data.pending > 0) this.drainUntil = Date.now() + this.o.ensureGraceMs;
      return body.data.pending;
    } catch (e) {
      this.emit('error', new Error(`pending check failed: ${(e as Error).message}`));
      return null;
    } finally {
      this.checking = false;
      if (!this.stopped) { this.apply(); if (!this.active && !this.connecting) this.schedulePending(); }
    }
  }

  // --- connections ---------------------------------------------------------------------------------------------

  private open(): void {
    if (this.stopped || this.connecting) return;
    const WS = this.o.WebSocket ?? globalThis.WebSocket;
    const conn: Conn = { ws: new WS(this.wsUrl), connId: randomBytes(8).toString('hex'), ready: false, planned: false, dead: false, lastFrameAt: Date.now(), timers: [] };
    this.connecting = conn;
    this.conns.add(conn);
    // A connect stuck before `ready` must not block proactive reconnects or retries.
    conn.timers.push(setTimeout(() => { if (!conn.ready) this.drop(conn, 'handshake timeout'); }, this.o.handshakeTimeoutMs));
    conn.ws.addEventListener('message', (ev) => { conn.lastFrameAt = Date.now(); void this.onMessage(conn, ev.data); });
    conn.ws.addEventListener('close', (ev) => this.onClose(conn, ev.code, ev.reason));
    conn.ws.addEventListener('error', () => { /* followed by close */ });
  }

  private clearConnTimers(c: Conn): void { for (const t of c.timers) { clearTimeout(t); clearInterval(t); } c.timers = []; }

  private closeConn(c: Conn, reason: string): void {
    c.planned = true;
    this.clearConnTimers(c);
    try { c.ws.close(1000, reason); } catch { /* already closed */ }
  }

  /** Give up on a connection now (handshake timeout or silence): don't wait for a closing handshake on a dead link. */
  private drop(c: Conn, reason: string): void {
    if (c.dead || c.planned) return;
    c.dead = true;
    this.clearConnTimers(c);
    if (this.connecting === c) this.connecting = null;
    if (this.active === c) { this.tick(); this.active = null; this.emit('disconnected', { code: 1006, reason }); }
    try { c.ws.close(1000, reason); } catch { /* ignore */ }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || this.connecting) return;
    if (!this.wantConnected()) { this.apply(); return; }
    const n = this.attempts++;
    const delay = n === 0 ? Math.random() * Math.min(250, this.o.backoffBaseMs)
      : Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** n) * (0.5 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.open(); }, delay);
  }

  private onClose(conn: Conn, code: number, reason: string): void {
    this.clearConnTimers(conn);
    this.conns.delete(conn);
    if (conn.dead) return; // already handled by drop()
    if (this.connecting === conn) this.connecting = null;
    const wasActive = this.active === conn;
    if (wasActive) { this.tick(); this.active = null; }
    if (wasActive) this.emit('disconnected', { code, reason });
    if (code === RELAY_CLOSE.protocolUnsupported) {
      this.stopped = true; this.emit('error', new Error('relay protocol unsupported; update agentbridge')); return;
    }
    if (code === RELAY_CLOSE.unauthorized) this.emit('error', new Error('relay rejected the identity (unauthorized)'));
    if (this.stopped || conn.planned) { if (!this.stopped && !this.active && !this.connecting) this.apply(); return; }
    // An unplanned drop of the active socket, or a failed new socket (make-before-break attempt): retry with backoff.
    if (wasActive || !conn.ready) this.scheduleRetry();
  }

  private async onMessage(conn: Conn, data: unknown): Promise<void> {
    let f: RelayFrame;
    try {
      const r = zRelayFrame.safeParse(JSON.parse(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString()));
      if (!r.success) return;
      f = r.data;
    } catch { return; }
    switch (f.type) {
      case 'challenge': {
        const sig = await this.o.signer.sign(relayAuthMessage(this.host, f.nonce, f.ts));
        this.sendOn(conn, {
          type: 'auth', protocol: RELAY_PROTOCOL, user_id: this.o.userId, pubkey: b64(this.o.signer.publicKey), sig: b64(sig), conn_id: conn.connId,
          ...(this.cursor ? { cursor: this.cursor } : {}),
        });
        return;
      }
      case 'ready': return this.onReady(conn);
      case 'req': return this.onReq(conn, f);
      case 'ctl_res': {
        const p = this.ctl.get(f.id); if (!p) return;
        clearTimeout(p.timer); this.ctl.delete(f.id);
        if (f.error) p.reject(new RelayControlError(f.error.code, f.error.message)); else p.resolve(f.result);
        return;
      }
      case 'expiry': {
        try { await this.o.onExpiry?.(f.entries); } catch (e) { this.emit('call_error', e as Error); return; }
        this.sendFrame({ type: 'expiry_ack', cursor: f.cursor }, conn); // the relay keeps the records until this ack
        return;
      }
      default: return;
    }
  }

  private onReady(conn: Conn): void {
    if (this.connecting === conn) this.connecting = null;
    if (this.stopped) { this.closeConn(conn, 'stopped'); return; }
    this.tick(); // account up to now before the state changes
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    conn.ready = true;
    const prev = this.active;
    this.active = conn;
    this.attempts = 0;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    // Make-before-break: the new socket is authenticated, so the old one can go (§13.2).
    if (prev && prev !== conn) this.closeConn(prev, 'replaced');
    conn.timers.push(setTimeout(() => { if (this.active === conn && this.wantConnected()) this.open(); }, this.o.reconnectAtMs));
    conn.timers.push(setInterval(() => {
      if (Date.now() - conn.lastFrameAt > this.o.silenceTimeoutMs) this.drop(conn, 'relay silent');
    }, Math.max(50, Math.min(5000, this.o.silenceTimeoutMs / 3))));
    this.emit('ready', conn.connId);
    const w = this.readyWaiters; this.readyWaiters = [];
    for (const fn of w) fn();
  }

  private sendOn(conn: Conn, f: RelayFrame): boolean {
    if (conn.ws.readyState !== 1) return false;
    try { conn.ws.send(JSON.stringify(f)); return true; } catch { return false; }
  }

  /** Send on the newest ready socket, falling back to any other open one. */
  private sendFrame(f: RelayFrame, via?: Conn): boolean {
    for (const c of [this.active, via, this.connecting]) if (c?.ready && this.sendOn(c, f)) return true;
    return false;
  }

  // --- calls and acks -----------------------------------------------------------------------------------------------

  private async onReq(conn: Conn, f: Extract<RelayFrame, { type: 'req' }>): Promise<void> {
    const receivedAt = this.o.now();
    this.activeUntil = Date.now() + this.o.activeWindowMs; // a call from Grok is activity (§13.2)
    if (!isStreamId(f.entry_id)) return;
    if (this.cursor && cmpStreamId(f.entry_id, this.cursor) <= 0) return; // already acked
    const known = this.pending.get(f.entry_id);
    if (known && !known.failed) return; // in progress or awaiting ack
    if (!known && this.seen.has(f.req_id)) { this.pending.set(f.entry_id, { done: true, failed: false, reqId: f.req_id }); this.advanceAck(); return; }
    const p: Pending = { done: false, failed: false, reqId: f.req_id };
    this.pending.set(f.entry_id, p);
    this.markSeen(f.req_id);

    const finish = (res: RelayCallResponse | null) => {
      if (res) {
        let frame: RelayFrame = { type: 'res', req_id: f.req_id, ...res };
        // An oversized frame would make the relay drop the socket (ws 1009): answer with a short error instead.
        if (Buffer.byteLength(JSON.stringify(frame)) > LIMITS.relayResponseBytes) {
          frame = { type: 'res', req_id: f.req_id, error: { code: 'too_large', message: `Result too large for the relay (max ${LIMITS.relayResponseBytes / 1024 / 1024} MB). Ask for less, e.g. a smaller page.` } };
        }
        this.sendFrame(frame, conn);
      }
      p.done = true; this.advanceAck();
    };
    if (f.format !== RELAY_STREAM_FORMAT) return finish({ error: { code: 'version_unsupported', message: 'Bridge and relay versions differ.' } });
    const plain = await unseal(f.sealed, this.o.x25519);
    let call: RelayCall | null = null;
    if (plain) { try { const r = zRelayCall.safeParse(JSON.parse(Buffer.from(plain).toString('utf8'))); if (r.success) call = r.data; } catch { /* invalid */ } }
    if (!call) return finish({ error: { code: 'invalid_message', message: 'Could not read the request.' } });
    const deadlineMs = receivedAt + f.deadline_in_ms; // relative to the relay's send, so clock skew doesn't matter
    const held = f.deadline_in_ms === 0 || this.o.now() > deadlineMs;
    if (held && !HOLDABLE_GROK_TOOLS.has(call.method)) return finish(null); // Grok already got bridge_offline for this read
    try {
      finish(await this.o.onCall({ reqId: f.req_id, entryId: f.entry_id, call, deadlineMs, held }));
    } catch (e) {
      // Not stored: keep the entry unacked (it blocks the cursor) and allow redelivery after reconnect.
      p.failed = true; this.seen.delete(f.req_id);
      this.emit('call_error', e as Error);
    }
  }

  private markSeen(reqId: string): void {
    this.seen.set(reqId, true);
    if (this.seen.size > SEEN_CAP) { const first = this.seen.keys().next().value; if (first !== undefined) this.seen.delete(first); }
  }

  /** Ack the longest contiguous prefix of handled entries, in stream order. */
  private advanceAck(): void {
    const ids = [...this.pending.keys()].sort(cmpStreamId);
    let cursor: string | undefined;
    for (const id of ids) {
      if (!this.pending.get(id)!.done) break;
      cursor = id; this.pending.delete(id);
    }
    if (!cursor) return;
    const c = cursor;
    this.cursor = c;
    this.ackChain = this.ackChain.then(async () => {
      try { await this.o.saveCursor?.(c); } catch (e) { this.emit('call_error', e as Error); }
      if (this.cursor === c) this.sendFrame({ type: 'ack', cursor: c });
    });
  }
}
