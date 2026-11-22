// One bridge WebSocket on GET /v1/connect (§13.2, §13.4): challenge -> auth -> ready, then stream delivery, res/ack/ctl,
// a heartbeat (ws ping + `wake` frame), and newest-connection routing via an atomic presence claim.
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { RELAY_CLOSE, RELAY_PROTOCOL, RELAY_STREAM_FORMAT, relayAuthMessage, zRelayFrame, isUlid, type RelayFrame } from '@agentbridge/protocol';
import { ackExpiry, ackThrough, getUser, nextStreamId, trimExpired, type Ctx } from './core.ts';
import { handleControl } from './control.ts';
import { ed25519Verify, fromB64 } from './crypto.ts';
import { isStreamId, presenceRank } from './store.ts';

const AUTH_TIMEOUT_MS = 10_000;
const CHALLENGE_MAX_AGE_MS = 60_000;
const DRAIN_BATCH = 100;
const MISSED_PONGS_FATAL = 2;

export function handleConnection(x: Ctx, ws: WebSocket, requestHost: string | undefined): void {
  const nonce = randomBytes(24).toString('base64url');
  const ts = x.now();
  const host = x.host ?? requestHost ?? '';
  let userId: string | null = null, connId = '', rank = 0, presence = '';
  let lastSent = '0-0';
  let superseded = false, closed = false, deaf = false;
  let draining = false, drainAgain = false;
  let unsubscribe: (() => Promise<void>) | null = null;
  let missedPongs = 0;
  const timers: NodeJS.Timeout[] = [];
  const later = (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); t.unref?.(); timers.push(t); return t; };
  const every = (ms: number, fn: () => void) => { const t = setInterval(fn, ms); t.unref?.(); timers.push(t); return t; };

  const send = (f: RelayFrame) => new Promise<boolean>((resolve) => {
    if (closed || ws.readyState !== ws.OPEN) return resolve(false);
    ws.send(JSON.stringify(f), (e) => resolve(!e));
  });
  const close = (code: number, reason: string) => { if (!closed) { try { ws.close(code, reason); } catch { ws.terminate(); } } };

  // Heartbeat: detects half-open links (relay side) and gives the client traffic to watch (client side).
  every(x.heartbeatMs, () => {
    if (closed || deaf) return;
    if (missedPongs >= MISSED_PONGS_FATAL) { x.log('heartbeat_dead', { user: userId ?? '' }); ws.terminate(); return; }
    missedPongs++;
    try { ws.ping(); } catch { /* closing */ }
    if (userId) void send({ type: 'wake' });
  });
  ws.on('pong', () => { if (!deaf) missedPongs = 0; });

  // Simulated platform cutoff (tests): go deaf, then drop without a close frame (M0 V10: code 1006).
  if (x.cutoffMs !== undefined) {
    later(Math.max(0, x.cutoffMs - x.deafBeforeCutoffMs), () => { deaf = true; });
    later(x.cutoffMs, () => ws.terminate());
  }

  const drain = async (): Promise<void> => {
    if (!userId || superseded || closed || deaf) return;
    if (draining) { drainAgain = true; return; }
    draining = true;
    try {
      do {
        drainAgain = false;
        for (;;) {
          const batch = await x.store.xrange(x.k.inbox(userId), nextStreamId(lastSent), '+', DRAIN_BATCH);
          for (const [id, f] of batch) {
            if (superseded || closed || deaf) return;
            lastSent = id;
            if (Number(f.v) !== RELAY_STREAM_FORMAT || !f.r || !f.s) continue; // another format: left for a matching deployment
            // Relative deadline: the bridge's clock may differ from ours.
            await send({ type: 'req', entry_id: id, req_id: f.r, format: Number(f.v), deadline_in_ms: Math.max(0, Number(f.d ?? 0) - x.now()), sealed: f.s });
          }
          if (batch.length < DRAIN_BATCH) break;
        }
      } while (drainAgain && !closed);
    } catch (e) {
      x.log('drain_error', { user: userId, error: String((e as Error)?.message ?? e).slice(0, 120) });
    } finally { draining = false; }
  };

  /** Another connection claimed the user. Only a connection that authenticated later can supersede this one. */
  const supersede = (byPresence: string) => {
    if (closed || byPresence === presence) return;
    const r = presenceRank(byPresence);
    if (r < rank || (r === rank && byPresence < presence)) return; // older than us: ignore
    if (superseded) { close(RELAY_CLOSE.superseded, 'superseded'); return; } // a third connection: keep at most two
    superseded = true;
    later(x.overlapMs, () => close(RELAY_CLOSE.superseded, 'superseded'));
  };

  const poll = async () => {
    if (!userId || closed || deaf || superseded) return;
    try {
      const holder = await x.store.claimNewest(x.k.conn(userId), presence, rank, x.pollMs * 3);
      if (holder !== null) { supersede(holder); return; } // a newer connection holds it (its publish may have been lost)
    } catch { /* next poll */ }
    void drain();
  };

  const onAuth = async (f: Extract<RelayFrame, { type: 'auth' }>) => {
    if (f.protocol !== RELAY_PROTOCOL) return close(RELAY_CLOSE.protocolUnsupported, 'protocol unsupported');
    const deny = () => close(RELAY_CLOSE.unauthorized, 'unauthorized');
    if (Math.abs(x.now() - ts) > CHALLENGE_MAX_AGE_MS) return deny();
    if ((await x.store.del(x.k.nonce(nonce))) !== 1) return deny(); // single use
    const pub = fromB64(f.pubkey, 32), sig = fromB64(f.sig, 64);
    if (!pub || !sig) return deny();
    const user = await getUser(x, f.user_id);
    // The registered key is authoritative: before a rotation it is the one user_id derives from (checked at registration).
    if (!user || !Buffer.from(user.ed25519_pub, 'base64').equals(pub)) return deny();
    if (!ed25519Verify(pub, relayAuthMessage(host, nonce, ts), sig)) return deny();
    if (closed) return;

    const u = f.user_id;
    userId = u; connId = f.conn_id.slice(0, 64).replace(/\|/g, '');
    rank = x.now(); presence = `${rank}|${connId}`;
    if (f.cursor !== undefined && isStreamId(f.cursor)) { lastSent = f.cursor; await ackThrough(x, u, f.cursor); }
    if (closed) return;
    const unsub = await x.hub.add(u, (m) => {
      if (deaf) return;
      if (m.startsWith('s:')) supersede(m.slice(2)); else void drain();
    });
    if (closed) { await unsub(); return; } // the close handler already ran without it
    unsubscribe = unsub;
    const holder = await x.store.claimNewest(x.k.conn(u), presence, rank, x.pollMs * 3);
    if (closed) { void x.store.delIfEquals(x.k.conn(u), presence).catch(() => {}); return; }
    if (holder !== null) supersede(holder);
    await x.store.publish(x.k.wake(u), `s:${presence}`);
    if (closed) return;
    await send({ type: 'ready', conn_id: connId, server_time: x.now() });
    x.log('connected', { user: u });

    // Trimmed, never-acked entries are reported on connect and kept until the bridge acks them (§13.4).
    await trimExpired(x, u);
    if (closed) return;
    const expired = await x.store.xrange(x.k.expired(u), '-', '+', 500);
    if (expired.length && !closed) {
      const entries = expired.map(([, e]) => ({ req_id: e.r ?? '', method: e.m ?? '', ...(e.c ? { conversation_id: e.c } : {}) }));
      await send({ type: 'expiry', cursor: expired[expired.length - 1]![0], entries });
    }
    if (closed) return;
    every(x.pollMs, () => void poll());
    await drain();
  };

  const onFrame = async (f: RelayFrame) => {
    if (!userId) return;
    switch (f.type) {
      case 'res': {
        if (!isUlid(f.req_id)) return;
        const body = JSON.stringify({ v: RELAY_STREAM_FORMAT, ...(f.error ? { error: f.error } : { result: f.result ?? null }) });
        await x.store.pushExpire(x.k.res(userId, f.req_id), body, x.resTtlMs);
        return;
      }
      case 'ack':
        if (isStreamId(f.cursor)) await ackThrough(x, userId, f.cursor);
        return;
      case 'expiry_ack':
        if (isStreamId(f.cursor)) await ackExpiry(x, userId, f.cursor);
        return;
      case 'ctl': {
        const r = await handleControl(x, userId, f.method, f.params);
        await send({ type: 'ctl_res', id: f.id, ...r });
        return;
      }
      default: return;
    }
  };

  ws.on('message', (data, isBinary) => {
    if (deaf || isBinary) return;
    let parsed: RelayFrame;
    try {
      const r = zRelayFrame.safeParse(JSON.parse(data.toString()));
      if (!r.success) { if (!userId) close(RELAY_CLOSE.unauthorized, 'bad frame'); return; }
      parsed = r.data;
    } catch { if (!userId) close(RELAY_CLOSE.unauthorized, 'bad frame'); return; }
    if (!userId) {
      if (parsed.type !== 'auth') return close(RELAY_CLOSE.unauthorized, 'auth expected');
      onAuth(parsed).catch(() => close(1011, 'error'));
      return;
    }
    onFrame(parsed).catch((e) => x.log('frame_error', { user: userId ?? '', error: String((e as Error)?.message ?? e).slice(0, 120) }));
  });

  ws.on('close', () => {
    closed = true;
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    void unsubscribe?.().catch(() => {});
    if (userId && presence) void x.store.delIfEquals(x.k.conn(userId), presence).catch(() => {});
  });
  ws.on('error', () => {});

  later(AUTH_TIMEOUT_MS, () => { if (!userId) close(RELAY_CLOSE.unauthorized, 'auth timeout'); });
  void x.store.set(x.k.nonce(nonce), '1', { pxMs: CHALLENGE_MAX_AGE_MS * 2, nx: true })
    .then(() => send({ type: 'challenge', protocol: RELAY_PROTOCOL, nonce, ts }))
    .catch(() => close(1011, 'error'));
}
