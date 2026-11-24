// `agentbridge status --watch`: polls `cli.status {watch: true}` and redraws the panel in place until Ctrl-C.
// Read-only: one unprivileged IPC call per tick, no Touch ID. Without a TTY it prints the panel once and exits.
import { buildPanel, renderPanel, type WatchStatus } from './panel.ts';

export const WATCH_INTERVAL_MS = 1500;

export interface WatchOutput {
  isTTY: boolean;
  columns?: number;
  write(s: string): void;
  /** Called on terminal resize (TTY only). */
  onResize?(fn: () => void): void;
}

export interface WatchDeps {
  /** One `cli.status {watch: true}` answer; throws when the bridge can't be reached. */
  fetch(): Promise<WatchStatus>;
  out: WatchOutput;
  cliVersion: string;
  color?: boolean;
  intervalMs?: number;
  now?(): number;
  /** Resolves when the user quits (Ctrl-C). Default: SIGINT/SIGTERM. */
  stopped?: Promise<void>;
  /** Between ticks (tests replace it). */
  sleep?(ms: number, stopped: Promise<void>): Promise<void>;
}

const ESC = '\u001b[';
export const ENTER_SCREEN = `${ESC}?1049h${ESC}?25l`; // alternate screen, hide cursor
export const LEAVE_SCREEN = `${ESC}?25h${ESC}?1049l`;

const clockOf = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

/** One frame of plain lines for the current state (or the error that stopped us getting it). */
async function frame(d: WatchDeps, tty: boolean): Promise<string[]> {
  const now = d.now?.() ?? Date.now();
  try {
    const s = await d.fetch();
    return renderPanel(buildPanel(s, { cliVersion: d.cliVersion, nowMs: now }), { width: d.out.columns ?? 100, color: tty && d.color !== false, clock: clockOf(now) });
  } catch (e) {
    return [`agentbridge   ${clockOf(now)}`, '', `cannot read the bridge: ${(e as Error).message}`, tty ? 'retrying…' : ''];
  }
}

export async function runWatch(d: WatchDeps): Promise<number> {
  if (!d.out.isTTY) {
    // no redraw without a terminal: one snapshot, so `status --watch | cat` and logs stay readable
    for (const l of await frame(d, false)) d.out.write(`${l}\n`);
    return 0;
  }
  const stopped = d.stopped ?? new Promise<void>((resolve) => { process.once('SIGINT', () => resolve()); process.once('SIGTERM', () => resolve()); });
  let done = false; void stopped.then(() => { done = true; });
  const sleep = d.sleep ?? ((ms: number, s: Promise<void>) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); void s.then(() => { clearTimeout(t); resolve(); }); }));
  const interval = d.intervalMs ?? WATCH_INTERVAL_MS;
  let wake: (() => void) | null = null;
  d.out.onResize?.(() => wake?.());
  d.out.write(ENTER_SCREEN);
  try {
    while (!done) {
      const lines = await frame(d, true);
      if (done) break;
      lines.push('', `Ctrl-C to quit · refreshes every ${(interval / 1000).toFixed(1).replace(/\.0$/, '')}s · read-only`);
      // home, then each line with erase-to-end, then erase below: redraw in place without flicker
      d.out.write(`${ESC}H${lines.map((l) => `${l}${ESC}K`).join('\n')}\n${ESC}J`);
      await Promise.race([sleep(interval, stopped), new Promise<void>((r) => { wake = r; })]);
      wake = null;
    }
  } finally {
    d.out.write(LEAVE_SCREEN);
  }
  return 0;
}
