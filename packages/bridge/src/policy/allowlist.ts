// Allowlist rules (§7.5): `allow|deny <from-pattern> -> <to-pattern> [cwd <prefix>]`, `*` globs on names.
// Patterns are `<agent>:<name>` with `*` allowed in either part, or `*` alone.
import type { ApprovalMode } from '@agentbridge/protocol';

export interface Rule { effect: 'allow' | 'deny'; from: string; to: string; cwd?: string; text: string }

const PAT_RE = /^(\*|[a-z*]+:[A-Za-z0-9_*-]{1,64})$/;

export function parseRule(text: string): Rule {
  const t = text.trim().replace(/\s+/g, ' ');
  const m = /^(allow|deny) (\S+) -> (\S+)(?: cwd (\S.*))?$/.exec(t);
  if (!m) throw new Error(`invalid rule "${text}": expected "allow|deny <from> -> <to> [cwd <prefix>]"`);
  const [, effect, from, to, cwd] = m as unknown as [string, 'allow' | 'deny', string, string, string | undefined];
  for (const p of [from, to]) if (!PAT_RE.test(p)) throw new Error(`invalid pattern "${p}" in rule "${text}"`);
  if (cwd !== undefined && !cwd.startsWith('/')) throw new Error(`cwd prefix must be an absolute path in rule "${text}"`);
  return { effect, from, to, ...(cwd !== undefined ? { cwd } : {}), text: t };
}

function globToRe(g: string): RegExp {
  return new RegExp(`^${g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

export function matchPattern(pattern: string, address: string): boolean {
  if (pattern === '*') return true;
  return globToRe(pattern).test(address);
}

function cwdMatches(prefix: string | undefined, cwd: string | null | undefined): boolean {
  if (prefix === undefined) return true;
  if (!cwd) return false;
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return cwd === prefix || cwd.startsWith(p);
}

export interface RuleSubject {
  from: string; to: string;
  /** cwd of the local (Claude) participant involved, if any. */
  cwd?: string | null;
}

export type AllowDecision = { kind: 'deny'; rule: Rule } | { kind: 'auto'; rule: Rule } | { kind: 'approval' };

/**
 * §7.5 order: a `deny` match → not_allowed in every mode. Else an `allow` match in `auto` → no approval. Else approval.
 * `per_conversation` uses only deny rules; an empty allowlist in `auto` behaves like per_conversation.
 * `autoPermitted` = false applies the relay-origin exception (approval required even on an allow match).
 */
export function decide(rules: readonly Rule[], mode: ApprovalMode, s: RuleSubject, autoPermitted = true): AllowDecision {
  const hit = (r: Rule): boolean => matchPattern(r.from, s.from) && matchPattern(r.to, s.to) && cwdMatches(r.cwd, s.cwd);
  const deny = rules.find((r) => r.effect === 'deny' && hit(r));
  if (deny) return { kind: 'deny', rule: deny };
  if (mode === 'auto' && autoPermitted) {
    const allow = rules.find((r) => r.effect === 'allow' && hit(r));
    if (allow) return { kind: 'auto', rule: allow };
  }
  return { kind: 'approval' };
}
