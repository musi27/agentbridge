// `npm run pack:release`: build the package (with the committed Developer ID-signed helper; fails if the helper sources
// changed since it was signed), `npm pack` it into packaging/npm/out,
// verify the tarball, print its size and contents summary. Never publishes (the owner does: docs/releasing.md).
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildPackage, PKG } from './build.ts';
import { verifyTarball } from './verify.ts';

try { await buildPackage(); } catch (e) { console.error((e as Error).message); process.exit(1); }
const out = join(PKG, 'out'); mkdirSync(out, { recursive: true });
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', out], { cwd: PKG, encoding: 'utf8' })) as Array<{ filename: string; size: number; unpackedSize: number; files: Array<{ path: string; size: number }> }>;
const p = packed[0]!;
const tgz = join(out, p.filename);
const groups = new Map<string, { n: number; bytes: number }>();
for (const f of p.files) { const g = f.path.split('/')[0]!; const e = groups.get(g) ?? { n: 0, bytes: 0 }; e.n++; e.bytes += f.size; groups.set(g, e); }
console.log(`\n${tgz}\n  tarball ${(statSync(tgz).size / 1024).toFixed(0)} KB, unpacked ${(p.unpackedSize / 1024).toFixed(0)} KB, ${p.files.length} files`);
for (const [g, e] of [...groups].sort()) console.log(`  ${g.padEnd(16)} ${String(e.n).padStart(3)} files ${(e.bytes / 1024).toFixed(0).padStart(6)} KB`);
const r = verifyTarball(tgz);
console.log('');
for (const c of r.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
if (!r.ok) process.exit(1);
