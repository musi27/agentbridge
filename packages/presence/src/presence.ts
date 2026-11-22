import { truncateChars, type PresenceChecker, type PresenceResult } from '@agentbridge/protocol';
import { callHelper, HelperError, type HelperClientOptions } from './exec.ts';
import { presenceResultFrom } from './protocol.ts';

export interface MacPresenceCheckerOptions extends HelperClientOptions {
  /** The helper dismisses the dialog (LAContext.invalidate) after this long; Node kills it 5 s later as a backstop. Default 120 s. */
  timeoutMs?: number;
}

const MAX_REASON = 200;

/**
 * §9.2 user-presence check via LocalAuthentication `.deviceOwnerAuthentication` (Touch ID with
 * password fallback). Checks are serialised: one OS dialog at a time.
 */
export class MacPresenceChecker implements PresenceChecker {
  readonly #opts: MacPresenceCheckerOptions;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: MacPresenceCheckerOptions = {}) { this.#opts = opts; }

  check(reason: string): Promise<PresenceResult> {
    const next = this.#queue.then(() => this.#checkOne(reason));
    this.#queue = next.catch(() => {});
    return next;
  }

  async #checkOne(reason: string): Promise<PresenceResult> {
    // The OS shows "<app> is trying to <reason>." Keep it one short line.
    // Truncate by code point: slicing UTF-16 could leave a lone surrogate, which the helper rejects as invalid JSON.
    const clean = truncateChars(reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), MAX_REASON);
    if (clean === '') return { ok: false, code: 'error', detail: 'empty reason' };
    try {
      const timeoutMs = this.#opts.timeoutMs ?? 120_000;
      const res = await callHelper('presence', { reason: clean, timeout_ms: timeoutMs }, { ...this.#opts, timeoutMs: timeoutMs + 5_000 });
      return presenceResultFrom(res);
    } catch (e) {
      return { ok: false, code: 'error', detail: e instanceof HelperError ? e.message : String(e) };
    }
  }
}
