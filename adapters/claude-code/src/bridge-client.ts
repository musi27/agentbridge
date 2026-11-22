// Plugin side of the bridge link (§10, §11.3): one long-lived IPC connection per MCP server process.
// hello -> register_session (or reconnect_session after a drop) -> tool.<name> requests -> `deliver` events.
import {
  IPC_EVENTS, IPC_METHODS, IPC_PROTOCOL, IPC_PROTOCOLS_SUPPORTED, REASONS, zToolResult,
} from '@agentbridge/protocol';
import type { Reason, ToolResult } from '@agentbridge/protocol';
import { connectIpc, IpcClosedError, IpcRequestError, IpcTimeoutError } from './ipc-client.ts';
import type { IpcConnection } from './ipc-client.ts';
import { InboxPoster } from './inbox.ts';
import type { InboxTarget, PostFn } from './inbox.ts';

/** `replaced`: the bridge told us a newer registration for this Claude process won; no automatic reconnects. */
export type LinkState = 'offline' | 'connecting' | 'registered' | 'unsupported' | 'no_inbox' | 'replaced' | 'stopped';

export interface BridgeClientOptions {
  socketPath: string;
  claudePid: number;
  tagNonce: string;
  /** From CLAUDE_CODE_MESSAGING_SOCKET / _TOKEN in this process's env. null = Claude Code gave us no inbox. */
  inbox: InboxTarget | null;
  pluginVersion: string;
  cwd?: string;
  /** Reconnect backoff. The delay only resets after a connection stayed registered for `stableMs`, so a bridge that
   *  closes us right after registering is retried with growing gaps, not every 250 ms forever. */
  backoff?: { initialMs?: number; maxMs?: number; stableMs?: number };
  /** How long a tool call waits for a (re)connect before answering bridge_offline. */
  connectWaitMs?: number;
  toolTimeoutMs?: number;
  /** Inbox post spacing (tests shorten it). */
  postSpacingMs?: number;
  post?: PostFn;
  connect?: (socketPath: string) => Promise<IpcConnection>;
  log?: (msg: string) => void;
  /** Called with each automatic reconnect delay as it is scheduled (diagnostics; tests assert backoff with it). */
  onRetryScheduled?: (delayMs: number) => void;
}

const OFFLINE_HINT = 'The agentbridge bridge is not running or not reachable. Ask the user to run `agentbridge start` (or `agentbridge doctor`).';
const NO_INBOX_HINT = 'Claude Code did not give this session a cross-session inbox (CLAUDE_CODE_MESSAGING_SOCKET is not set), so agentbridge cannot deliver messages here. Ask the user to update Claude Code and run `agentbridge doctor`.';

const failed = (reason: Reason, hint: string): ToolResult => ({ status: 'failed', reason, hint });
const isReason = (s: string): s is Reason => (REASONS as readonly string[]).includes(s);

export class BridgeClient {
  readonly #o: BridgeClientOptions;
  readonly #poster: InboxPoster | null;
  readonly #log: (msg: string) => void;
  #state: LinkState;
  #conn: IpcConnection | null = null;
  #participant: { id: string; secret: string; address: string; epoch: number } | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #attempt: Promise<void> | null = null;
  #delay: number;
  #waiters: Array<() => void> = [];
  #lastError = '';
  #registeredAt = 0;
  #deliveries: Promise<void> = Promise.resolve();

  constructor(o: BridgeClientOptions) {
    this.#o = o;
    this.#log = o.log ?? (() => {});
    this.#delay = o.backoff?.initialMs ?? 250;
    this.#poster = o.inbox ? new InboxPoster(o.inbox, { ...(o.postSpacingMs !== undefined ? { spacingMs: o.postSpacingMs } : {}), ...(o.post ? { post: o.post } : {}) }) : null;
    this.#state = o.inbox ? 'offline' : 'no_inbox';
  }

