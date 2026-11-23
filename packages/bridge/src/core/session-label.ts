// Session naming helpers (§5): the git branch for a Claude session's address, and Claude Code's session
// title for the label shown beside it. Both read local files only and never throw.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { sanitizeLabel, slugifyName } from '@agentbridge/protocol';

/** Branches that add nothing to an address: a lone session on main keeps the plain folder name. */
const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk', 'develop']);
export const TITLE_CHARS = 80;
const TAIL_BYTES = 256 * 1024;

/** The checked-out branch for `cwd` (walking up to the repo root; worktrees supported), or null. */
export function gitBranch(cwd: string): string | null {
  try {
    let dir = resolve(cwd);
    for (let i = 0; i < 64; i++) {
      const dotgit = join(dir, '.git');
      let st; try { st = statSync(dotgit); } catch { st = null; }
      if (st) {
        let gitdir = dotgit;
        if (st.isFile()) {
          const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotgit, 'utf8'));
          if (!m) return null;
          gitdir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
        }
        const head = readFileSync(join(gitdir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1]! : null; // detached HEAD: no branch
      }
      const up = dirname(dir); if (up === dir) return null; dir = up;
    }
  } catch { /* unreadable repo: no branch */ }
  return null;
}

/** The part of a branch worth putting in an address: last path segment, nothing for default branches. */
export function branchSuffix(branch: string | null): string | null {
  if (!branch) return null;
  const last = branch.split('/').filter(Boolean).at(-1) ?? '';
  return !last || DEFAULT_BRANCHES.has(last) ? null : last;
}

/** Address base for a Claude session: folder, plus the branch unless it is a default one (`agentbridge-video`). */
export function sessionBaseName(cwd: string | null): string {
  if (!cwd) return 'session';
  const folder = slugifyName(basename(cwd)); const raw = branchSuffix(gitBranch(cwd));
  const suffix = raw ? slugifyName(raw) : null;
  // worktrees are often named after their branch: don't say it twice
  const redundant = !suffix || folder.toLowerCase() === suffix.toLowerCase() || folder.toLowerCase().endsWith(`-${suffix.toLowerCase()}`);
  return redundant ? folder : slugifyName(`${folder}-${suffix}`);
}

/**
 * The latest session title Claude Code recorded in a transcript (`{"type":"custom-title","customTitle":…}`),
 * sanitised, or null. Undocumented format: a missing or changed record only means no label.
 * Reads the last 256 KB only; Claude Code repeats the record, so the latest one is near the end.
 */
export function readSessionTitle(transcriptPath: string): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(transcriptPath).size;
    const len = Math.min(size, TAIL_BYTES); const buf = Buffer.alloc(len);
    fd = openSync(transcriptPath, 'r'); readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"custom-title"')) continue;
      try {
        const rec = JSON.parse(line) as { type?: unknown; customTitle?: unknown };
        if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') return sanitizeLabel(rec.customTitle, TITLE_CHARS) || null;
      } catch { /* partial first line of the tail window */ }
    }
  } catch { /* no transcript yet */ } finally { if (fd !== null) try { closeSync(fd); } catch { /* ignore */ } }
  return null;
}
