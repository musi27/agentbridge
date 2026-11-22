// Builds the publishable `agentbridge` package in packaging/npm: self-contained ESM bundles of the CLI and the service
// (every workspace package inlined, so the tarball has no dependencies), the Claude Code plugin folder with its
// already-bundled runtime, a marketplace manifest pointing at it, the prebuilt helper, LICENSE.
// Usage: node --conditions=agentbridge-source packaging/npm/scripts/build.ts
import { build, type Metafile } from 'esbuild';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(PKG, '..', '..');
const HELPER = join(REPO, 'packages', 'presence', 'bin', 'agentbridge-helper');

export async function buildPackage(): Promise<Metafile> {
  for (const d of ['dist', 'bin', 'plugin', '.claude-plugin']) rmSync(join(PKG, d), { recursive: true, force: true });
  const r = await build({
    absWorkingDir: REPO, // comments name repo-relative paths: output bytes don't depend on the checkout location
    entryPoints: { cli: join(PKG, 'src', 'bin.ts'), 'service-main': join(REPO, 'packages', 'bridge', 'src', 'cli', 'service-main.ts') },
    outdir: join(PKG, 'dist'),
    outExtension: { '.js': '.mjs' },
    chunkNames: '[name]-[hash]', // chunks stay in dist/, next to the entries (the helper and marketplace are found relative to it)
    bundle: true, splitting: true, platform: 'node', format: 'esm', target: 'node24',
    conditions: ['agentbridge-source'],
    // optional native accelerators some dependencies try to require inside try/catch
    external: ['bufferutil', 'utf-8-validate'],
    legalComments: 'eof', charset: 'utf8', logLevel: 'warning', metafile: true,
    banner: { js: "// agentbridge release bundle (packaging/npm/scripts/build.ts). Do not edit.\nimport { createRequire as __abCreateRequire } from 'node:module';\nconst require = __abCreateRequire(import.meta.url);" },
  });
  chmodSync(join(PKG, 'dist', 'cli.mjs'), 0o755);

  // Claude Code plugin (runtime already bundled by adapters/claude-code/scripts/build-plugin.ts) + marketplace manifest
  cpSync(join(REPO, 'adapters', 'claude-code', 'plugin'), join(PKG, 'plugin'), { recursive: true });
  mkdirSync(join(PKG, '.claude-plugin'), { recursive: true });
  writeFileSync(join(PKG, '.claude-plugin', 'marketplace.json'), `${JSON.stringify({
    name: 'agentbridge', owner: { name: 'agentbridge' }, metadata: { description: 'agentbridge plugins for Claude Code' },
    plugins: [{ name: 'agentbridge', source: './plugin', description: 'Human-approved conversations between your Claude Code sessions and other agents, through the local agentbridge bridge.' }],
  }, null, 2)}\n`);

  // prebuilt helper (universal, ad-hoc signed by packages/presence/native/build.sh)
  if (!existsSync(HELPER)) throw new Error(`helper missing at ${HELPER}: run npm run build:helper -w @agentbridge/presence`);
  mkdirSync(join(PKG, 'bin'), { recursive: true });
  copyFileSync(HELPER, join(PKG, 'bin', 'agentbridge-helper'));
  chmodSync(join(PKG, 'bin', 'agentbridge-helper'), 0o755);
  copyFileSync(join(REPO, 'LICENSE'), join(PKG, 'LICENSE'));
  return r.metafile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = await buildPackage();
  for (const [f, o] of Object.entries(m.outputs)) if (f.endsWith('.mjs')) console.log(`${f}  ${(o.bytes / 1024).toFixed(0)} KB`);
}
