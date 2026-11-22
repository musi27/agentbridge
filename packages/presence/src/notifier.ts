import type { Notifier } from '@agentbridge/protocol';
import { run, type Runner } from './exec.ts';

/**
 * Title/body/subtitle are passed to osascript as argv items after `--` and read with
 * `item N of argv`, so they are never parsed as AppleScript source or as osascript options:
 * quotes, backslashes, `& do shell script`, and a leading `-e` / `-l` are all inert. Without the
 * `--`, osascript keeps parsing options until the first non-option, so a title of "-e" would turn
 * the body into a script line. The script text itself is a constant. (Notification text is not
 * secret, so argv is acceptable here, unlike for keychain values.)
 */
export const NOTIFY_SCRIPT = [
  'on run argv',
  'display notification (item 2 of argv) with title (item 1 of argv)',
  'end run',
].join('\n');
export const NOTIFY_SCRIPT_SUBTITLE = [
  'on run argv',
  'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)',
  'end run',
].join('\n');

export const LIMITS = { title: 120, subtitle: 120, body: 1000 } as const;

/** Removes control characters (NUL cannot travel in argv; others render badly) and truncates. */
export function cleanNotificationText(s: string, max: number): string {
  const flat = s.replace(/\r\n?|\n/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

/** Builds the osascript argv. Exported for tests. */
export function osascriptArgs(n: { title: string; body: string; subtitle?: string }): string[] {
  const title = cleanNotificationText(n.title, LIMITS.title) || 'agentbridge';
  const body = cleanNotificationText(n.body, LIMITS.body);
  const subtitle = n.subtitle === undefined ? '' : cleanNotificationText(n.subtitle, LIMITS.subtitle);
  return subtitle === ''
    ? ['-e', NOTIFY_SCRIPT, '--', title, body]
    : ['-e', NOTIFY_SCRIPT_SUBTITLE, '--', title, body, subtitle];
}

export interface OsascriptNotifierOptions { runner?: Runner; osascriptPath?: string; timeoutMs?: number }

/** §9.1 desktop popup via Notification Center (`osascript display notification`). */
export class OsascriptNotifier implements Notifier {
  readonly #opts: OsascriptNotifierOptions;
  constructor(opts: OsascriptNotifierOptions = {}) { this.#opts = opts; }

  async notify(n: { title: string; body: string; subtitle?: string }): Promise<void> {
    const runner = this.#opts.runner ?? run;
    const r = await runner(this.#opts.osascriptPath ?? '/usr/bin/osascript', osascriptArgs(n), { timeoutMs: this.#opts.timeoutMs ?? 10_000 });
    if (r.timedOut) throw new Error('osascript notification timed out');
    if (r.code !== 0) throw new Error(`osascript notification failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
  }
}
