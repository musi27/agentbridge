// Claude Code settings files: effective `crossSessionInbound` (§11.3) and the §11.4 deny rules.
import { readFileSync, readdirSync, writeFileSync, renameSync, statSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userSettingsPath } from './paths.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const INBOUND_VALUES = ['accept', 'hold', 'refuse'] as const;
export type InboundValue = (typeof INBOUND_VALUES)[number];
const STRICTNESS: Record<InboundValue, number> = { accept: 0, hold: 1, refuse: 2 };

export type SettingsSource = 'policySettings' | 'flagSettings' | 'userSettings' | 'localSettings' | 'projectSettings';

/** macOS system-wide managed settings directory (Claude Code docs; the 2.1.330 binary contains this path). */
export const MACOS_MANAGED_DIR = '/Library/Application Support/ClaudeCode';

export interface SettingsPathOptions {
  env?: Env;
  /** Override the managed settings directory (tests). */
  managedDir?: string;
  /** The file passed with `claude --settings <file>`, if known. The bridge usually cannot know it. */
  flagSettingsPath?: string;
}

export interface SettingsFiles {
  /** managed-settings.json, then managed-settings.d/*.json in name order (later files override earlier ones). */
  policySettings: string[];
  flagSettings: string[];
  userSettings: string[];
  localSettings: string[];
  projectSettings: string[];
}

export function claudeSettingsFiles(cwd: string, opts: SettingsPathOptions = {}): SettingsFiles {
  const env = opts.env ?? process.env;
  const managedDir = opts.managedDir ?? MACOS_MANAGED_DIR;
  let dropIns: string[] = [];
  try {
    dropIns = readdirSync(join(managedDir, 'managed-settings.d')).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort()
      .map((f) => join(managedDir, 'managed-settings.d', f));
  } catch { /* no drop-in directory */ }
  return {
    policySettings: [join(managedDir, 'managed-settings.json'), ...dropIns],
    flagSettings: opts.flagSettingsPath ? [opts.flagSettingsPath] : [],
    userSettings: [userSettingsPath(env)],
    localSettings: [join(cwd, '.claude', 'settings.local.json')],
    projectSettings: [join(cwd, '.claude', 'settings.json')],
  };
}

export interface SourceReading { source: SettingsSource; path: string; value?: unknown; error?: string }

export interface EffectiveInbound {
  value: InboundValue;
  /** Which layer decided it. `default` = nothing set anywhere (Claude Code then applies its built-in rules,
   *  which deliver our own-child posts, M0 V2). `invalidSetting` = an unrecognised value is present. */
  decidedBy: 'default' | 'policySettings' | 'flagSettings' | 'userSettings' | 'repoSettings' | 'invalidSetting';
  readings: SourceReading[];
}

function readJson(path: string): { ok: true; data: unknown } | { ok: false; missing: boolean; error: string } {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, missing: code === 'ENOENT' || code === 'ENOTDIR', error: code ?? String(e) };
  }
  try { return { ok: true, data: JSON.parse(text) }; } catch (e) { return { ok: false, missing: false, error: `invalid JSON: ${(e as Error).message}` }; }
}

/** Value of `crossSessionInbound` for one source (multi-file sources: the last file that sets it wins). */
function readSource(source: SettingsSource, files: string[], readings: SourceReading[]): { value?: InboundValue; invalid: boolean } {
  let value: InboundValue | undefined;
  let invalid = false;
  for (const path of files) {
    const r = readJson(path);
    if (!r.ok) { if (!r.missing) readings.push({ source, path, error: r.error }); continue; }
    const v = (r.data && typeof r.data === 'object') ? (r.data as Record<string, unknown>).crossSessionInbound : undefined;
    if (v === undefined) continue;
    readings.push({ source, path, value: v });
    if (typeof v === 'string' && (INBOUND_VALUES as readonly string[]).includes(v)) value = v as InboundValue;
    else invalid = true;
  }
  return value === undefined ? { invalid } : { value, invalid };
}

