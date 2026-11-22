// Posting into the session's own inbox socket (§11.3, verified in M0 V2).
// Wire format: newline-delimited JSON; an auth line, then one user line. The socket never answers,
// so a successful write means "handed off", never "delivered".
import net from 'node:net';
import { LIMITS } from '@agentbridge/protocol';

export interface InboxTarget { socket: string; token: string }

/** The exact bytes written for one post. */
export function inboxPayload(token: string, text: string): string {
  return JSON.stringify({ type: 'auth', token }) + '\n'
    + JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

/** Write one post on a fresh connection. Resolves once the bytes are flushed; rejects if the socket is unusable. */
export function postToInbox(target: InboxTarget, text: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { sock.destroy(); reject(err); } else resolve();
    };
    const sock = net.createConnection(target.socket);
    const timer = setTimeout(() => done(new Error('inbox post timed out')), timeoutMs);
    sock.on('error', (e) => done(new Error(`inbox: ${(e as NodeJS.ErrnoException).code ?? e.message}`)));
    sock.on('connect', () => {
      sock.end(inboxPayload(target.token, text), () => {
        done();
        // Give Claude Code a moment to read before we drop our side; nothing is ever sent back (M0 V2).
        setTimeout(() => sock.destroy(), 500).unref();
      });
    });
  });
}

export type PostFn = (target: InboxTarget, text: string) => Promise<void>;

/** Serialises posts and keeps them >= LIMITS.inboxPostSpacingMs apart (start to start), across calls. */
export class InboxPoster {
  readonly target: InboxTarget;
  readonly #spacingMs: number;
  readonly #post: PostFn;
  #chain: Promise<unknown> = Promise.resolve();
  #lastStart = -Infinity;

  constructor(target: InboxTarget, opts: { spacingMs?: number; post?: PostFn } = {}) {
    this.target = target;
    this.#spacingMs = opts.spacingMs ?? LIMITS.inboxPostSpacingMs;
    this.#post = opts.post ?? ((t, s) => postToInbox(t, s));
  }

  /** Queue one post. Resolves when it is written; rejects with the write error. */
  post(text: string): Promise<void> {
    const run = async (): Promise<void> => {
      // setTimeout may fire up to ~1 ms early for fractional delays: round up and re-check until the spacing has passed.
      let wait: number;
      while ((wait = this.#lastStart + this.#spacingMs - performance.now()) > 0) await new Promise((r) => setTimeout(r, Math.ceil(wait)));
      this.#lastStart = performance.now();
      await this.#post(this.target, text);
    };
    const p = this.#chain.then(run, run);
    this.#chain = p.catch(() => undefined);
    return p;
  }
}
