#!/usr/bin/env node
// Fails on dead relative links in Markdown docs: links to files that don't exist, and #anchors that match no
// heading in the target Markdown file, and Markdown files directly in docs/ that docs/README.md (the index) doesn't
// link to. External links (http:, https:, mailto:) are not checked.
// --product: product-only mode for the public snapshot, which leaves out the M0 material (docs/m0-*, docs/e2e-*,
// spikes/, M0-PLAN.md). Those files are not checked, and any link to them fails.
// Usage: node scripts/check-links.mjs [--product] [root]   (default: repository root)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const product = args.includes('--product');
const root = resolve(args.find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
/** M0 verification material: kept in the private repo, left out of the public snapshot. */
const isM0 = (abs) => { const r = relative(root, abs).split('\\').join('/'); return /^docs\/(m0-|e2e-)/.test(r) || r === 'spikes' || r.startsWith('spikes/') || r === 'M0-PLAN.md'; };
// Not checked: dependencies, build output, agent worktrees, and the throwaway M0 spikes.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.claude', '.vercel', '.vercel-build', 'spikes']);

function* markdownFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) yield* markdownFiles(p); }
    else if (name.endsWith('.md')) yield p;
  }
}

/** GitHub-style heading slug: lowercase, drop punctuation except "-" and "_", each space becomes "-". */
export function slug(text) {
  return text.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** Strip fenced code blocks (and optionally inline code) so example links and headings aren't checked. */
function stripCode(src, inline = true) {
  const noFences = src.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
  return inline ? noFences.replace(/`[^`\n]*`/g, '') : noFences;
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (!anchorCache.has(file)) {
    const seen = new Map();
    const set = new Set();
    for (const line of stripCode(readFileSync(file, 'utf8'), false).split('\n')) {
      const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (!m) continue;
      const base = slug(m[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      set.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const m of readFileSync(file, 'utf8').matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) set.add(m[1]);
    anchorCache.set(file, set);
  }
  return anchorCache.get(file);
}

const errors = [];
const linkedFrom = new Map(); // file → set of resolved link destinations
let checked = 0;
for (const file of markdownFiles(root)) {
  if (product && isM0(file)) continue;
  const dests = new Set();
  linkedFrom.set(file, dests);
  const src = stripCode(readFileSync(file, 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
  const targets = [
    ...[...src.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map((m) => m[1]),
    ...[...src.matchAll(/<a\s+[^>]*href="([^"]+)"/g)].map((m) => m[1]),
  ];
  for (const target of targets) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:, …
    checked++;
    const [pathPart, anchor] = target.split('#');
    const dest = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart.replace(/:\d+$/, ''))) : file;
    const where = relative(root, file);
    dests.add(dest);
    if (product && isM0(dest)) { errors.push(`${where}: links to M0 material ${target} (not in the public snapshot)`); continue; }
    if (!existsSync(dest)) { errors.push(`${where}: missing file ${target}`); continue; }
    if (anchor && dest.endsWith('.md') && !anchorsOf(dest).has(decodeURIComponent(anchor).toLowerCase())) {
      errors.push(`${where}: missing heading #${anchor} in ${relative(root, dest)}`);
    }
  }
}

// Every Markdown file directly in docs/ must be reachable from the docs index (M0 material excepted).
const docsDir = join(root, 'docs');
const index = join(docsDir, 'README.md');
if (existsSync(index)) {
  const indexed = linkedFrom.get(index) ?? new Set();
  for (const name of readdirSync(docsDir)) {
    const p = join(docsDir, name);
    if (name.endsWith('.md') && p !== index && !isM0(p) && !indexed.has(p)) errors.push(`docs/README.md: does not link to docs/${name}`);
  }
}

if (errors.length) {
  console.error(`check-links: ${errors.length} problem(s)\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-links${product ? ' (product-only)' : ''}: ${checked} relative link(s) OK`);
