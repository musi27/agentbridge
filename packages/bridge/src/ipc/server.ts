// Local IPC server (§10): Unix socket (dir 0700, socket 0600, peer UID checked), NDJSON frames ≤ 256 KB validated
// with zIpcFrame. Exactly IPC_METHODS + tool.* (toolParams) + cli.* (CLI_METHODS), plus the `deliver` event.
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import {
  IPC_METHODS, IPC_PROTOCOL, PERMISSION_MODES, IPC_PROTOCOLS_SUPPORTED, CLI_METHODS, LIMITS, TOOL_METHODS, ulid, zIpcFrame,
  type IpcError, type ParticipantLink, type CliMethod,
} from '@agentbridge/protocol';
import { BRIDGE_VERSION, isEngineError, type Engine } from '../core/engine.ts';
import { isDescendant, type PeerResolver } from './peer.ts';
import { handleCli, type CliContext } from './cli-methods.ts';

export interface IpcServerOptions {
  engine: Engine;
  socketPath: string;
  runDir: string;
  peer: PeerResolver;
  /** Expected peer uid (default: this process's uid). */
  uid?: number;
  /** Max time to wait for an inbox post_result before treating the post as failed (default 30 s). */
  postTimeoutMs?: number;
  cli?: Omit<CliContext, 'engine'>;
}

type Client = 'plugin' | 'hook' | 'cli';
const TOOLS: ReadonlySet<string> = new Set(TOOL_METHODS);

class Conn {
  readonly id = ulid();
  client: Client | null = null;
  participant: { id: string; epoch: number } | null = null;
  private buf = '';
  private peerPid: Promise<number | null> | null = null;
  private readonly pending = new Map<string, { resolve: (r: { post_id: string; ok: boolean; error?: string }) => void }>();
  closed = false;
  readonly link: ParticipantLink;

  readonly socket: Socket;
  private readonly srv: IpcServer;

  constructor(socket: Socket, srv: IpcServer) {
    this.socket = socket; this.srv = srv;
    this.link = { deliver: (items) => this.deliver(items) };
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => { /* close follows */ });
  }

  peer(): Promise<number | null> { return (this.peerPid ??= this.srv.opts.peer.peerPid(this.socket)); }

  send(frame: unknown): void {
    if (this.closed) return;
    const line = JSON.stringify(frame);
    if (Buffer.byteLength(line, 'utf8') > LIMITS.ipcFrameBytes) {
      const id = (frame as { id?: string }).id;
      if (id) this.socket.write(`${JSON.stringify({ type: 'res', id, error: { code: 'too_large', message: 'response exceeds the 256 KB frame limit' } })}\n`);
      return;
    }
    this.socket.write(`${line}\n`);
  }

  close(): void { if (!this.closed) this.socket.destroy(); }

  private onData(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i < 0) break;
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (Buffer.byteLength(line, 'utf8') > LIMITS.ipcFrameBytes) { this.protocolError('frame exceeds 256 KB'); return; }
      if (line.trim()) void this.onLine(line);
    }
    if (Buffer.byteLength(this.buf, 'utf8') > LIMITS.ipcFrameBytes) this.protocolError('frame exceeds 256 KB');
  }

  private protocolError(message: string): void {
    this.send({ type: 'evt', method: 'error', params: { code: 'invalid_message', message } });
    this.close();
  }

  private async onLine(line: string): Promise<void> {
    let json: unknown;
    try { json = JSON.parse(line); } catch { this.protocolError('invalid JSON'); return; }
    const f = zIpcFrame.safeParse(json);
    if (!f.success) { this.protocolError('invalid frame'); return; }
    const frame = f.data;
    if (frame.type !== 'req') return; // the bridge never sends requests, so responses/events from clients are ignored
    let out: { result?: unknown; error?: IpcError };
    try { out = await this.srv.handle(this, frame.method, frame.params); }
    catch (e) { out = { error: { code: 'internal', message: (e as Error).message.slice(0, 200) } }; }
    this.send({ type: 'res', id: frame.id, ...out });
  }

  /** ParticipantLink: send the deliver event and wait for every post_result. */
  private deliver(items: Array<{ post_id: string; text: string }>): Promise<Array<{ post_id: string; ok: boolean; error?: string }>> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const waits = items.map((it) => new Promise<{ post_id: string; ok: boolean; error?: string }>((resolve) => {
      const t = setTimeout(() => { this.pending.delete(it.post_id); resolve({ post_id: it.post_id, ok: false, error: 'timeout waiting for post_result' }); }, this.srv.opts.postTimeoutMs ?? 30_000);
      t.unref?.();
      this.pending.set(it.post_id, { resolve: (r) => { clearTimeout(t); resolve(r); } });
    }));
    this.send({ type: 'evt', method: 'deliver', params: { items } });
    return new Promise((resolve, reject) => {
      const onClose = (): void => reject(new Error('connection closed'));
      this.socket.once('close', onClose);
      void Promise.all(waits).then((r) => { this.socket.off('close', onClose); if (this.closed) reject(new Error('connection closed')); else resolve(r); });
    });
  }

  postResult(r: { post_id: string; ok: boolean; error?: string | undefined }): boolean {
    const p = this.pending.get(r.post_id); if (!p) return false;
    this.pending.delete(r.post_id); p.resolve({ post_id: r.post_id, ok: r.ok, ...(r.error ? { error: r.error } : {}) }); return true;
  }

  private onClose(): void {
    this.closed = true;
    this.srv.conns.delete(this);
    this.srv.opts.engine.connectionClosed(this.id);
  }
}

const e = (code: IpcError['code'], message: string): { error: IpcError } => ({ error: { code, message } });

