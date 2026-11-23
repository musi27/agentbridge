// Bridge side of the CLI (§14, §9.2). Unprivileged methods answer directly; privileged ones run the bridge-owned
// user-presence check first (no bearer token from the CLI). While policy integrity has failed (§9.3) only
// status, doctor, config get and config verify stay available.
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { CLI_METHODS, shortId, type CliMethod, type IpcError } from '@agentbridge/protocol';
import { BRIDGE_VERSION, type Engine } from '../core/engine.ts';
import { applySetting, describePolicy, isSelfHostedRelay, parseDuration } from '../policy/policy.ts';
import { resolveAddress } from '../core/rules.ts';
import { GrokSetupError, type GrokSetup } from '../grok/setup.ts';

export interface CliContext {
  engine: Engine;
  /** Paths for doctor checks. */
  paths?: { db: string; socket: string; runDir: string };
  pid?: number;
  startedAt?: number;
  /** Grok setup, revoke and round trip (§12.5); absent → those commands report that Grok support is not loaded. */
  grok?: GrokSetup;
  /** Platform checks (Claude Code, helper, launchd, relay) added by the service; see src/doctor.ts. */
  doctorExtras?: () => Promise<Array<{ id: string; ok: boolean; detail: string; fix?: string }>>;
}

type Out = { result?: unknown; error?: IpcError };
const ok = (result: unknown): Out => ({ result });
const bad = (code: IpcError['code'], message: string): Out => ({ error: { code, message } });

const zId = z.object({ conversation_id: z.string() });
const SCHEMAS: Partial<Record<CliMethod, z.ZodType>> = {
  'cli.logs': z.object({ limit: z.number().int().min(1).max(1000).optional(), since_id: z.number().int().optional(), type: z.string().optional() }),
  'cli.open': z.object({ address: z.string() }),
  'cli.show': zId.extend({ before_seq: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional() }),
  'cli.end': z.union([zId, z.object({ inactive: z.string() })]),
  'cli.extend': zId.extend({ add_turns: z.number().int().min(1).max(200) }),
  'cli.approve': z.object({ approval_id: z.string() }),
  'cli.decline': z.object({ approval_id: z.string() }),
  'cli.config_set': z.object({ key: z.string(), value: z.string() }),
  'cli.config_verify': z.object({ action: z.enum(['show', 'reapprove', 'restore']) }),
  'cli.remove': z.object({ address: z.string() }),
  'cli.purge': z.object({ before: z.string().optional() }),
  'cli.doctor': z.object({ round_trip: z.string().optional() }),
  'cli.add_grok': z.discriminatedUnion('step', [
    z.object({ step: z.literal('begin'), name: z.string().min(1).max(256) }),
    z.object({ step: z.literal('webhook'), setup_id: z.string(), webhook_url: z.string().max(2048), webhook_key: z.string().max(2048) }),
    z.object({ step: z.literal('check'), setup_id: z.string() }),
    z.object({ step: z.literal('abort'), setup_id: z.string() }),
  ]),
  'cli.revoke': z.union([
    z.object({ step: z.literal('check'), setup_id: z.string() }),
    z.object({ step: z.literal('begin').optional(), address: z.string() }),
  ]),
};
const ALLOWED_WHILE_TAMPERED: ReadonlySet<CliMethod> = new Set(['cli.status', 'cli.doctor', 'cli.config_get', 'cli.config_verify']);
const NOT_YET: ReadonlySet<CliMethod> = new Set(['cli.identity_rotate']);
/** Follow-up steps of a Grok setup/revoke flow: authorised by the setup id from the presence-checked first step. */
const isFollowUp = (m: CliMethod, p: Record<string, unknown>): boolean => (m === 'cli.add_grok' || m === 'cli.revoke') && p['step'] !== undefined && p['step'] !== 'begin';

/**
 * Reason shown in the Touch ID dialog. macOS renders it as "<app> is trying to <reason>.", so it
 * must be a lowercase verb phrase with no "agentbridge:" prefix.
 */
