// Policy document (§15.2): security-relevant settings, stored as DB rows under HMAC + version (§9.3).
import { z } from 'zod';
import { APPROVAL_MODES, LIMITS } from '@agentbridge/protocol';
import { parseRule, type Rule } from './allowlist.ts';

/** Default transport.max_connected_hours_per_day (§13.2). */
export const DEFAULT_MAX_CONNECTED_HOURS = LIMITS.relayMaxConnectedHoursPerDay;

export const zPolicy = z.object({
  approval: z.object({ mode: z.enum(APPROVAL_MODES), timeout_ms: z.number().int().min(10_000).max(24 * 3600_000) }),
  allowlist: z.array(z.string()),
  auto: z.object({ allow_relay_origin: z.boolean() }),
  limits: z.object({ turns: z.number().int().min(1).max(LIMITS.turnLimitMax), inactivity_notice_ms: z.number().int().min(60_000) }),
  queue: z.object({ expiry_ms: z.number().int().min(60_000).max(LIMITS.queueExpiryMs) }),
  invites: z.object({ max_pending_per_remote: z.number().int().min(1).max(100), max_pending_per_target: z.number().int().min(1).max(1000), cooldown_ms: z.number().int().min(0) }),
  delivery: z.object({ allow_bypass_sessions: z.boolean() }),
  discovery: z.object({ relay: z.enum(['names', 'none']) }),
  // relay_mode / max_connected_hours_per_day were added after v1 rows were first signed: defaults keep older
  // signed policies valid (the HMAC covers the stored rows; parsing fills the gaps; the next change writes them out)
  transport: z.object({
    relay_url: z.string().url(),
    relay_mode: z.enum(['on_demand', 'always']).default('on_demand'),
    max_connected_hours_per_day: z.number().int().min(1).max(24).default(DEFAULT_MAX_CONNECTED_HOURS),
  }),
  retention: z.object({ ended_transcripts_ms: z.number().int().min(0) }),
}).strict();
export type Policy = z.infer<typeof zPolicy>;

export const DEFAULT_POLICY: Policy = {
  approval: { mode: 'per_conversation', timeout_ms: LIMITS.approvalTimeoutMs },
  allowlist: [],
  auto: { allow_relay_origin: false },
  limits: { turns: LIMITS.turnLimitDefault, inactivity_notice_ms: LIMITS.inactivityNoticeMs },
  queue: { expiry_ms: LIMITS.queueExpiryMs },
  invites: { max_pending_per_remote: LIMITS.invitesPendingPerRemote, max_pending_per_target: LIMITS.invitesPendingPerTarget, cooldown_ms: LIMITS.inviteCooldownMs },
  delivery: { allow_bypass_sessions: false },
  discovery: { relay: 'names' },
  transport: { relay_url: 'https://relay.musi.live', relay_mode: 'on_demand', max_connected_hours_per_day: DEFAULT_MAX_CONNECTED_HOURS },
  retention: { ended_transcripts_ms: 90 * 24 * 3600_000 },
};

export const PUBLIC_RELAY_HOST = 'relay.musi.live';
export const isSelfHostedRelay = (p: Policy): boolean => {
  try { return new URL(p.transport.relay_url).host !== PUBLIC_RELAY_HOST; } catch { return false; }
};

export function rulesOf(p: Policy): Rule[] { return p.allowlist.map(parseRule); }