/**
 * Effective `crossSessionInbound` for a session started in `cwd`, mirroring Claude Code 2.1.330
 * (function read from the shipped binary; Claude Code's docs say the same in prose):
 *  1. The first of managed (policySettings), `--settings` (flagSettings), user settings that sets the key wins
 *     outright: managed and `--settings` override the user's own value.
 *  2. Project `.claude/settings.json` and local `.claude/settings.local.json` may only tighten
 *     (accept < hold < refuse): a stricter repo value replaces it, a looser one is ignored.
 *  3. If any file has an unrecognised value, and the result is looser than `hold`, the result is `hold`
 *     (Claude Code drops the bad value, warns, and holds messages while it is present).
 *
 * Known gaps (documented, not guessed):
 *  - MDM configuration profiles and server-delivered managed settings are not readable here; only the managed
 *    settings files are.
 *  - `--settings` and `--setting-sources` are per-launch flags the bridge cannot see; pass flagSettingsPath if known.
 *    `--setting-sources` excluding project/local would make the real value looser than reported (we err strict).
 *  - The project root is taken to be the session's cwd, which is what Claude Code uses for `.claude/settings*.json`
 *    when launched there; a session launched in a subfolder of a repo is reported with that subfolder's files.
 *  - Within managed-settings.d, we let the last file (name order) override earlier ones; Claude Code documents
 *    drop-ins as merged in name order on top of managed-settings.json.
 *  - Malformed JSON makes Claude Code ignore that file; we do the same (reported in `readings`).
 */
export function readEffectiveCrossSessionInbound(cwd: string, opts: SettingsPathOptions = {}): EffectiveInbound {
  const files = claudeSettingsFiles(cwd, opts);
  const readings: SourceReading[] = [];
  let value: InboundValue | undefined;
  let decidedBy: EffectiveInbound['decidedBy'] = 'default';
  let invalid = false;
  for (const source of ['policySettings', 'flagSettings', 'userSettings'] as const) {
    const r = readSource(source, files[source], readings);
    invalid ||= r.invalid;
    if (value === undefined && r.value !== undefined) { value = r.value; decidedBy = source; }
  }
  for (const source of ['localSettings', 'projectSettings'] as const) {
    const r = readSource(source, files[source], readings);
    invalid ||= r.invalid;
    if (r.value === undefined) continue;
    if (STRICTNESS[r.value] > STRICTNESS[value ?? 'accept']) { value = r.value; decidedBy = 'repoSettings'; }
    else if (r.value !== 'accept' && value !== undefined && r.value === value && decidedBy !== 'policySettings') decidedBy = 'repoSettings';
  }
  if (invalid && STRICTNESS[value ?? 'accept'] < STRICTNESS.hold) { value = 'hold'; decidedBy = 'invalidSetting'; }
  return { value: value ?? 'accept', decidedBy, readings };
}

