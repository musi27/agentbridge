// Minimal IPC client (CLI, tests, and a reference for the plugin): NDJSON request/response plus events.
import { connect, type Socket } from 'node:net';
import { IPC_PROTOCOL, zIpcFrame, type IpcError } from '@agentbridge/protocol';

export class IpcCallError extends Error {
  readonly code: IpcError['code'];
  constructor(e: IpcError) { super(e.message); this.code = e.code; }
}

export class IpcClient {
  private readonly socket: Socket;
  private buf = '';
  private next = 1;
  private readonly waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<string, (params: unknown) => void>();
  closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => this.onData(d));
    socket.on('close', () => { this.closed = true; for (const w of this.waiting.values()) w.reject(new Error('connection closed')); this.waiting.clear(); this.handlers.get('close')?.(null); });
    socket.on('error', () => { /* close follows */ });
  }

  static connect(socketPath: string, timeoutMs = 3000): Promise<IpcClient> {
    return new Promise((resolve, reject) => {
      const s = connect(socketPath);
      const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
      s.once('connect', () => { clearTimeout(t); resolve(new IpcClient(s)); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  /** Connect and send hello. */
  static async open(socketPath: string, client: 'plugin' | 'hook' | 'cli', clientVersion = '0.1.0'): Promise<IpcClient> {
    const c = await IpcClient.connect(socketPath);
    await c.request('hello', { protocol: IPC_PROTOCOL, client, client_version: clientVersion });
    return c;
  }

  on(event: string, fn: (params: unknown) => void): void { this.handlers.set(event, fn); }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed || this.socket.destroyed) return Promise.reject(new Error('connection closed'));
    const id = String(this.next++);
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      t.unref?.();
      this.waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v as T); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.socket.write(`${JSON.stringify({ type: 'req', id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
  }

  /** Raw write (tests: malformed frames). */
  writeRaw(s: string): void { this.socket.write(s); }

  close(): void { this.socket.destroy(); }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let f;
      try { f = zIpcFrame.parse(JSON.parse(line)); } catch { continue; }
      if (f.type === 'res') {
        const w = this.waiting.get(f.id); if (!w) continue;
        this.waiting.delete(f.id);
        if (f.error) w.reject(new IpcCallError(f.error)); else w.resolve(f.result);
      } else if (f.type === 'evt') {
        this.handlers.get(f.method)?.(f.params);
      }
    }
  }
}