/** Parse "10m", "1h", "7d", "30s", "500ms" or plain milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration "${s}" (use e.g. 30s, 10m, 1h, 7d)`);
  const n = Number(m[1]); const unit = m[2] ?? 'ms';
  return n * { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[unit as 'ms' | 's' | 'm' | 'h' | 'd'];
}

export function formatDuration(ms: number): string {
  for (const [u, f] of [['d', 86_400_000], ['h', 3600_000], ['m', 60_000], ['s', 1000]] as const) if (ms % f === 0 && ms >= f) return `${ms / f}${u}`;
  return `${ms}ms`;
}

/** User-facing keys for `config get/set` (§15.2 names). */
const KEYS: Record<string, { path: [keyof Policy, string?]; kind: 'enum' | 'bool' | 'int' | 'duration' | 'string' }> = {
  'approval.mode': { path: ['approval', 'mode'], kind: 'enum' },
  'approval.timeout': { path: ['approval', 'timeout_ms'], kind: 'duration' },
  'auto.allow_relay_origin': { path: ['auto', 'allow_relay_origin'], kind: 'bool' },
  'limits.turns': { path: ['limits', 'turns'], kind: 'int' },
  'limits.inactivity_notice': { path: ['limits', 'inactivity_notice_ms'], kind: 'duration' },
  'queue.expiry': { path: ['queue', 'expiry_ms'], kind: 'duration' },
  'invites.max_pending_per_remote': { path: ['invites', 'max_pending_per_remote'], kind: 'int' },
  'invites.max_pending_per_target': { path: ['invites', 'max_pending_per_target'], kind: 'int' },
  'invites.cooldown': { path: ['invites', 'cooldown_ms'], kind: 'duration' },
  'delivery.allow_bypass_sessions': { path: ['delivery', 'allow_bypass_sessions'], kind: 'bool' },
  'discovery.relay': { path: ['discovery', 'relay'], kind: 'enum' },
  'transport.relay_url': { path: ['transport', 'relay_url'], kind: 'string' },
  'transport.relay_mode': { path: ['transport', 'relay_mode'], kind: 'enum' },
  'transport.max_connected_hours_per_day': { path: ['transport', 'max_connected_hours_per_day'], kind: 'int' },
  'retention.ended_transcripts': { path: ['retention', 'ended_transcripts_ms'], kind: 'duration' },
};
export const CONFIG_KEYS = [...Object.keys(KEYS), 'allowlist.add', 'allowlist.remove'];

/** Apply one `config set <key> <value>` to a copy of the policy; validates the result. */
export function applySetting(p: Policy, key: string, value: string): Policy {
  const next = structuredClone(p) as Policy;
  if (key === 'allowlist.add') { parseRule(value); next.allowlist.push(parseRule(value).text); return zPolicy.parse(next); }
  if (key === 'allowlist.remove') {
    const i = Number(value);
    const idx = Number.isInteger(i) && i >= 1 && i <= next.allowlist.length ? i - 1 : next.allowlist.findIndex((r) => r === parseRule(value).text);
    if (idx < 0) throw new Error(`no allowlist rule "${value}"`);
    next.allowlist.splice(idx, 1); return zPolicy.parse(next);
  }
  const k = KEYS[key];
  if (!k) throw new Error(`unknown setting "${key}"; known: ${CONFIG_KEYS.join(', ')}`);
  let v: unknown;
  switch (k.kind) {
    case 'bool': if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`); v = value === 'true'; break;
    case 'int': if (!/^\d+$/.test(value)) throw new Error(`${key} must be an integer`); v = Number(value); break;
    case 'duration': v = parseDuration(value); break;
    default: v = value;
  }
  const [section, field] = k.path;
  (next[section] as Record<string, unknown>)[field!] = v;
  const r = zPolicy.safeParse(next);
  if (!r.success) throw new Error(`invalid value for ${key}: ${r.error.issues[0]?.message ?? 'invalid'}`);
  return r.data;
}

/** Flatten for display. */
export function describePolicy(p: Policy): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, k] of Object.entries(KEYS)) {
    const [section, field] = k.path; const v = (p[section] as Record<string, unknown>)[field!];
    out[key] = k.kind === 'duration' ? formatDuration(v as number) : String(v);
  }
  p.allowlist.forEach((r, i) => { out[`allowlist.${i + 1}`] = r; });
  return out;
}

/** Policy as DB rows: one row per top-level section, values canonical JSON. */
export function policyToRows(p: Policy): Array<{ key: string; value: string }> {
  return (Object.keys(p) as Array<keyof Policy>).sort().map((k) => ({ key: k, value: canonicalJson(p[k]) }));
}

export function rowsToPolicy(rows: Array<{ key: string; value: string }>): Policy {
  const o: Record<string, unknown> = {};
  for (const r of rows) if (!r.key.startsWith('_')) o[r.key] = JSON.parse(r.value);
  return zPolicy.parse(o);
}

/** Deterministic JSON: sorted object keys, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
