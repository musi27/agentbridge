// Shared test harness: an Engine on an in-memory DB with a fake clock, fake adapters (one posing as Grok),
// a recording notifier and a scriptable presence checker.
import type { Notifier, PresenceChecker, PresenceResult, ToolResult } from '@agentbridge/protocol';
import { FakeAdapter } from '@agentbridge/adapter-fake';
import { FakeClock, settle } from '../src/clock.ts';
import { openDatabase } from '../src/db/db.ts';
import { Store } from '../src/db/store.ts';
import { PolicyStore, MemorySecretStore } from '../src/policy/integrity.ts';
import { applySetting } from '../src/policy/policy.ts';
import { Engine, type Caller, type EngineOptions } from '../src/core/engine.ts';

export class RecordingNotifier implements Notifier {
  readonly popups: Array<{ title: string; body: string }> = [];
  async notify(n: { title: string; body: string }): Promise<void> { this.popups.push(n); }
}
export class ScriptedPresence implements PresenceChecker {
  answer: PresenceResult = { ok: true, method: 'biometric_or_password' };
  readonly reasons: string[] = [];
  async check(reason: string): Promise<PresenceResult> { this.reasons.push(reason); return this.answer; }
}

export interface Harness {
  engine: Engine; store: Store; clock: FakeClock; secrets: MemorySecretStore; policy: PolicyStore;
  notifier: RecordingNotifier; presence: ScriptedPresence; fake: FakeAdapter; grok: FakeAdapter;
  tool(c: Caller, name: string, params: unknown, opts?: { conversation_id?: string }): Promise<ToolResult>;
  setPolicy(key: string, value: string): Promise<void>;
  restart(): Promise<Harness>;
  idle(): Promise<void>;
}

export async function harness(o: Partial<EngineOptions> & { store?: Store; secrets?: MemorySecretStore; clock?: FakeClock; fake?: FakeAdapter; grok?: FakeAdapter } = {}): Promise<Harness> {
  const clock = o.clock ?? new FakeClock();
  const store = o.store ?? new Store(openDatabase(':memory:'));
  const secrets = o.secrets ?? new MemorySecretStore();
  const policy = new PolicyStore(store, secrets);
  const notifier = new RecordingNotifier(); const presence = new ScriptedPresence();
  const fake = o.fake ?? new FakeAdapter(); const grok = o.grok ?? new FakeAdapter({ agent: 'grok' });
  const engine = new Engine({ store, policy, clock, notifier, presence, adapters: { fake, grok }, deliveryWaitMs: 2000, registerWaitMs: 0, ...o });
  await engine.start();
  const h: Harness = {
    engine, store, clock, secrets, policy, notifier, presence, fake, grok,
    tool: (c, name, params, opts) => engine.callTool(c, `tool.${name}`, params, opts),
    async setPolicy(key, value) { await policy.set(applySetting(policy.policy(), key, value)); },
    async restart() { engine.stop(); return harness({ ...o, store, secrets, clock, fake, grok }); },
    async idle() { await settle(); await engine.pipeline.idle(); await settle(); },
  };
  return h;
}

/** Start + confirm + accept between two local fake participants; returns the conversation id. */
export async function openConversation(h: Harness, a: Caller & { address: string }, b: Caller & { address: string }, o: { topic?: string; first?: string; turn_limit?: number } = {}): Promise<string> {
  const r = await h.tool(a, 'bridge_start_conversation', { peer: b.address, topic: o.topic ?? 'design review', first_message: o.first ?? 'hello', ...(o.turn_limit ? { turn_limit: o.turn_limit } : {}) });
  if (r.status !== 'pending_approval' || !r.approval) throw new Error(`expected pending_approval, got ${JSON.stringify(r)}`);
  const c = await h.tool(a, 'bridge_confirm', r.approval);
  if (c.status !== 'awaiting_local_approval' || !c.conversation_id) throw new Error(`expected awaiting_local_approval, got ${JSON.stringify(c)}`);
  await h.idle();
  const invite = lastInvite(h, b.participant_id);
  const acc = await h.tool(b, 'bridge_confirm', invite);
  if (acc.status !== 'delivered') throw new Error(`expected delivered on accept, got ${JSON.stringify(acc)}`);
  await h.idle();
  return c.conversation_id;
}

/** Parse the approval facts out of the latest invite notice a fake participant received. */
export function lastInvite(h: Harness, pid: string): { approval_id: string; kind: 'accept'; peer: string; direction: 'incoming'; topic: string; turn_limit: number } {
  const items = h.fake.inbox(pid).filter((i) => i.notices.some((n) => n.code === 'invite'));
  const item = items.at(-1); if (!item) throw new Error('no invite received');
  const n = item.notices.find((x) => x.code === 'invite')!;
  const text = n.parts.map((p) => p.text).join('\n');
  const id = /approval_id=([0-9A-Z]{26})/.exec(text)![1]!;
  const peer = /peer=([a-z]+:[A-Za-z0-9_-]+)/.exec(text)![1]!;
  const tl = Number(/turn_limit=(\d+)/.exec(text)![1]);
  const topic = (n.parts.find((p) => p.kind === 'untrusted')!).text;
  return { approval_id: id, kind: 'accept', peer, direction: 'incoming', topic, turn_limit: tl };
}