export function presenceReason(m: CliMethod, p: Record<string, unknown>, engine: Pick<Engine, 'approvals'>): string {
  switch (m) {
    case 'cli.approve': {
      const a = engine.approvals.get(String(p['approval_id']));
      if (!a) return 'approve an agentbridge request';
      const what = a.facts.kind === 'extend' ? 'a longer agentbridge conversation' : 'an agentbridge conversation';
      return `approve ${what} with ${a.facts.peer} (turn limit ${a.facts.turn_limit})`;
    }
    case 'cli.decline': return 'decline an agentbridge request';
    case 'cli.config_set': return `change the agentbridge setting ${String(p['key'])}`;
    case 'cli.config_verify': return 'verify the agentbridge policy';
    case 'cli.show': return 'show an agentbridge transcript';
    case 'cli.end': return 'end agentbridge conversations';
    case 'cli.extend': return 'raise an agentbridge turn limit';
    case 'cli.stop': return 'stop the agentbridge service';
    case 'cli.remove': return `remove ${String(p['address'])} from agentbridge`;
    case 'cli.purge': return 'delete ended agentbridge transcripts';
    case 'cli.revoke': return `revoke the agentbridge token of ${String(p['address'] ?? 'a bot')} and make a new one`;
    case 'cli.add_grok': return 'add a Grok bot to agentbridge';
    case 'cli.identity_rotate': return 'rotate the agentbridge identity keys';
    default: return `run the agentbridge command ${m.slice(4).replace(/_/g, ' ')}`;
  }
}

