// Bridge-side Claude Code adapter (§11.1): renders framing and hands posts to the participant's plugin link.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { LIMITS, NONCE_RE, renderMessage, renderNotice, ulid } from '@agentbridge/protocol';
import type {
  Adapter, AdapterCapabilities, DeliverOutcome, DoctorCheck, LinkLookup, OutboundItem, ParticipantRef,
} from '@agentbridge/protocol';
import { bareModeConfigured, checkDenyRules, inboundFix, readEffectiveCrossSessionInbound } from './settings.ts';
import type { SettingsPathOptions } from './settings.ts';
import { userSettingsPath } from './paths.ts';
import { PLUGIN_VERSION } from './version.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface ClaudeCodeAdapterOptions {
  /** Runs `claude --version`; resolves its stdout. Injected in tests. */
  claudeVersion?: () => Promise<string>;
  /** Runs `node --version` (the `node` on PATH, which runs the plugin); resolves its stdout. Injected in tests. */
  nodeVersion?: () => Promise<string>;
  /** Folders whose project settings doctor should also check (e.g. live participants' cwds). Default: none. */
  doctorCwds?: () => string[];
  env?: Env;
  settings?: Omit<SettingsPathOptions, 'env'>;
  /** Override the delivery timeout (default: posts × (200 ms spacing + 2 s write) + 5 s). */
  deliverTimeoutMs?: (posts: number) => number;
  /** How many item_ids to remember handed-off posts for (retry de-duplication). Default 1000. */
  handedOffMemory?: number;
}

/** Per-post budget: the plugin's spacing plus its inbox write timeout. */
const POST_BUDGET_MS = LIMITS.inboxPostSpacingMs + 2000;
const deliverTimeout = (posts: number): number => posts * POST_BUDGET_MS + 5000;

/** "2.1.330 (Claude Code)" -> [2,1,330]. */
export function parseVersion(s: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(have: string, min: string): boolean {
  const a = parseVersion(have);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i]! !== b[i]!) return a[i]! > b[i]!; }
  return true;
}