/** One-line fix for a hold/refuse result, for doctor and popups. */
export function inboundFix(e: EffectiveInbound): string {
  switch (e.decidedBy) {
    case 'policySettings': return 'Your organization\'s managed settings set crossSessionInbound; ask your admin to allow "accept".';
    case 'repoSettings': return 'Remove crossSessionInbound from this project\'s .claude/settings.json or .claude/settings.local.json (a project can only tighten it).';
    case 'invalidSetting': return 'A Claude Code settings file has an unrecognised crossSessionInbound value; set it to "accept".';
    default: return `Set "crossSessionInbound": "accept" in ${userSettingsPath()} (or remove the setting).`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Deny rules (§11.4). Defence in depth only: user presence (§9.2) is the real barrier.

const PRIVILEGED_SUBCOMMANDS = ['config', 'approve', 'decline', 'extend', 'revoke', 'remove', 'add', 'purge', 'identity', 'show', 'end', 'stop', 'uninstall'] as const;

/**
 * The deny list `init` writes. "Writes and edits under ~/.agentbridge/**" is a single `Edit(...)` rule:
 * in Claude Code 2.1.330 `Edit(path)` rules cover every file-editing tool, and a `Write(path)` rule is
 * reported as "not matched by file permission checks — only Edit(path) rules are" (string in the binary).
 */
export const DENY_RULES: readonly string[] = [
  ...PRIVILEGED_SUBCOMMANDS.map((s) => `Bash(agentbridge ${s}:*)`),
  'Edit(~/.agentbridge/**)',
];

export interface DenyRuleStatus { path: string; present: string[]; missing: string[]; error?: string }

function readSettingsObject(path: string): { data: Record<string, unknown>; existed: boolean } {
  const r = readJson(path);
  if (!r.ok) {
    if (r.missing) return { data: {}, existed: false };
    throw new Error(`cannot read ${path}: ${r.error}`);
  }
  if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) throw new Error(`${path} is not a JSON object`);
  return { data: r.data as Record<string, unknown>, existed: true };
}

function denyList(data: Record<string, unknown>): string[] {
  const perms = data.permissions;
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return [];
  const deny = (perms as Record<string, unknown>).deny;
  return Array.isArray(deny) ? deny.filter((x): x is string => typeof x === 'string') : [];
}

/** Which §11.4 deny rules are present in a Claude Code settings file (default: the user's). */
export function checkDenyRules(path: string = userSettingsPath()): DenyRuleStatus {
  try {
    const have = new Set(denyList(readSettingsObject(path).data));
    return { path, present: DENY_RULES.filter((r) => have.has(r)), missing: DENY_RULES.filter((r) => !have.has(r)) };
  } catch (e) {
    return { path, present: [], missing: [...DENY_RULES], error: (e as Error).message };
  }
}

/**
 * Add any missing §11.4 deny rules to a Claude Code settings file (default: the user's), keeping every other
 * setting and existing rule as is. Idempotent: writes nothing when all rules are present. Refuses to touch a
 * file that is not valid JSON. Writes atomically (temp file + rename) and keeps the file mode. A symlinked
 * settings file (dotfile managers) stays a symlink: we write through to its real target.
 */
export function installDenyRules(path: string = userSettingsPath()): { path: string; added: string[] } {
  const { data, existed } = readSettingsObject(path);
  const current = denyList(data);
  const added = DENY_RULES.filter((r) => !current.includes(r));
  if (added.length === 0) return { path, added };
  const permsRaw = data.permissions;
  if (permsRaw !== undefined && (typeof permsRaw !== 'object' || permsRaw === null || Array.isArray(permsRaw))) {
    throw new Error(`${path}: "permissions" is not an object`);
  }
  const perms = { ...(permsRaw as Record<string, unknown> | undefined) };
  const denyRaw = perms.deny;
  if (denyRaw !== undefined && !Array.isArray(denyRaw)) throw new Error(`${path}: "permissions.deny" is not an array`);
  perms.deny = [...((denyRaw as unknown[] | undefined) ?? []), ...added];
  writeSettingsObject(path, { ...data, permissions: perms }, existed);
  return { path, added };
}

/** Atomic write (temp file + rename) that keeps the file mode and writes through a symlinked settings file. */
function writeSettingsObject(path: string, next: Record<string, unknown>, existed: boolean): void {
  let mode = 0o600;
  let target = path;
  if (existed) {
    target = realpathSync(path); // rename onto the real file, never over the symlink
    try { mode = statSync(target).mode & 0o777; } catch { /* keep default */ }
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.agentbridge-${process.pid}.tmp`; // same directory as the target, so rename stays atomic
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode });
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

/**
 * Remove the §11.4 deny rules `init` wrote (`agentbridge uninstall`), keeping every other setting and rule as is.
 * Idempotent: a missing file or no matching rules writes nothing. Refuses to touch a file that is not valid JSON.
 * An emptied `permissions.deny` stays as an empty array, so the file's shape is otherwise unchanged.
 */
export function removeDenyRules(path: string = userSettingsPath()): { path: string; removed: string[] } {
  const { data, existed } = readSettingsObject(path);
  if (!existed) return { path, removed: [] };
  const permsRaw = data.permissions;
  if (!permsRaw || typeof permsRaw !== 'object' || Array.isArray(permsRaw)) return { path, removed: [] };
  const denyRaw = (permsRaw as Record<string, unknown>).deny;
  if (!Array.isArray(denyRaw)) return { path, removed: [] };
  const ours = new Set(DENY_RULES);
  const removed = DENY_RULES.filter((r) => denyRaw.includes(r));
  if (removed.length === 0) return { path, removed };
  const perms = { ...(permsRaw as Record<string, unknown>), deny: denyRaw.filter((x) => !(typeof x === 'string' && ours.has(x))) };
  writeSettingsObject(path, { ...data, permissions: perms }, existed);
  return { path, removed };
}

/** Is Claude Code configured to run in bare mode (`--bare` sets CLAUDE_CODE_SIMPLE=1; plugins' hooks then don't run)? */
export function bareModeConfigured(env: Env = process.env, settingsPath: string = userSettingsPath(env)): { bare: boolean; where?: string } {
  const truthy = (v: unknown): boolean => typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim());
  if (truthy(env.CLAUDE_CODE_SIMPLE)) return { bare: true, where: 'environment (CLAUDE_CODE_SIMPLE)' };
  try {
    const envBlock = readSettingsObject(settingsPath).data.env;
    if (envBlock && typeof envBlock === 'object' && truthy((envBlock as Record<string, unknown>).CLAUDE_CODE_SIMPLE)) {
      return { bare: true, where: `${settingsPath} env.CLAUDE_CODE_SIMPLE` };
    }
  } catch { /* unreadable settings: not evidence of bare mode */ }
  return { bare: false };
}

