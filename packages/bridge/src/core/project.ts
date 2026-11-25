// Project of a session = the git repository root of its working folder (agent panel grouping, docs/status-json.md).
// Worktrees and `-2` sessions of one repository share a root; a folder outside any repository is its own project.
// Pure filesystem reads (no `git` process): run once when a participant's folder becomes known, never per refresh.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/** `.git` in `dir`: a directory (a repository) or a file (`gitdir: …`, a worktree or submodule). */
function gitEntry(dir: string): { kind: 'dir' } | { kind: 'file'; gitdir: string } | null {
  const g = join(dir, '.git');
  try {
    const st = statSync(g);
    if (st.isDirectory()) return { kind: 'dir' };
    if (!st.isFile()) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(g, 'utf8'));
    if (!m) return null;
    return { kind: 'file', gitdir: isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!) };
  } catch { return null; }
}

/**
 * The main working tree of the repository `cwd` is in, or `cwd` itself when it is in none. A linked worktree resolves
 * to its main repository (via the worktree's `commondir`); a submodule stays its own project. Symlinks are resolved so
 * two spellings of one folder give one key. Never throws.
 */
export function projectRoot(cwd: string): string {
  const start = resolve(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    const e = gitEntry(dir);
    if (e?.kind === 'dir') return real(dir);
    if (e?.kind === 'file') {
      try {
        const common = join(e.gitdir, 'commondir');
        if (existsSync(common)) {
          const c = readFileSync(common, 'utf8').trim();
          const commonDir = isAbsolute(c) ? c : resolve(e.gitdir, c);
          // the common dir of a normal repository is `<root>/.git`; anything else (bare) keeps the worktree as the project
          if (basename(commonDir) === '.git') return real(dirname(commonDir));
        }
      } catch { /* unreadable: fall through to the worktree itself */ }
      return real(dir);
    }
    if (dirname(dir) === dir) return real(start);
  }
}

/** Opaque project key: `p_` + the first 16 hex characters of sha256(root). Stable per path, never the path itself. */
export function projectKey(root: string): string {
  return `p_${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
}

/**
 * `{ key, label }` for the panel: key = projectKey(root) (the real root stays in the database only), label = the
 * root's folder name.
 */
export function projectOf(root: string | null): { key: string; label: string } | null {
  return root ? { key: projectKey(root), label: basename(root) || 'project' } : null;
}
