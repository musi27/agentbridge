// The relay as one node:http Server (WebSocket upgrade included). Runs locally as-is and on Vercel as the default export
// of a Node function (M0 V10: ws WebSocketServer on an exported http.Server).
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { LIMITS, RELAY_PATHS, zBotId, zUserId } from '@agentbridge/protocol';
import { makeCtx, type Ctx, type RelayConfig } from './core.ts';
import { handleConnection } from './connection.ts';
import { handleIdentity } from './control.ts';
import { handleMcp, type HttpReply } from './mcp.ts';
import { handlePending } from './pending.ts';

const MCP_PATH = /^\/v1\/u\/([^/]+)\/b\/([^/]+)\/mcp\/?$/;
const IDENTITY_BODY_BYTES = 4096;

/** Resolve the logical path; on Vercel a rewrite may hand us `/api/relay?__p=/v1/...`. */
export function logicalPath(rawUrl: string | undefined): string {
  const u = new URL(rawUrl ?? '/', 'http://relay.invalid');
  const p = u.searchParams.get('__p');
  if (u.pathname.startsWith('/api/') && p) return p.startsWith('/') ? p : `/${p}`;
  return u.pathname;
}

/** Read the body; null if it exceeds `max` bytes (the caller answers 413 and the request is destroyed, not read on). */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) return resolve(null);
    const chunks: Buffer[] = []; let n = 0;
    const onData = (c: Buffer) => {
      n += c.length;
      if (n > max) { req.off('data', onData); req.pause(); resolve(null); return; }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** After a 413: close the connection once the answer is out, instead of draining an oversized upload. */
function dropAfterReply(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader('connection', 'close');
  res.on('finish', () => req.destroy());
}

function reply(res: http.ServerResponse, r: HttpReply): void {
  const headers: Record<string, string> = { 'cache-control': 'no-store', ...r.headers };
  if (r.body !== undefined) headers['content-type'] = 'application/json';
  res.writeHead(r.status, headers);
  res.end(r.body !== undefined ? JSON.stringify(r.body) : undefined);
}

export function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || (req.headers['x-real-ip'] as string | undefined) || req.socket.remoteAddress || 'unknown';
}

export async function handleHttp(x: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = logicalPath(req.url);
  const method = req.method ?? 'GET';
  const m = MCP_PATH.exec(path);
  if (m) {
    const [, user = '', bot = ''] = m;
    if (!zUserId.safeParse(user).success || !zBotId.safeParse(bot).success) return reply(res, { status: 404, body: { error: 'not found' } });
    const pv = req.headers['mcp-protocol-version'];
    const body = method === 'POST' ? await readBody(req, LIMITS.relayRequestBytes) : Buffer.alloc(0);
    if (body === null) dropAfterReply(req, res);
    return reply(res, await handleMcp(x, {
      method, userId: user, botId: bot, authorization: req.headers.authorization, protocolVersion: Array.isArray(pv) ? pv[0] : pv, body,
    }));
  }
  if (path === RELAY_PATHS.identity) {
    const body = method === 'POST' ? await readBody(req, IDENTITY_BODY_BYTES) : Buffer.alloc(0);
    if (body === null) dropAfterReply(req, res);
    return reply(res, await handleIdentity(x, method, body, clientIp(req)));
  }
  if (path === RELAY_PATHS.pending) {
    if (method === 'POST') req.resume(); // no body expected; don't buffer one
    return reply(res, await handlePending(x, method, req.headers, req.headers.host));
  }
  if (path === RELAY_PATHS.connect) return reply(res, { status: 426, headers: { upgrade: 'websocket' }, body: { error: 'websocket upgrade required' } });
  if (path === '/' || path === '/v1/health') return reply(res, { status: 200, body: { ok: true, service: 'agentbridge-relay' } });
  return reply(res, { status: 404, body: { error: 'not found' } });
}

export interface Relay { server: http.Server; ctx: Ctx; close(): Promise<void>; /** Test hook: drop every bridge socket abruptly. */ terminateSockets(): void }

export function createRelay(config: RelayConfig): Relay {
  const ctx = makeCtx(config);
  const server = http.createServer((req, res) => {
    handleHttp(ctx, req, res).catch((e) => {
      ctx.log('http_error', { error: String((e as Error)?.message ?? e).slice(0, 120) });
      if (!res.headersSent) reply(res, { status: 500, body: { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Relay error. Try again.' } } });
      else res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.relayResponseBytes + 16 * 1024 });
  const sockets = new Set<import('node:net').Socket>();
  let closing = false;
  server.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  server.on('upgrade', (req, socket, head) => {
    if (closing) { socket.destroy(); return; }
    if (logicalPath(req.url) !== RELAY_PATHS.connect) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ctx, ws, req.headers.host));
  });
  return {
    server, ctx,
    terminateSockets() { for (const c of wss.clients) c.terminate(); },
    async close() {
      closing = true;
      for (const c of wss.clients) c.terminate();
      wss.close(); // don't await: in noServer mode it waits for every client
      const done = server.listening ? new Promise<void>((r) => server.close(() => r())) : Promise.resolve();
      for (const s of sockets) s.destroy(); // upgraded sockets are invisible to closeAllConnections
      await done;
    },
  };
}
