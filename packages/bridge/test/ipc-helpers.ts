// IPC test harness: a real bridge service on a short /tmp root, a scriptable peer resolver, and simulated plugins.
import { mkdtempSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { newNonce, type ToolResult } from '@agentbridge/protocol';
import { FakeAdapter } from '@agentbridge/adapter-fake';
import { MemorySecretStore } from '../src/policy/integrity.ts';
import { startBridge, type BridgeService } from '../src/service.ts';
import { IpcClient } from '../src/ipc/client.ts';
import type { PeerResolver, ProcInfo } from '../src/ipc/peer.ts';
import type { Inbound } from '../src/db/store.ts';
import { RecordingNotifier, ScriptedPresence } from './helpers.ts';

/** Peer pids come from a FIFO (one per connection, in connect order); ancestry from a table. Default: unknown. */
export class ScriptedPeer implements PeerResolver {
  readonly queue: Array<number | null> = [];
  readonly procs = new Map<number, ProcInfo>();
  private readonly seen = new WeakMap<Socket, number | null>();
  /** Artificial latency for lookups (simulates slow lsof/ps). */
  delayMs = 0;
  /** Completed proc() lookups per pid (tests wait on these instead of sleeping past `delayMs`). */
  readonly procDone = new Map<number, number>();
  private async lag(): Promise<void> { if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs)); }
  async peerPid(socket: Socket): Promise<number | null> {
    await this.lag();
    if (!this.seen.has(socket)) this.seen.set(socket, this.queue.length ? this.queue.shift()! : null);
    return this.seen.get(socket)!;
  }
  async proc(pid: number): Promise<ProcInfo | null> {
    await this.lag();
    this.procDone.set(pid, (this.procDone.get(pid) ?? 0) + 1);
    return this.procs.get(pid) ?? null;
  }
  /** Declare `pid` as a child of `parent` (uid = ours unless given). */
  child(pid: number, parent: number, uid = process.getuid!()): void { this.procs.set(pid, { pid, ppid: parent, uid }); }
}

export interface IpcHarness {
  root: string; svc: BridgeService; peer: ScriptedPeer; presence: ScriptedPresence; notifier: RecordingNotifier; secrets: MemorySecretStore;
  inbound: Map<string, Inbound>; fake: FakeAdapter;
  stop(): Promise<void>;
  restart(): Promise<IpcHarness>;
}

export async function ipcHarness(o: { root?: string; secrets?: MemorySecretStore; inbound?: Map<string, Inbound> } = {}): Promise<IpcHarness> {
  const root = o.root ?? mkdtempSync('/tmp/ab-');
  const peer = new ScriptedPeer(); const presence = new ScriptedPresence(); const notifier = new RecordingNotifier();
  const secrets = o.secrets ?? new MemorySecretStore(); const inbound = o.inbound ?? new Map<string, Inbound>();
  const fake = new FakeAdapter();
  const svc = await startBridge({ root, secrets, presence, notifier, peer, adapters: { fake }, registerWaitMs: 50, inboundReader: (cwd) => (cwd ? inbound.get(cwd) ?? 'accept' : 'accept'), onStopRequested: () => {} });
  const h: IpcHarness = {
    root, svc, peer, presence, notifier, secrets, inbound, fake,
    async stop() { await svc.stop(); },
    async restart() { await svc.stop(); return ipcHarness({ root, secrets, inbound }); },
  };
  return h;
}

export function cleanup(h: IpcHarness): void { rmSync(h.root, { recursive: true, force: true }); }

/** A simulated plugin MCP server: registers, answers deliver events, records posts, calls tools. */
export class FakePlugin {
  readonly posts: string[] = [];
  /** thread_id of each deliver event (Codex, §11a); undefined for Claude Code. */
  readonly threads: Array<string | undefined> = [];
  host: 'claude' | 'codex' = 'claude';
  readonly events: Array<{ method: string; params: unknown }> = [];
  client!: IpcClient;
  nonce = newNonce();
  reg!: { participant_id: string; address: string; epoch: number; session_secret: string };
  failPosts = false;
  readonly socketPath: string; readonly claudePid: number;
  private constructor(socketPath: string, claudePid: number) { this.socketPath = socketPath; this.claudePid = claudePid; }

  static async connect(h: IpcHarness, claudePid: number, o: { cwd?: string; register?: boolean; host?: 'claude' | 'codex' } = {}): Promise<FakePlugin> {
    const p = new FakePlugin(h.svc.paths.socket, claudePid);
    if (o.host) p.host = o.host;
    p.client = await IpcClient.open(h.svc.paths.socket, 'plugin');
    p.client.on('replaced', (params) => { p.events.push({ method: 'replaced', params }); });
    p.client.on('deliver', (params) => {
      const { items, thread_id } = params as { items: Array<{ post_id: string; text: string }>; thread_id?: string };
      p.threads.push(thread_id);
      for (const it of items) {
        if (!p.failPosts) p.posts.push(it.text);
        void p.client.request('post_result', { post_id: it.post_id, ok: !p.failPosts, ...(p.failPosts ? { error: 'inbox write failed' } : {}) }).catch(() => {});
      }
    });
    if (o.register !== false) await p.register(o.cwd);
    return p;
  }

  async register(cwd?: string): Promise<void> {
    this.reg = await this.client.request('register_session', { claude_pid: this.claudePid, tag_nonce: this.nonce, ...(this.host === 'codex' ? { host: 'codex' } : { inbox: { socket: '/tmp/x.sock', token: 't' } }), plugin_version: '0.1.0', ...(cwd ? { cwd } : {}) });
  }

  tool(name: string, params: unknown): Promise<ToolResult> { return this.client.request<ToolResult>(`tool.${name}`, params); }

  /** Wait until a post matching `re` arrives. */
  async waitPost(re: RegExp, timeoutMs = WAIT_CEILING_MS): Promise<string> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.posts.find((t) => re.test(t));
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`no post matching ${re}; got:\n${this.posts.join('\n---\n')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): void { this.client.close(); }
}

/** Send a hook session_event on a fresh connection, like the plugin's hook script does. */
export async function hookEvent(h: IpcHarness, e: Record<string, unknown>): Promise<unknown> {
  const c = await IpcClient.open(h.svc.paths.socket, 'hook');
  try { return await c.request('session_event', e); } finally { c.close(); }
}

/** Facts from an invite notice post. */
export function inviteFacts(post: string): { approval_id: string; kind: 'accept'; peer: string; direction: 'incoming'; topic: string; turn_limit: number } {
  const id = /approval_id=([0-9A-Z]{26})/.exec(post)![1]!;
  const peer = /peer=([a-z]+:[A-Za-z0-9_-]+)/.exec(post)![1]!;
  const tl = Number(/turn_limit=(\d+)\./.exec(post)![1]);
  const topic = /<ab-untrusted-[0-9a-f]{8}>([\s\S]*?)<\/ab-untrusted-[0-9a-f]{8}>/.exec(post)![1]!;
  return { approval_id: id, kind: 'accept', peer, direction: 'incoming', topic, turn_limit: tl };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ceiling for event-driven waits: generous because `until`/`waitPost` return as soon as the condition holds,
 *  so it only bites when something is broken, and the suite stays green on a heavily loaded machine. */
export const WAIT_CEILING_MS = 15_000;

/** Poll until `pred()` holds (every 10 ms), or fail after `timeoutMs`. */
export async function until(pred: () => boolean, what = 'condition', timeoutMs = WAIT_CEILING_MS): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
