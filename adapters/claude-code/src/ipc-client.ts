// Minimal client for the bridge IPC socket (§10): newline-delimited JSON frames, <= 256 KB each.
// Deliberately free of zod so the hook bundle stays small and starts fast; callers validate payloads.
import net from 'node:net';
import { LIMITS } from '@agentbridge/protocol';
import type { IpcError } from '@agentbridge/protocol';

/** The bridge answered a request with an error frame. */
export class IpcRequestError extends Error {
  readonly code: string;
  readonly data: unknown;
  constructor(err: IpcError | { code: string; message: string; data?: unknown }) {
    super(`${err.code}: ${err.message}`);
    this.code = err.code;
    this.data = err.data;
  }
}

/** The connection closed (or never opened) before an answer arrived. */
export class IpcClosedError extends Error {}

/** A request did not get an answer in time. */
export class IpcTimeoutError extends Error {}

export type EventHandler = (method: string, params: unknown) => void;

export interface IpcConnection {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  onEvent(handler: EventHandler): void;
  onClose(handler: () => void): void;
  close(): void;
  readonly closed: boolean;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

class Connection implements IpcConnection {
  #sock: net.Socket;
  #buf = '';
  #pending = new Map<string, Pending>();
  #nextId = 1;
  #events: EventHandler[] = [];
  #closeHandlers: Array<() => void> = [];
  #closed = false;
  readonly defaultTimeoutMs: number;

  constructor(sock: net.Socket, defaultTimeoutMs: number) {
    this.#sock = sock;
    this.defaultTimeoutMs = defaultTimeoutMs;
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => this.#onData(chunk));
    sock.on('error', () => { /* 'close' follows */ });
    sock.on('close', () => this.#onClose());
  }

  get closed(): boolean { return this.#closed; }

  #onData(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.trim()) this.#onLine(line);
    }
    // A frame larger than the limit can only be a broken or hostile peer: drop the connection.
    if (Buffer.byteLength(this.#buf) > LIMITS.ipcFrameBytes) this.close();
  }

  #onLine(line: string): void {
    let f: unknown;
    try { f = JSON.parse(line); } catch { return; }
    if (!f || typeof f !== 'object') return;
    const frame = f as { type?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if (frame.type === 'res' && typeof frame.id === 'string') {
      const p = this.#pending.get(frame.id);
      if (!p) return;
      this.#pending.delete(frame.id);
      clearTimeout(p.timer);
      const err = frame.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
      if (err && typeof err === 'object') {
        p.reject(new IpcRequestError({ code: String(err.code ?? 'internal'), message: String(err.message ?? ''), data: err.data }));
      } else {
        p.resolve(frame.result);
      }
    } else if (frame.type === 'evt' && typeof frame.method === 'string') {
      for (const h of this.#events) {
        try { h(frame.method, frame.params); } catch { /* handler errors never kill the connection */ }
      }
    }
  }

  #onClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, p] of this.#pending) { clearTimeout(p.timer); p.reject(new IpcClosedError('bridge connection closed')); }
    this.#pending.clear();
    for (const h of this.#closeHandlers) { try { h(); } catch { /* ignore */ } }
  }

  request(method: string, params?: unknown, timeoutMs: number = this.defaultTimeoutMs): Promise<unknown> {
    if (this.#closed) return Promise.reject(new IpcClosedError('bridge connection closed'));
    const id = String(this.#nextId++);
    const frame = params === undefined ? { type: 'req', id, method } : { type: 'req', id, method, params };
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) > LIMITS.ipcFrameBytes) {
      return Promise.reject(new IpcRequestError({ code: 'too_large', message: `request exceeds ${LIMITS.ipcFrameBytes} bytes` }));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new IpcTimeoutError(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#sock.write(line);
    });
  }

  onEvent(handler: EventHandler): void { this.#events.push(handler); }
  onClose(handler: () => void): void { this.#closeHandlers.push(handler); }
  close(): void { this.#sock.destroy(); this.#onClose(); }
}

export interface ConnectOptions { connectTimeoutMs?: number; requestTimeoutMs?: number }

/** Open a connection to the bridge socket. Rejects with IpcClosedError if nothing listens. */
export function connectIpc(socketPath: string, opts: ConnectOptions = {}): Promise<IpcConnection> {
  const { connectTimeoutMs = 1000, requestTimeoutMs = 30_000 } = opts;
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => { sock.destroy(); reject(new IpcClosedError(`connect timeout: ${socketPath}`)); }, connectTimeoutMs);
    sock.once('error', (e) => { clearTimeout(timer); reject(new IpcClosedError(`cannot connect to ${socketPath}: ${(e as NodeJS.ErrnoException).code ?? e.message}`)); });
    sock.once('connect', () => { clearTimeout(timer); resolve(new Connection(sock, requestTimeoutMs)); });
  });
}
