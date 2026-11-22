// Test fakes: a fake bridge IPC server and a fake Claude Code inbox socket. Unix sockets in temp dirs only.
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '@agentbridge/protocol';

export function tempDir(prefix = 'ab-'): { dir: string; cleanup: () => void } {
  // short base: macOS limits Unix socket paths to 104 bytes
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ceiling for event-driven waits. Generous on purpose: waitFor returns as soon as the condition holds, so this only
 *  matters when something is really broken, and it keeps the suite green on a heavily loaded machine. */
export const WAIT_CEILING_MS = 15_000;

export async function waitFor<T>(fn: () => T | undefined | null | false, what = 'condition', timeoutMs = WAIT_CEILING_MS): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export interface Received { conn: number; type: string; id?: string; method: string; params: unknown; at: number }
type Handler = (params: unknown, conn: number) => unknown;

export class IpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Speaks the §10 frame format. Handlers return a result or throw IpcError for an error frame. */
export class FakeBridge {
  readonly path: string;
  readonly received: Received[] = [];
  readonly sockets: net.Socket[] = [];
  handlers: Record<string, Handler>;
  /** Events to append to the same socket write as a method's response (reproduces res+evt in one read). */
  piggyback: Record<string, (params: unknown) => Array<{ method: string; params: unknown }>> = {};
  /** Close the connection right after answering these methods. */
  closeAfter: Set<string> = new Set();
  #server: net.Server;
  #epoch = 0;

  constructor(path: string) {
    this.path = path;
    this.handlers = {
      hello: () => ({ protocol: 1, bridge_version: 'fake' }),
      register_session: () => ({ participant_id: ulid(), address: 'claude:fake-session', epoch: ++this.#epoch, session_secret: `secret-${this.#epoch}` }),
      reconnect_session: (p) => ({ participant_id: (p as { participant_id: string }).participant_id, address: 'claude:fake-session', epoch: ++this.#epoch, session_secret: `secret-${this.#epoch}` }),
      session_event: () => ({ ok: true }),
      post_result: () => ({ ok: true }),
    };
    this.#server = net.createServer((sock) => this.#onConn(sock));
  }

  listen(): Promise<this> { return new Promise((r) => this.#server.listen(this.path, () => r(this))); }

  #onConn(sock: net.Socket): void {
    const conn = this.sockets.push(sock) - 1;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const f = JSON.parse(line) as { type: string; id?: string; method: string; params?: unknown };
        this.received.push({ conn, type: f.type, ...(f.id ? { id: f.id } : {}), method: f.method, params: f.params, at: Date.now() });
        if (f.type !== 'req') continue;
        const h = this.handlers[f.method] ?? (f.method.startsWith('tool.') ? () => ({ status: 'handed_off' }) : undefined);
        let res: object;
        try {
          if (!h) throw new IpcError('method_not_found', f.method);
          res = { type: 'res', id: f.id, result: h(f.params, conn) };
        } catch (e) {
          res = { type: 'res', id: f.id, error: { code: e instanceof IpcError ? e.code : 'internal', message: (e as Error).message } };
        }
        const extra = (this.piggyback[f.method]?.(f.params) ?? []).map((e) => JSON.stringify({ type: 'evt', ...e }) + '\n').join('');
        if (!sock.destroyed) sock.write(JSON.stringify(res) + '\n' + extra);
        if (this.closeAfter.has(f.method)) sock.end();
      }
    });
  }

  calls(method: string): Received[] { return this.received.filter((r) => r.method === method); }

  sendEvent(conn: number, method: string, params: unknown): void {
    this.sockets[conn]!.write(JSON.stringify({ type: 'evt', method, params }) + '\n');
  }

  /** Drop every client connection (simulates a bridge restart without closing the listener). */
  dropAll(): void { for (const s of this.sockets) s.destroy(); }

  close(): Promise<void> {
    this.dropAll();
    return new Promise((r) => this.#server.close(() => r()));
  }
}

/** Records every line written to it, per connection, like Claude Code's inbox socket (which never answers). */
export class FakeInbox {
  readonly path: string;
  readonly connections: Array<{ lines: string[]; at: number }> = [];
  #server: net.Server;

  constructor(path: string) {
    this.path = path;
    this.#server = net.createServer((sock) => {
      const rec = { lines: [] as string[], at: Date.now() };
      this.connections.push(rec);
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('error', () => {});
      sock.on('data', (c: string) => {
        buf += c;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) { rec.lines.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      });
    });
  }

  listen(): Promise<this> { return new Promise((r) => this.#server.listen(this.path, () => r(this))); }

  /** Texts of the `user` lines, in arrival order. */
  texts(): string[] {
    return this.connections.flatMap((c) => c.lines.map((l) => JSON.parse(l) as { type: string; message?: { content: string } })
      .filter((m) => m.type === 'user').map((m) => m.message!.content));
  }

  close(): Promise<void> { return new Promise((r) => this.#server.close(() => r())); }
}
