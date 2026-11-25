// Verifies a packed agentbridge tarball the way a user gets it: `npm install -g` into a temp prefix (no registry
// access needed: the package has no dependencies), then `agentbridge help`, `agentbridge doctor` without a bridge, the
// helper, `--version`, the plugin + marketplace layout and version, and that no `@agentbridge/*` import survived bundling.
// Usage: node packaging/npm/scripts/verify.ts <musi27-agentbridge-x.y.z.tgz>   (exit 1 on any failure)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSignature } from '../../../packages/presence/scripts/signed-helper.ts';

export interface VerifyResult { ok: boolean; checks: Array<{ id: string; ok: boolean; detail: string }> }

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

export function verifyTarball(tgz: string): VerifyResult {
  const checks: VerifyResult['checks'] = [];
  const add = (id: string, ok: boolean, detail: string): void => { checks.push({ id, ok, detail }); };
  const prefix = mkdtempSync(join(tmpdir(), 'ab-verify-'));
  const home = mkdtempSync('/tmp/ab-vh-'); // short: socket paths are capped at 104 bytes
  try {
    const inst = spawnSync('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', resolve(tgz)], { encoding: 'utf8' });
    add('install', inst.status === 0, inst.status === 0 ? `installed into ${prefix}` : (inst.stderr || inst.stdout).slice(0, 400));
    if (inst.status !== 0) return { ok: false, checks };
    const pkg = join(prefix, 'lib', 'node_modules', '@musi27', 'agentbridge');
    const bin = join(prefix, 'bin', 'agentbridge');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'claude'), AGENTBRIDGE_HOME: join(home, 'ab') };

    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as Record<string, unknown>;
    add('no_dependencies', !manifest['dependencies'] && !manifest['peerDependencies'] && !manifest['optionalDependencies'], 'package.json declares no dependencies');

    const help = spawnSync(bin, ['help'], { encoding: 'utf8', env });
    add('help', help.status === 0 && /agentbridge/.test(help.stdout), `agentbridge help exit ${help.status}`);

    const ver = spawnSync(bin, ['--version', '--home', join(home, 'ab')], { encoding: 'utf8', env });
    add('version', ver.status === 0 && ver.stdout.trim() === `agentbridge ${String(manifest['version'])}`, `agentbridge --version printed "${ver.stdout.trim()}" (package.json ${String(manifest['version'])})`);

    const doc = spawnSync(bin, ['doctor', '--json'], { encoding: 'utf8', env, timeout: 60_000 });
    let parsed: { checks?: Array<{ id: string; ok: boolean; detail: string }> } = {};
    try { parsed = JSON.parse(doc.stdout) as typeof parsed; } catch { /* reported below */ }
    const dc = parsed.checks ?? [];
    add('doctor_offline', dc.some((c) => c.id === 'bridge' && !c.ok) && dc.length >= 3, `doctor without a bridge printed ${dc.length} checks (exit ${doc.status})`);
    const helperCheck = dc.find((c) => c.id === 'presence_helper');
    if (process.platform === 'darwin') {
      add('helper_answers', helperCheck?.ok === true && helperCheck.detail.includes(pkg), helperCheck ? helperCheck.detail : 'no presence_helper check');
      const app = join(pkg, 'bin', 'AgentBridge.app');
      const helper = join(app, 'Contents', 'MacOS', 'AgentBridge');
      add('helper_in_bundle', helperCheck?.detail.includes(helper) === true, `doctor runs ${helper} (inside the bundle, so macOS dialogs say "AgentBridge")`);
      const plistOut = spawnSync('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' });
      let plist: Record<string, unknown> = {};
      try { plist = JSON.parse(plistOut.stdout) as Record<string, unknown>; } catch { /* reported below */ }
      add('app_bundle', plist['CFBundleIdentifier'] === 'live.musi.agentbridge' && plist['CFBundleName'] === 'AgentBridge' && plist['CFBundleExecutable'] === 'AgentBridge' && plist['LSUIElement'] === true,
        `Info.plist: ${String(plist['CFBundleIdentifier'])}, name ${String(plist['CFBundleName'])}, LSUIElement ${String(plist['LSUIElement'])}`);
      const icon = join(app, 'Contents', 'Resources', `${String(plist['CFBundleIconFile'])}.icns`);
      const iconType = spawnSync('file', ['-b', icon], { encoding: 'utf8' }).stdout.trim();
      add('app_icon', existsSync(icon) && /icon/i.test(iconType), `${icon.slice(app.length + 1)}: ${iconType || 'missing'}`);
      const archs = spawnSync('lipo', ['-archs', helper], { encoding: 'utf8' }).stdout.trim();
      add('helper_universal', archs.includes('arm64') && archs.includes('x86_64'), `architectures: ${archs}`);
      // the installed bundle's Developer ID signature: seal intact after npm pack + install (--strict), not ad hoc,
      // hardened runtime, secure timestamp, designated requirement = anchor apple generic + team + identifier
      for (const c of checkSignature(app)) add(`helper_${c.id}`, c.ok, c.detail);
      const xattr = spawnSync('xattr', ['-l', helper], { encoding: 'utf8' }).stdout;
      add('helper_not_quarantined', !xattr.includes('com.apple.quarantine'), 'npm install sets no com.apple.quarantine (so no notarisation needed for this route)');
    }

    // `agentbridge start` from the installed package: detached serve in a temp home (file secrets, never the keychain);
    // stopped by SIGTERM to the pid in that temp home's own lock file only
    const sh = mkdtempSync('/tmp/ab-vs-'); const sroot = join(sh, 'ab');
    const senv = { ...env, AGENTBRIDGE_HOME: sroot, AGENTBRIDGE_DEV_SECRETS: '1' };
    try {
      const st = spawnSync(bin, ['start', '--home', sroot], { encoding: 'utf8', env: senv, timeout: 30_000 });
      const status = spawnSync(bin, ['status', '--home', sroot], { encoding: 'utf8', env: senv, timeout: 15_000 });
      add('start_serves', st.status === 0 && /agentbridge started/.test(st.stdout) && status.status === 0 && /policy v1/.test(status.stdout),
        `start: ${(st.stdout || st.stderr).trim().slice(0, 160)}; status exit ${status.status}`);
    } finally {
      const lock = join(sroot, 'run', 'bridge.lock');
      if (existsSync(lock)) {
        const pid = Number(readFileSync(lock, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
        for (let n = 0; n < 50 && existsSync(lock); n++) execFileSync('sleep', ['0.1']);
        add('start_stops', !existsSync(lock), 'SIGTERM to the temp bridge removed its lock');
      }
      rmSync(sh, { recursive: true, force: true });
    }

    const market = JSON.parse(readFileSync(join(pkg, '.claude-plugin', 'marketplace.json'), 'utf8')) as { plugins: Array<{ source: string }> };
    const pluginDir = join(pkg, market.plugins[0]!.source);
    const pluginVersion = (JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string }).version;
    add('plugin_version', pluginVersion === manifest['version'], `plugin.json ${pluginVersion}, package.json ${String(manifest['version'])} (Claude Code shows the plugin version)`);
    add('plugin_layout', existsSync(join(pluginDir, '.claude-plugin', 'plugin.json')) && existsSync(join(pluginDir, 'runtime', 'server.mjs')) && existsSync(join(pluginDir, 'hooks', 'hooks.json')), `marketplace → ${market.plugins[0]!.source}`);
    add('service_entry', existsSync(join(pkg, 'dist', 'service-main.mjs')), 'dist/service-main.mjs (launchd entry)');

    const bad: string[] = [];
    for (const f of walk(pkg)) {
      if (!/\.(mjs|js|cjs)$/.test(f)) continue;
      const t = readFileSync(f, 'utf8');
      if (/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']@agentbridge\//.test(t)) bad.push(f.slice(pkg.length + 1));
    }
    add('no_workspace_imports', bad.length === 0, bad.length ? `@agentbridge imports in ${bad.join(', ')}` : 'no @agentbridge/* imports left');
    const smoke = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(pkg, 'dist', 'service-main.mjs').replace('service-main.mjs', 'cli.mjs'))}).catch(e => { console.error(e); process.exit(1); })`, '--', 'help'], { encoding: 'utf8', env }).length > 0;
    add('esm_loads', smoke, 'dist/cli.mjs imports cleanly');
  } finally {
    rmSync(prefix, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tgz = process.argv[2];
  if (!tgz) { console.error('usage: verify.ts <musi27-agentbridge-x.y.z.tgz>'); process.exit(2); }
  const r = verifyTarball(tgz);
  for (const c of r.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
  process.exit(r.ok ? 0 : 1);
}
