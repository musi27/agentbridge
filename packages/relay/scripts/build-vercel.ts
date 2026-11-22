// Builds a deployable Vercel project in packages/relay/.vercel-build: one bundled function (our code + protocol),
// runtime dependencies installed by Vercel from package.json. Usage: node scripts/build-vercel.ts
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.vercel-build');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtime = ['ioredis', 'libsodium-wrappers', 'ws', 'zod'];

const linked = existsSync(join(out, '.vercel')) ? join(root, '.vercel-link-tmp') : null;
if (linked) cpSync(join(out, '.vercel'), linked, { recursive: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'api'), { recursive: true });
if (linked) { cpSync(linked, join(out, '.vercel'), { recursive: true }); rmSync(linked, { recursive: true, force: true }); }

await build({
  entryPoints: [join(root, 'src/vercel.ts')], outfile: join(out, 'api/relay.js'), bundle: true, platform: 'node', format: 'esm',
  target: 'node22', conditions: ['agentbridge-source'], external: [...runtime, 'bufferutil', 'utf-8-validate'], legalComments: 'none',
});
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'agentbridge-relay', private: true, type: 'module', engines: { node: '24.x' },
  dependencies: Object.fromEntries(runtime.map((d) => [d, pkg.dependencies[d]])),
}, null, 2) + '\n');
writeFileSync(join(out, 'vercel.json'), JSON.stringify({
  regions: ['fra1'],
  functions: { 'api/relay.js': { maxDuration: 300, memory: 512 } },
  rewrites: [{ source: '/', destination: '/api/relay?__p=/' }, { source: '/:path*', destination: '/api/relay?__p=/:path*' }],
}, null, 2) + '\n');
console.log(`built ${out}`);
