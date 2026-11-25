// Builds the publishable `agentbridge` package in packaging/npm: self-contained ESM bundles of the CLI and the service
// (every workspace package inlined, so the tarball has no dependencies), the Claude Code plugin folder with its
// already-bundled runtime, a marketplace manifest pointing at it, the committed Developer ID-signed AgentBridge.app (the
// helper, packages/presence/signed/), LICENSE.
// Usage: node --conditions=agentbridge-source packaging/npm/scripts/build.ts
import { build, type Metafile } from 'esbuild';
import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSignedHelper, SIGNED_APP } from '../../../packages/presence/scripts/signed-helper.ts';

export const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(PKG, '..', '..');

/**
 * The committed signed bundle must be valid, Developer ID-signed by our team with our identifier, match its manifest,
 * and have been built from the current helper sources. Packing never signs: the key stays on the owner's Mac.
 */
export function assertSignedHelper(): void {
  const bad = checkSignedHelper().filter((c) => !c.ok);
  if (bad.length) throw new Error(`signed AgentBridge.app (${SIGNED_APP}) is not releasable:\n${bad.map((c) => `  ${c.id}: ${c.detail}`).join('\n')}\nSee docs/releasing.md "Re-signing the helper".`);
}

export async function buildPackage(): Promise<Metafile> {
  assertSignedHelper(); // before anything is deleted or built: a stale helper fails fast
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

  // AgentBridge.app (universal helper inside), Developer ID-signed on the owner's Mac and committed
  // (packages/presence/scripts/sign-helper.ts). Copied byte for byte: the signature seals Info.plist and the icon too.
  // The runtime finds it at <package>/bin/AgentBridge.app (DEFAULT_HELPER_PATH, relative to dist/).
  mkdirSync(join(PKG, 'bin'), { recursive: true });
  cpSync(SIGNED_APP, join(PKG, 'bin', 'AgentBridge.app'), { recursive: true, preserveTimestamps: true });
  chmodSync(join(PKG, 'bin', 'AgentBridge.app', 'Contents', 'MacOS', 'AgentBridge'), 0o755);
  copyFileSync(join(REPO, 'LICENSE'), join(PKG, 'LICENSE'));
  return r.metafile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = await buildPackage();
  for (const [f, o] of Object.entries(m.outputs)) if (f.endsWith('.mjs')) console.log(`${f}  ${(o.bytes / 1024).toFixed(0)} KB`);
}