function versionOf(cmd: string, env: Env): () => Promise<string> {
  return () => new Promise((resolve, reject) => {
    execFile(cmd, ['--version'], { timeout: 10_000, env: env as NodeJS.ProcessEnv }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** The plugin's runtime needs Node >= 24 (repo engines; the bundles target node24). */
export const MIN_NODE_VERSION = '24.0.0';

export class ClaudeCodeAdapter implements Adapter {
  readonly #links: LinkLookup;
  readonly #o: ClaudeCodeAdapterOptions;
  /** item_id -> indexes of its posts already handed off. In memory, LRU-bounded: lets a retry of a partly
   *  delivered item skip the posts that already reached the inbox (item_id is stable across retries). */
  readonly #handedOff = new Map<string, Set<number>>();

  constructor(links: LinkLookup, opts: ClaudeCodeAdapterOptions = {}) {
    this.#links = links;
    this.#o = opts;
  }

  describe(): { name: string; version: string; agent: 'claude' } {
    return { name: 'claude-code', version: PLUGIN_VERSION, agent: 'claude' };
  }

  capabilities(): AdapterCapabilities {
    return { receive: 'inbox_push', native_confirm: true, delivery_confirmable: false };
  }

  /** The texts one item becomes: one post per message (seq order), then one per notice. All unique (§8.1). */
  renderPosts(item: OutboundItem, nonce: string): string[] {
    const posts: string[] = [];
    const conv = item.conversation;
    if (item.messages.length > 0 && !conv) throw new Error('messages without a conversation');
    for (const m of [...item.messages].sort((a, b) => a.seq - b.seq)) {
      posts.push(renderMessage({
        nonce, conversationId: conv!.id, from: m.from_address, turn: m.turn ?? conv!.turn, turnLimit: conv!.turn_limit, id: m.message_id, body: m.body,
      }));
    }
    for (const n of item.notices) {
      posts.push(renderNotice({ nonce, code: n.code, severity: n.severity, id: n.id, parts: n.parts, ...(conv ? { conversationId: conv.id } : {}) }));
    }
    // Claude Code drops a post identical to the previous one (M0 V2); ids make them unique, and we never send twins.
    return [...new Set(posts)];
  }

  #remember(itemId: string): Set<number> {
    let set = this.#handedOff.get(itemId);
    if (set) this.#handedOff.delete(itemId); // re-insert: most recently used last
    else set = new Set();
    this.#handedOff.set(itemId, set);
    const cap = this.#o.handedOffMemory ?? 1000;
    while (this.#handedOff.size > cap) this.#handedOff.delete(this.#handedOff.keys().next().value!);
    return set;
  }

  async deliver(item: OutboundItem, to: ParticipantRef): Promise<DeliverOutcome> {
    const nonce = to.tag_nonce;
    if (!nonce || !NONCE_RE.test(nonce)) return { status: 'failed', reason: 'invalid_message', hint: 'participant has no valid tag nonce', retryable: false };
    let texts: string[];
    try { texts = this.renderPosts(item, nonce); } catch (e) {
      return { status: 'failed', reason: 'invalid_message', hint: (e as Error).message, retryable: false };
    }
    if (texts.length === 0) return { status: 'handed_off' };
    const done = this.#handedOff.get(item.item_id);
    const todo = texts.map((text, index) => ({ index, text })).filter((p) => !done?.has(p.index));
    if (todo.length === 0) { this.#remember(item.item_id); return { status: 'handed_off' }; } // retry of a finished item
    const link = this.#links(to.participant_id);
    // No live plugin connection: never post as a peer (§11.3 fallback); keep it queued until the session reconnects.
    if (!link) return { status: 'queued', reason: 'recipient_unreachable', hint: 'the Claude Code session is not connected' };
    const posts = todo.map((p) => ({ post_id: ulid(), text: p.text, index: p.index }));
    const timeoutMs = (this.#o.deliverTimeoutMs ?? deliverTimeout)(posts.length);
    let timer: NodeJS.Timeout | undefined;
    let results: Array<{ post_id: string; ok: boolean; error?: string }>;
    try {
      results = await Promise.race([
        link.deliver(posts.map(({ post_id, text }) => ({ post_id, text }))),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no post results within ${timeoutMs} ms`)), timeoutMs); }),
      ]);
    } catch (e) {
      return { status: 'failed', reason: 'recipient_unreachable', hint: `plugin link failed: ${(e as Error).message}`, retryable: true };
    } finally {
      clearTimeout(timer);
    }
    const byId = new Map(results.map((r) => [r.post_id, r]));
    const handed = this.#remember(item.item_id);
    for (const p of posts) if (byId.get(p.post_id)?.ok === true) handed.add(p.index);
    if (handed.size === texts.length) return { status: 'handed_off' }; // writes never confirm delivery (M0 V2)
    const firstErr = results.find((r) => !r.ok)?.error;
    return {
      status: 'failed', reason: 'recipient_unreachable', retryable: true,
      hint: `${handed.size} of ${texts.length} inbox posts handed off${firstErr ? `; ${firstErr}` : ''}; a retry of this item sends only the rest`,
    };
  }

  async doctor(): Promise<DoctorCheck[]> {
    const env = this.#o.env ?? process.env;
    const settingsOpts: SettingsPathOptions = { ...this.#o.settings, env };
    const checks: DoctorCheck[] = [];

    // Claude Code version
    try {
      const out = await (this.#o.claudeVersion ?? versionOf('claude', env))();
      const v = parseVersion(out);
      const ok = v !== null && versionAtLeast(out, LIMITS.minClaudeCodeVersion);
      checks.push({
        id: 'claude_code_version', ok,
        detail: v ? `Claude Code ${v.join('.')} (minimum ${LIMITS.minClaudeCodeVersion})` : `could not parse \`claude --version\`: ${out.trim().slice(0, 80)}`,
        ...(ok ? {} : { fix: `Update Claude Code to ${LIMITS.minClaudeCodeVersion} or newer (\`claude update\`).` }),
      });
    } catch (e) {
      checks.push({ id: 'claude_code_version', ok: false, detail: `\`claude --version\` failed: ${(e as Error).message}`, fix: 'Install Claude Code and make sure `claude` is on PATH.' });
    }

    // node on PATH: Claude Code starts the plugin's MCP server and hooks with `node`
    try {
      const out = await (this.#o.nodeVersion ?? versionOf('node', env))();
      const v = parseVersion(out);
      const ok = v !== null && versionAtLeast(out, MIN_NODE_VERSION);
      checks.push({
        id: 'node_version', ok,
        detail: v ? `node ${v.join('.')} on PATH (minimum ${MIN_NODE_VERSION.split('.')[0]})` : `could not parse \`node --version\`: ${out.trim().slice(0, 80)}`,
        ...(ok ? {} : { fix: 'Install Node.js 24 or newer and make sure it is the `node` on PATH for Claude Code.' }),
      });
    } catch (e) {
      checks.push({ id: 'node_version', ok: false, detail: `\`node --version\` failed: ${(e as Error).message}`, fix: 'Install Node.js 24 or newer and put `node` on PATH.' });
    }

    // crossSessionInbound: user level (home folder) plus any folders we were told about
    const cwds = [homedir(), ...(this.#o.doctorCwds?.() ?? [])];
    for (const cwd of [...new Set(cwds)]) {
      const eff = readEffectiveCrossSessionInbound(cwd, settingsOpts);
      const ok = eff.value === 'accept';
      checks.push({
        id: cwd === homedir() ? 'cross_session_inbound' : `cross_session_inbound:${cwd}`, ok,
        detail: `crossSessionInbound = ${eff.value} (${eff.decidedBy})${cwd === homedir() ? '' : ` for ${cwd}`}`,
        ...(ok ? {} : { fix: inboundFix(eff) }),
      });
    }

    // deny rules in the user's settings
    const deny = checkDenyRules(userSettingsPath(env));
    checks.push({
      id: 'deny_rules', ok: deny.missing.length === 0 && !deny.error,
      detail: deny.error ? deny.error : deny.missing.length === 0 ? `all ${deny.present.length} deny rules present in ${deny.path}` : `${deny.missing.length} deny rules missing from ${deny.path}`,
      ...(deny.missing.length === 0 && !deny.error ? {} : { fix: 'Run `agentbridge init` to write the deny rules.' }),
    });

    // bare mode
    const bare = bareModeConfigured(env, userSettingsPath(env));
    checks.push({
      id: 'not_bare_mode', ok: !bare.bare,
      detail: bare.bare ? `bare mode is on via ${bare.where}: plugin hooks do not run` : 'bare mode is off',
      ...(bare.bare ? { fix: 'Unset CLAUDE_CODE_SIMPLE and don\'t start sessions with --bare.' } : {}),
    });
    return checks;
  }
}
