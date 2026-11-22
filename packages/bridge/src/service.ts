// Bridge service wiring: single-instance lock, storage, policy, engine, IPC server (§10, §15).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import type { Adapter, AgentType, Notifier, PresenceChecker, SecretStore } from '@agentbridge/protocol';
import { systemClock, type Clock } from './clock.ts';
import { openDatabase } from './db/db.ts';
import { Store, type Inbound } from './db/store.ts';
import { PolicyStore } from './policy/integrity.ts';
import { Engine } from './core/engine.ts';
import { IpcServer } from './ipc/server.ts';
import { LsofPeerResolver, type PeerResolver } from './ipc/peer.ts';
import { resolvePaths, type Paths } from './paths.ts';
import { effectiveInbound } from './inbound.ts';
import { GrokAdapter } from '@agentbridge/adapter-grok';
import { RelayLink, type RelayEndpoint, type RelayTransport } from './relay/link.ts';
import { GrokSetup } from './grok/setup.ts';

export class AlreadyRunningError extends Error {
  readonly pid: number;
  constructor(pid: number) { super(`agentbridge is already running (pid ${pid})`); this.pid = pid; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Single instance: `run/bridge.lock` holds the pid; a stale lock (dead pid) is replaced. */
export function acquireLock(lockPath: string): () => void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, String(process.pid)); closeSync(fd);
      return () => { try { if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath); } catch { /* gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(lockPath, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && (pid === process.pid || alive(pid))) throw new AlreadyRunningError(pid);
      try { unlinkSync(lockPath); } catch { /* raced */ }
    }
  }
  throw new Error(`could not acquire ${lockPath}`);
}

export interface BridgeServiceOptions {
  root?: string;
  secrets: SecretStore;
  presence: PresenceChecker;
  notifier: Notifier;
  adapters?: Partial<Record<AgentType, Adapter>>;
  peer?: PeerResolver;
  clock?: Clock;
  inboundReader?: (cwd: string | null) => Inbound;
  registerWaitMs?: number;
  log?: (line: string) => void;
  onStopRequested?: () => void;
  /** The relay client and where it points (§13). Absent: Grok setup and relay calls report that the relay is not configured. */
  relay?: { transport: RelayTransport; endpoint: RelayEndpoint };
  /** `fetch` for the default Grok adapter (tests use a local fake webhook). */
  grokFetch?: typeof fetch;
  /** Round-trip wait for `add grok` / `doctor` (default LIMITS.grokRoundTripMs). */
  grokRoundTripMs?: number;
  /** Extra `doctor` checks (Claude Code, helper, launchd, relay; src/doctor.ts). Called lazily so they can see the running service. */
  doctorExtras?: () => Promise<Array<{ id: string; ok: boolean; detail: string; fix?: string }>>;
}

export interface BridgeService { paths: Paths; engine: Engine; ipc: IpcServer; store: Store; relay: RelayLink; grok: GrokSetup; stop(): Promise<void> }

export async function startBridge(o: BridgeServiceOptions): Promise<BridgeService> {
  const paths = resolvePaths(o.root);
  if (!existsSync(paths.root)) mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  chmodSync(paths.root, 0o700);
  if (!existsSync(paths.runDir)) mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(paths.lock);
  let db;
  try { db = openDatabase(paths.db); } catch (e) { release(); throw e; }
  const store = new Store(db);
  const policy = new PolicyStore(store, o.secrets);
  let stopping: Promise<void> | null = null;
  const svc: BridgeService = {
    paths, store,
    engine: null as unknown as Engine, ipc: null as unknown as IpcServer, relay: null as unknown as RelayLink, grok: null as unknown as GrokSetup,
    stop: () => (stopping ??= (async () => { svc.relay?.stopReplyWatch(); svc.engine.stop(); await svc.ipc.close(); db.close(); release(); })()),
  };
  // Grok adapter by default (§12): bot ids from the store, secrets from the keychain, relay kept up on each delivery (§13.2).
  const adapters: Partial<Record<AgentType, Adapter>> = { ...o.adapters };
  adapters.grok ??= new GrokAdapter({
    secrets: o.secrets,
    botIdFor: (ref) => store.participant(ref.participant_id)?.bot_id ?? null,
    listBots: () => store.bots().filter((b) => b.revoked_at === null).flatMap((b) => { const p = store.participant(b.participant_id); return p && p.state !== 'gone' ? [{ bot_id: b.bot_id, address: `grok:${p.name}` }] : []; }),
    onActivity: () => svc.relay?.markActive(),
    ...(o.grokFetch ? { fetch: o.grokFetch } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  svc.engine = new Engine({
    store, policy, clock: o.clock ?? systemClock, notifier: o.notifier, presence: o.presence, adapters,
    inboundReader: o.inboundReader ?? ((cwd) => effectiveInbound(cwd)), ...(o.registerWaitMs !== undefined ? { registerWaitMs: o.registerWaitMs } : {}),
    ...(o.log ? { log: o.log } : {}),
    onStopRequested: o.onStopRequested ?? (() => { void svc.stop(); }),
  });
  // TODO(integrator): construct the RelayClient from @agentbridge/relay/client here once identity keys exist (`init`, M2):
  //   const client = new RelayClient({ url: policy.relay_url, userId, signer, x25519, onCall: (c) => svc.relay.handleCall(c), loadCursor, saveCursor });
  //   svc.relay.attach(client, { origin: url, userId }); await client.start();
  svc.relay = new RelayLink({ engine: svc.engine, ...(o.relay ? { transport: o.relay.transport, endpoint: o.relay.endpoint } : {}) });
  svc.relay.startReplyWatch(); // §13.2 "reply awaited"
  svc.grok = new GrokSetup({ engine: svc.engine, link: svc.relay, secrets: o.secrets, ...(adapters.grok ? { adapter: adapters.grok } : {}), ...(o.grokRoundTripMs !== undefined ? { roundTripMs: o.grokRoundTripMs } : {}) });
  svc.ipc = new IpcServer({ engine: svc.engine, socketPath: paths.socket, runDir: paths.runDir, peer: o.peer ?? new LsofPeerResolver(), cli: { paths: { db: paths.db, socket: paths.socket, runDir: paths.runDir }, pid: process.pid, startedAt: Date.now(), grok: svc.grok, ...(o.doctorExtras ? { doctorExtras: o.doctorExtras } : {}) } });
  try { await svc.engine.start(); await svc.ipc.listen(); }
  catch (e) { svc.engine.stop(); db.close(); release(); throw e; }
  return svc;
}
