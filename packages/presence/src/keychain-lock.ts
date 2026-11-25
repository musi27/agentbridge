// Cross-process lock for read-modify-write of the combined keychain item. The bridge service and CLI processes
// (init, uninstall) can both write it, so every write runs inside this lock.
//
// The lock is a file created with O_EXCL holding "<pid> <random token>". A lock whose holder process is gone, or that
// is older than `staleMs`, is taken over: it is first renamed aside (atomic), so of two processes that both saw a
// stale lock only one removes it. Within one process, callers queue on a promise chain per lock path, so the file is
// never contended by the same pid.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, linkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface FileLockOptions {
  /** Give up after this long (default 5 min: a holder may be waiting on several keychain dialogs). */
  timeoutMs?: number;
  /** A lock file older than this is stale whatever its pid (default 15 min). */
  staleMs?: number;
  /** For tests: is this pid alive? */
  pidAlive?: (pid: number) => boolean;
}

export class LockTimeoutError extends Error {
  override name = 'LockTimeoutError';
}

const chains = new Map<string, Promise<unknown>>();

function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tryCreate(path: string, content: string): boolean {
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try { writeSync(fd, content); } finally { closeSync(fd); }
  return true;
}

function readHolder(path: string): { pid: number | null; raw: string; ageMs: number } | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const ageMs = Date.now() - statSync(path).mtimeMs;
    const pid = Number(raw.split(' ')[0]);
    return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, raw, ageMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Takes over `path` if it still holds exactly `seen`; true when the caller should retry creating it. */
function takeOver(path: string, seen: string): boolean {
  const aside = `${path}.stale-${randomBytes(6).toString('hex')}`;
  try { renameSync(path, aside); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw e;
  }
  let moved = '';
  try { moved = readFileSync(aside, 'utf8'); } catch { /* vanished */ }
  if (moved === seen) { try { unlinkSync(aside); } catch { /* gone */ } return true; }
  // Someone took the lock between our read and the rename: put theirs back (fails only if yet another got in).
  try { linkSync(aside, path); } catch { /* lost the race either way */ }
  try { unlinkSync(aside); } catch { /* gone */ }
  return false;
}

async function acquire(path: string, o: FileLockOptions): Promise<() => void> {
  const timeoutMs = o.timeoutMs ?? 300_000;
  const staleMs = o.staleMs ?? 900_000;
  const alive = o.pidAlive ?? defaultPidAlive;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mine = `${process.pid} ${randomBytes(8).toString('hex')}\n`;
  const deadline = Date.now() + timeoutMs;
  let wait = 10;
  for (;;) {
    if (tryCreate(path, mine)) {
      return () => {
        // Only remove our own lock (a takeover after staleMs may have replaced it).
        try { if (readFileSync(path, 'utf8') === mine) unlinkSync(path); } catch { /* already gone */ }
      };
    }
    const h = readHolder(path);
    if (h === null) continue;
    const stale = h.ageMs > staleMs || (h.pid !== null ? !alive(h.pid) : h.ageMs > 5_000);
    if (stale && takeOver(path, h.raw)) continue;
    if (Date.now() > deadline) throw new LockTimeoutError(`the AgentBridge keychain item is busy (lock ${path} held by ${h.pid === null ? 'an unknown process' : `pid ${h.pid}`}); try again`);
    await sleep(wait);
    wait = Math.min(wait * 2, 200);
  }
}

/** Runs `fn` while holding the lock at `path` (queued within this process, exclusive across processes). */
export function withFileLock<T>(path: string, fn: () => Promise<T>, o: FileLockOptions = {}): Promise<T> {
  const prev = chains.get(path) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const release = await acquire(path, o);
    try { return await fn(); } finally { release(); }
  });
  const tail = run.catch(() => {});
  chains.set(path, tail);
  void tail.then(() => { if (chains.get(path) === tail) chains.delete(path); });
  return run;
}

/** In-process only (no lock file): for stores without a state folder. */
export function withProcessLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}