export async function handleCli(ctx: CliContext, method: CliMethod, raw: unknown): Promise<Out> {
  const { engine } = ctx;
  const schema = SCHEMAS[method];
  const parsed = schema ? schema.safeParse(raw) : { success: true as const, data: {} };
  if (!parsed.success) return bad('invalid_message', `invalid parameters for ${method}`);
  const p = parsed.data as Record<string, unknown>;
  if (!engine.policyStore.current().ok && !ALLOWED_WHILE_TAMPERED.has(method)) return bad('policy_tampered', 'policy integrity check failed; only status, doctor and config verify are available. Run: agentbridge config verify');
  if (NOT_YET.has(method)) return bad('internal', `${method.slice(4)} is not available in this build (needs the relay, M2)`);
  if (CLI_METHODS[method].privileged && !isFollowUp(method, p)) {
    const denied = await engine.requirePresence(presenceReason(method, p, engine));
    if (denied) return denied;
  }
  const store = engine.store;
  const addr = (id: string): string => { const x = store.participant(id); return x ? `${x.agent}:${x.name}` : '?'; };

  switch (method) {
    case 'cli.status': {
      const parts = store.participants().filter((x) => x.state !== 'gone');
      const convs = store.conversations();
      const ps = engine.policyStore.current();
      const popups = store.unshownPopups(); store.markShown(popups.map((x) => x.id));
      return ok({
        bridge_version: BRIDGE_VERSION, pid: ctx.pid ?? process.pid, started_at: ctx.startedAt ? new Date(ctx.startedAt).toISOString() : null,
        policy: ps.ok ? { ok: true, version: ps.version, mode: ps.policy.approval.mode } : { ok: false, reason: ps.reason, detail: ps.detail },
        participants: parts.map((x) => ({ address: `${x.agent}:${x.name}`, ...(x.title ? { title: x.title } : {}), short_id: shortId(x.id), state: x.state, permission_mode: x.permission_mode, ...(x.cwd ? { folder: basename(x.cwd) } : {}) })),
        auto_mode_sessions: parts.filter((x) => x.permission_mode === 'auto').map((x) => `${x.agent}:${x.name}`),
        conversations: { pending: convs.filter((c) => c.state === 'pending').length, active: convs.filter((c) => c.state === 'active').length, ended: convs.filter((c) => c.state === 'ended').length },
        queued_deliveries: store.pendingDeliveries().length,
        pending_approvals: engine.pendingApprovals(),
        live_connections: engine.liveConnections(),
        notifications: popups.map((x) => ({ at: new Date(x.ts).toISOString(), ...(JSON.parse(x.data) as object) })),
      });
    }
    case 'cli.agents':
      return ok(store.participants().map((x) => ({ address: `${x.agent}:${x.name}`, ...(x.title ? { title: x.title } : {}), short_id: shortId(x.id), state: x.state, permission_mode: x.permission_mode, ...(x.cwd ? { folder: basename(x.cwd) } : {}), session_id: x.session_id })));
    case 'cli.conversations':
      return ok(store.conversations().map((c) => ({
        id: c.id, initiator: addr(c.initiator_id), invitee: addr(c.invitee_id), topic: c.topic, state: c.state, end_reason: c.end_reason,
        turns: `${c.turn_count}/${c.turn_limit}`, origin: c.origin, queued: !!c.queued, updated_at: new Date(c.updated_at).toISOString(),
      })));
    case 'cli.doctor': {
      const checks: Array<{ id: string; ok: boolean; detail: string; fix?: string }> = [];
      const ps = engine.policyStore.current();
      checks.push(ps.ok ? { id: 'policy', ok: true, detail: `policy v${ps.version} verified` } : { id: 'policy', ok: false, detail: ps.detail, fix: 'agentbridge config verify' });
      if (ctx.paths) {
        const mode = (f: string): number | null => (existsSync(f) ? statSync(f).mode & 0o777 : null);
        const db = mode(ctx.paths.db); const sock = mode(ctx.paths.socket); const run = mode(ctx.paths.runDir);
        checks.push({ id: 'db_permissions', ok: db === 0o600, detail: `database mode ${db?.toString(8) ?? 'missing'}` });
        checks.push({ id: 'socket_permissions', ok: sock === 0o600 && run === 0o700, detail: `socket ${sock?.toString(8) ?? 'missing'}, run dir ${run?.toString(8) ?? 'missing'}` });
      }
      for (const x of store.participants()) {
        if (x.state === 'unreachable') checks.push({ id: `inbound:${x.agent}:${x.name}`, ok: false, detail: `crossSessionInbound is ${x.inbound}`, fix: 'set crossSessionInbound to "accept" in Claude Code settings' });
        if (x.permission_mode === 'auto' && x.state === 'live') checks.push({ id: `auto_mode:${x.agent}:${x.name}`, ok: true, detail: 'session runs in auto mode: Claude Code may not ask before shell commands; prefer default mode for sessions that talk to other agents' });
      }
      if (ctx.doctorExtras) {
        try { checks.push(...(await ctx.doctorExtras())); }
        catch (e) { checks.push({ id: 'platform_checks', ok: false, detail: `platform checks failed: ${(e as Error).message}` }); }
      }
      const grokAdapter = engine.adapterFor('grok');
      if (grokAdapter) { try { checks.push(...await grokAdapter.doctor()); } catch (x) { checks.push({ id: 'grok', ok: false, detail: `Grok checks failed: ${(x as Error).message}` }); } }
      if (p['round_trip'] !== undefined) {
        if (!ctx.grok) return bad('internal', 'Grok support is not loaded in this bridge');
        const pid = grokParticipant(engine, String(p['round_trip']));
        if (typeof pid !== 'string') return pid;
        try { return ok({ checks, round_trip: await ctx.grok.roundTrip(pid) }); } catch (x) { return grokError(x); }
      }
      return ok({ checks });
    }
    case 'cli.logs': {
      const rows = store.events({ ...(p['limit'] !== undefined ? { limit: p['limit'] as number } : {}), ...(p['since_id'] !== undefined ? { sinceId: p['since_id'] as number } : {}), ...(p['type'] ? { type: p['type'] as string } : {}) });
      return ok(rows.map((r) => ({ id: r.id, at: new Date(r.ts).toISOString(), level: r.level, type: r.type, participant: r.participant_id ? addr(r.participant_id) : undefined, conversation_id: r.conversation_id ?? undefined, data: JSON.parse(r.data) as unknown })));
    }
    case 'cli.open': {
      const r = resolveAddress(store.participants().map((x) => ({ id: x.id, agent: x.agent, name: x.name, state: x.state, cwd: x.cwd })), String(p['address']), { local: true });
      if (!r.ok) return bad(r.reason, r.reason === 'recipient_ambiguous' ? `ambiguous: ${r.candidates!.map((c) => `${c.address} (${c.short_id}${c.folder ? `, ${c.folder}` : ''})`).join('; ')}` : 'no such participant');
      const x = store.participant(r.id)!;
      if ((x.agent !== 'claude' && x.agent !== 'codex') || !x.session_id) return bad('invalid_message', 'only Claude Code and Codex sessions with a known session id can be reopened');
      return ok({ command: x.agent === 'codex' ? `codex resume ${x.session_id}` : `claude --resume ${x.session_id}`, cwd: x.cwd });
    }
    case 'cli.config_get': {
      const ps = engine.policyStore.current();
      return ok(ps.ok ? { version: ps.version, settings: describePolicy(ps.policy), self_hosted_relay: isSelfHostedRelay(ps.policy) } : { tampered: true, reason: ps.reason });
    }
    case 'cli.config_set': {
      try {
        const next = applySetting(engine.policyStore.policy(), String(p['key']), String(p['value']));
        const version = await engine.policyStore.set(next);
        engine.event('info', 'policy_changed', { key: p['key'], version });
        return ok({ version, settings: describePolicy(next) });
      } catch (x) { return bad('invalid_message', (x as Error).message); }
    }
    case 'cli.config_verify': {
      const action = p['action'] as 'show' | 'reapprove' | 'restore';
      if (action === 'show') {
        const i = await engine.policyStore.inspect();
        return ok({ state: i.state.ok ? 'ok' : i.state.reason, current: i.current ? describePolicy(i.current) : null, last_verified: i.lastVerified ? describePolicy(i.lastVerified) : null });
      }
      try {
        const version = action === 'reapprove' ? await engine.policyStore.reapproveCurrent() : await engine.policyStore.restoreLastVerified();
        engine.event('warning', 'policy_verified', { action, version });
        engine.resumeAfterVerify();
        return ok({ version, action });
      } catch (x) { return bad('invalid_message', (x as Error).message); }
    }
    case 'cli.show': {
      const c = store.conversation(String(p['conversation_id']));
      if (!c) return bad('unknown_conversation', 'no such conversation');
      return ok({ id: c.id, initiator: addr(c.initiator_id), invitee: addr(c.invitee_id), topic: c.topic, state: c.state, end_reason: c.end_reason, turns: `${c.turn_count}/${c.turn_limit}`,
        ...engine.transcriptPage(c, null, p['before_seq'] as number | undefined, p['limit'] as number | undefined) });
    }
    case 'cli.end': {
      if ('inactive' in p) {
        let ms: number;
        try { ms = parseDuration(String(p['inactive'])); } catch (x) { return bad('invalid_message', (x as Error).message); }
        const cutoff = engine.clock.now() - ms; const ended: string[] = [];
        for (const c of store.conversations()) if (c.state !== 'ended' && c.updated_at <= cutoff) { engine.endManual(c.id); ended.push(c.id); }
        return ok({ ended });
      }
      const r = engine.endManual(String(p['conversation_id']));
      return r.status === 'failed' ? bad(r.reason!, r.reason!) : ok(r);
    }
    case 'cli.extend': {
      const r = engine.extendManual(String(p['conversation_id']), p['add_turns'] as number);
      return r.status === 'failed' ? bad(r.reason!, r.hint ?? r.reason!) : ok(r);
    }
    case 'cli.approve': {
      const r = await engine.approveById(String(p['approval_id']));
      return r.status === 'failed' ? bad(r.reason!, r.hint ?? r.reason!) : ok(r);
    }
    case 'cli.decline': {
      const r = engine.declineById(String(p['approval_id']));
      return r.status === 'failed' ? bad(r.reason!, r.reason!) : ok(r);
    }
    case 'cli.remove': {
      const r = resolveAddress(store.participants().map((x) => ({ id: x.id, agent: x.agent, name: x.name, state: x.state, cwd: x.cwd })), String(p['address']), { local: true });
      if (!r.ok) return bad(r.reason, 'no such participant (or ambiguous; use <agent>:<short_id>)');
      // a Grok bot also leaves the relay (revoke_bot) and the keychain
      const retired = store.participant(r.id)?.agent === 'grok' && ctx.grok ? await ctx.grok.retire(r.id) : {};
      engine.removeParticipant(r.id);
      return ok({ removed: p['address'], ...retired });
    }
    case 'cli.purge': {
      let before = engine.clock.now() - engine.policyStore.policy().retention.ended_transcripts_ms;
      if (p['before']) { try { before = engine.clock.now() - parseDuration(String(p['before'])); } catch (x) { return bad('invalid_message', (x as Error).message); } }
      return ok({ purged: engine.purgeEnded(before) });
    }
    case 'cli.stop':
      setImmediate(() => engine.requestStop());
      return ok({ stopping: true });
    case 'cli.add_grok': case 'cli.revoke': {
      const g = ctx.grok;
      if (!g) return bad('internal', 'Grok support is not loaded in this bridge');
      try {
        if (method === 'cli.add_grok') {
          if (p['step'] === 'begin') return ok(await g.begin(String(p['name'])));
          if (p['step'] === 'webhook') return ok(await g.saveWebhook(String(p['setup_id']), String(p['webhook_url']), String(p['webhook_key'])));
          if (p['step'] === 'abort') return ok(await g.abort(String(p['setup_id'])));
        }
        if (p['step'] === 'check') {
          const s = g.session(p['setup_id'], method === 'cli.add_grok' ? ['add'] : ['revoke']);
          if (!s) return bad('not_allowed', 'this setup has expired; start again');
          return ok(await g.roundTrip(s.participant_id));
        }
        const pid = grokParticipant(engine, String(p['address']));
        if (typeof pid !== 'string') return pid;
        return ok(await g.rotate(pid));
      } catch (x) { return grokError(x); }
    }
    default:
      return bad('method_not_found', method);
  }
}

function grokParticipant(engine: Engine, address: string): string | Out {
  const r = resolveAddress(engine.store.participants().map((x) => ({ id: x.id, agent: x.agent, name: x.name, state: x.state, cwd: x.cwd })), address, { local: true });
  if (!r.ok) return bad(r.reason, 'no such Grok bot (use grok:<name>)');
  const x = engine.store.participant(r.id);
  if (!x || x.agent !== 'grok') return bad('invalid_message', `${address} is not a Grok bot`);
  return x.id;
}

function grokError(x: unknown): Out {
  if (x instanceof GrokSetupError) return bad(x.code, x.message);
  return bad('internal', (x as Error)?.message ?? String(x));
}