  get state(): LinkState { return this.#state; }
  get participant(): { id: string; address: string; epoch: number } | null {
    return this.#participant && { id: this.#participant.id, address: this.#participant.address, epoch: this.#participant.epoch };
  }

  /** Begin connecting; keeps reconnecting with backoff until stop(). */
  start(): void {
    if (this.#state === 'no_inbox' || this.#state === 'stopped') return;
    void this.#tryConnect();
  }

  stop(): void {
    this.#state = 'stopped';
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#conn?.close();
    this.#conn = null;
    this.#wake();
  }

  #wake(): void { const w = this.#waiters; this.#waiters = []; for (const f of w) f(); }

  #scheduleRetry(): void {
    if (this.#state === 'stopped' || this.#state === 'replaced' || this.#retryTimer) return;
    const max = this.#o.backoff?.maxMs ?? 10_000;
    const jitter = 0.8 + Math.random() * 0.4;
    const wait = Math.min(this.#delay, max) * jitter;
    this.#delay = Math.min(this.#delay * 2, max);
    this.#o.onRetryScheduled?.(wait);
    this.#retryTimer = setTimeout(() => { this.#retryTimer = null; void this.#tryConnect(); }, wait);
  }

  #tryConnect(): Promise<void> {
    if (this.#attempt) return this.#attempt;
    if (this.#state === 'registered' || this.#state === 'stopped' || this.#state === 'no_inbox') return Promise.resolve();
    // After `replaced`, only an explicit tool call (callTool -> #waitRegistered) reconnects, never the timer.
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = null; }
    this.#state = 'connecting';
    this.#attempt = this.#connectOnce()
      .then(() => {
        this.#state = 'registered';
        this.#registeredAt = Date.now();
        this.#lastError = '';
        this.#log(`registered as ${this.#participant?.address} (epoch ${this.#participant?.epoch})`);
      })
      .catch((e: unknown) => {
        this.#conn?.close();
        this.#conn = null;
        if (this.#state === 'replaced') return; // the bridge closed us after `replaced`: stay down
        if (this.#state !== 'stopped' && this.#state !== 'unsupported') this.#state = 'offline';
        const msg = `bridge link: ${e instanceof Error ? e.message : String(e)}`;
        if (msg !== this.#lastError) this.#log(msg); // log changes only, not every retry
        this.#lastError = msg;
        this.#scheduleRetry();
      })
      .finally(() => { this.#attempt = null; this.#wake(); });
    return this.#attempt;
  }

  async #connectOnce(): Promise<void> {
    const inbox = this.#o.inbox;
    if (!inbox) throw new Error('no inbox');
    const conn = await (this.#o.connect ?? ((p) => connectIpc(p)))(this.#o.socketPath);
    this.#conn = conn;
    // Attach before the first request: the IPC client dispatches every line of a read synchronously, so a `deliver`
    // sent right behind the register_session answer would otherwise arrive before anyone listens. Buffer until bound.
    let bound = false;
    const early: unknown[] = [];
    conn.onEvent((method, params) => {
      if (method === 'deliver') { if (bound) this.#queueDeliver(conn, params); else early.push(params); }
      else if (method === 'replaced') this.#onReplaced(conn, params);
    });
    const hello = IPC_METHODS.hello.result.parse(
      await conn.request('hello', { protocol: IPC_PROTOCOL, client: 'plugin', client_version: this.#o.pluginVersion }, 3000));
    if (!(IPC_PROTOCOLS_SUPPORTED as readonly number[]).includes(hello.protocol)) {
      this.#state = 'unsupported';
      throw new Error(`bridge speaks IPC protocol ${hello.protocol}; this plugin supports ${IPC_PROTOCOLS_SUPPORTED.join(', ')}`);
    }
    let reg: unknown = null;
    if (this.#participant) {
      try {
        reg = await conn.request('reconnect_session', { participant_id: this.#participant.id, session_secret: this.#participant.secret, claude_pid: this.#o.claudePid }, 5000);
      } catch (e) {
        if (!(e instanceof IpcRequestError)) throw e;
        // Bridge restarted (secrets are in memory only) or the participant was replaced: register afresh.
        this.#log(`reconnect refused (${e.code}); registering again`);
        this.#participant = null;
      }
    }
    if (!reg) {
      reg = await conn.request('register_session', {
        claude_pid: this.#o.claudePid, tag_nonce: this.#o.tagNonce, inbox: { socket: inbox.socket, token: inbox.token },
        plugin_version: this.#o.pluginVersion, ...(this.#o.cwd ? { cwd: this.#o.cwd } : {}),
      }, 5000);
    }
    const r = IPC_METHODS.register_session.result.parse(reg);
    this.#participant = { id: r.participant_id, secret: r.session_secret, address: r.address, epoch: r.epoch };
    conn.onClose(() => {
      if (this.#conn !== conn) return;
      this.#conn = null;
      if (this.#state === 'stopped' || this.#state === 'replaced') return;
      if (this.#state === 'registered' && Date.now() - this.#registeredAt >= (this.#o.backoff?.stableMs ?? 10_000)) {
        this.#delay = this.#o.backoff?.initialMs ?? 250; // it was a healthy connection: start backoff afresh
      }
      this.#state = 'offline';
      this.#log('bridge connection closed; reconnecting');
      this.#scheduleRetry();
    });
    if (conn.closed) throw new IpcClosedError('bridge closed the connection during registration');
    bound = true;
    for (const params of early.splice(0)) this.#queueDeliver(conn, params);
  }

  #onReplaced(conn: IpcConnection, params: unknown): void {
    const p = IPC_EVENTS.replaced.safeParse(params);
    this.#log(`replaced by a newer registration for this Claude process (${p.success ? p.data.reason : 'no reason given'}); not reconnecting`);
    if (this.#state === 'stopped') return;
    this.#state = 'replaced';
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = null; }
    if (this.#conn === conn) this.#conn = null;
    conn.close();
  }

  /** Deliveries run one at a time, in arrival order. */
  #queueDeliver(conn: IpcConnection, params: unknown): void {
    this.#deliveries = this.#deliveries.then(() => this.#onDeliver(conn, params)).catch(() => undefined);
  }

  /** `deliver` event: post each item in order (>= 200 ms apart), answer post_result for each. */
  async #onDeliver(conn: IpcConnection, params: unknown): Promise<void> {
    const parsed = IPC_EVENTS.deliver.safeParse(params);
    if (!parsed.success || !this.#poster) { this.#log('ignored malformed deliver event'); return; }
    for (const item of parsed.data.items) {
      // If the link dropped, stop: the bridge re-sends whatever it has no post_result for.
      if (conn.closed) return;
      let ok = true;
      let error: string | undefined;
      try { await this.#poster.post(item.text); } catch (e) { ok = false; error = e instanceof Error ? e.message : String(e); }
      try {
        await conn.request('post_result', error === undefined ? { post_id: item.post_id, ok } : { post_id: item.post_id, ok, error }, 5000);
      } catch (e) { this.#log(`post_result ${item.post_id}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  /** One immediate connect attempt (skipping any backoff wait), then wait for it or the deadline. */
  async #waitRegistered(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    if (this.#state === 'replaced') this.#state = 'offline'; // an explicit tool call may take the session back
    void this.#tryConnect();
    while (this.#attempt && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        this.#waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }

  /** Forward one MCP tool call as `tool.<name>`. Never throws: failures come back as a ToolResult. */
  async callTool(name: string, args: unknown): Promise<ToolResult> {
    if (this.#state === 'no_inbox') return failed('host_refused', NO_INBOX_HINT);
    if (this.#state !== 'registered') await this.#waitRegistered(this.#o.connectWaitMs ?? 1500);
    if (this.#state === 'unsupported') return failed('version_unsupported', 'The agentbridge bridge and this Claude Code plugin have incompatible versions. Ask the user to update agentbridge.');
    const conn = this.#conn;
    if (this.#state !== 'registered' || !conn) return failed('bridge_offline', OFFLINE_HINT);
    let raw: unknown;
    try {
      raw = await conn.request(`tool.${name}`, args ?? {}, this.#o.toolTimeoutMs ?? 60_000);
    } catch (e) {
      if (e instanceof IpcRequestError) return failed(isReason(e.code) ? e.code : 'invalid_message', e.message);
      if (e instanceof IpcTimeoutError) return failed('bridge_offline', 'The bridge did not answer in time. Check `agentbridge status`.');
      return failed('bridge_offline', OFFLINE_HINT);
    }
    const r = zToolResult.safeParse(raw);
    return r.success ? r.data : failed('invalid_message', 'The bridge returned a malformed result.');
  }
}