export class IpcServer {
  readonly opts: IpcServerOptions;
  readonly conns = new Set<Conn>();
  private server: Server | null = null;

  constructor(opts: IpcServerOptions) { this.opts = opts; }

  async listen(): Promise<void> {
    const { runDir, socketPath } = this.opts;
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const st = lstatSync(runDir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${runDir} is not a directory`);
    if (st.uid !== (this.opts.uid ?? process.getuid!())) throw new Error(`${runDir} is not owned by this user`);
    chmodSync(runDir, 0o700);
    if (existsSync(socketPath)) unlinkSync(socketPath); // caller holds the single-instance lock
    const server = createServer({ allowHalfOpen: false }, (s) => { const c = new Conn(s, this); this.conns.add(c); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
    chmodSync(socketPath, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
    try { if (existsSync(this.opts.socketPath)) unlinkSync(this.opts.socketPath); } catch { /* gone */ }
  }

  /** Peer must be our uid (when known) — checked on hello. */
  private async uidOk(c: Conn): Promise<boolean> {
    const pid = await c.peer();
    if (pid === null) return true; // unknown: socket mode 0600 in a 0700 dir is the barrier
    const p = await this.opts.peer.proc(pid);
    return !p || p.uid === (this.opts.uid ?? process.getuid!());
  }

  /** The connecting process must be a child of claude_pid (best effort, §10). */
  private async childOf(c: Conn, claudePid: number): Promise<boolean> {
    const pid = await c.peer();
    if (pid === null) return true;
    const r = await isDescendant(this.opts.peer, pid, claudePid);
    return r !== false;
  }

  async handle(c: Conn, method: string, params: unknown): Promise<{ result?: unknown; error?: IpcError }> {
    const engine = this.opts.engine;
    if (method === 'ping') return { result: { t: Date.now() } };
    if (method === 'hello') {
      const p = IPC_METHODS.hello.params.safeParse(params);
      if (!p.success) return e('invalid_message', 'invalid hello');
      if (!(IPC_PROTOCOLS_SUPPORTED as readonly number[]).includes(p.data.protocol)) return e('version_unsupported', `protocol ${p.data.protocol} unsupported; bridge speaks ${IPC_PROTOCOLS_SUPPORTED.join(', ')}`);
      if (!(await this.uidOk(c))) { setImmediate(() => c.close()); return e('unauthenticated', 'peer uid mismatch'); }
      c.client = p.data.client;
      return { result: { protocol: IPC_PROTOCOL, bridge_version: BRIDGE_VERSION } };
    }
    if (!c.client) return e('unauthenticated', 'send hello first');

    if (method === 'session_event') {
      // unknown permission modes (newer Claude Code) map to 'unknown' (hold) instead of failing the event (§8.4)
      const raw = params && typeof params === 'object' ? { ...(params as Record<string, unknown>) } : params;
      if (raw && typeof raw === 'object' && 'permission_mode' in raw && !(PERMISSION_MODES as readonly unknown[]).includes((raw as Record<string, unknown>)['permission_mode'])) (raw as Record<string, unknown>)['permission_mode'] = 'unknown';
      const p = IPC_METHODS.session_event.params.safeParse(raw);
      if (!p.success) return e('invalid_message', 'invalid session_event');
      if (!(await this.childOf(c, p.data.claude_pid))) return e('unauthenticated', 'caller is not a child of claude_pid');
      engine.sessionEvent(p.data);
      return { result: { ok: true } };
    }
    if (method === 'register_session' || method === 'reconnect_session') {
      if (c.client !== 'plugin') return e('unauthenticated', 'only the plugin MCP server registers sessions');
      const schema = method === 'register_session' ? IPC_METHODS.register_session.params : IPC_METHODS.reconnect_session.params;
      const p = schema.safeParse(params);
      if (!p.success) return e('invalid_message', `invalid ${method}`);
      const claudePid = (p.data as { claude_pid: number }).claude_pid;
      if (!(await this.childOf(c, claudePid))) return e('unauthenticated', 'caller is not a child of claude_pid');
      if (c.closed) return e('unauthenticated', 'connection closed');
      const conn = { connId: c.id, link: c.link, close: () => c.close(), isOpen: () => !c.closed,
        replace: (reason: string) => { c.send({ type: 'evt', method: 'replaced', params: { reason } }); c.close(); } };
      const res = method === 'register_session'
        ? await engine.registerSession(p.data as Parameters<Engine['registerSession']>[0], conn)
        : engine.reconnectSession(p.data as Parameters<Engine['reconnectSession']>[0], conn);
      if (isEngineError(res)) return res;
      c.participant = { id: res.participant_id, epoch: res.epoch };
      return { result: res };
    }
    if (method === 'post_result') {
      if (!engine.bindingFor(c.id)) return e('unauthenticated', 'not a registered participant connection');
      const p = IPC_METHODS.post_result.params.safeParse(params);
      if (!p.success) return e('invalid_message', 'invalid post_result');
      c.postResult(p.data);
      return { result: { ok: true } };
    }
    if (TOOLS.has(method)) {
      const b = c.client === 'plugin' ? engine.bindingFor(c.id) : null;
      if (!b) return e('unauthenticated', 'tool calls need a registered session');
      return { result: await engine.callTool(b, method, params ?? {}) };
    }
    if (method in CLI_METHODS) {
      if (c.client !== 'cli') return e('unauthenticated', 'CLI methods are for the agentbridge CLI');
      return handleCli({ engine, ...this.opts.cli }, method as CliMethod, params ?? {});
    }
    return e('method_not_found', `unknown method ${method}`);
  }
}
