// The launchd job half of launchd-probe.ts. Runs once, writes $AB_PROBE_OUT, then idles until booted
// out (KeepAlive would otherwise restart it and prompt again).
// AB_PROBE_MODE=notify: wait 5 s, post one notification (marker in $AB_PROBE_MARKER), no Touch ID.
// AB_PROBE_MODE=full (default): notification, keychain round trip (throwaway service), presence
// check (approve it), then a presence check with a 4 s helper-enforced timeout (don't touch it).
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { MacKeychainStore } from '../src/keychain.ts';
import { MacPresenceChecker } from '../src/presence.ts';
import { OsascriptNotifier } from '../src/notifier.ts';
import { isLaunchdContext } from '../src/factories.ts';

const out = process.env.AB_PROBE_OUT;
const mode = process.env.AB_PROBE_MODE ?? 'full';
const marker = process.env.AB_PROBE_MARKER ?? 'probe';
const idle = () => setInterval(() => {}, 1 << 30);
const attempt = async <T>(f: () => Promise<T>): Promise<T | string> => { try { return await f(); } catch (e) { return `error: ${(e as Error).message}`; } };

if (out === undefined || existsSync(out)) {
  idle();
} else {
  const result: Record<string, unknown> = {
    context: { ppid: process.ppid, stdinIsTTY: process.stdin.isTTY === true, xpcServiceName: process.env.XPC_SERVICE_NAME ?? null, path: process.env.PATH ?? null, isLaunchdContext: isLaunchdContext(), node: process.version },
  };
  if (mode === 'notify') await new Promise((r) => setTimeout(r, 5000));
  result.notification = await attempt(async () => {
    await new OsascriptNotifier().notify({ title: `agentbridge ${marker}`, subtitle: 'from a launchd agent', body: `launchd probe ${marker} at ${new Date().toLocaleTimeString()}` });
    return 'osascript exit 0';
  });
  if (mode === 'full') {
    const store = new MacKeychainStore({ service: `agentbridge.test.probe-${randomBytes(4).toString('hex')}` });
    result.keychain = await attempt(async () => {
      const v = `probe ${randomBytes(16).toString('base64')}`;
      await store.set('probe.secret', v);
      const back = await store.get('probe.secret');
      await store.delete('probe.secret');
      const after = await store.get('probe.secret');
      return back === v && after === null ? 'round trip ok (set/get/delete)' : `mismatch: got ${JSON.stringify(back)}, after delete ${JSON.stringify(after)}`;
    });
    let t0 = Date.now();
    result.presence = await new MacPresenceChecker({ timeoutMs: 120_000 }).check('test the agentbridge launchd presence probe');
    result.presenceMs = Date.now() - t0;
    t0 = Date.now();
    result.presenceTimeout = await new MacPresenceChecker({ timeoutMs: 4000 }).check('test the 4-second timeout (do not touch this)');
    result.presenceTimeoutMs = Date.now() - t0;
  }
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  idle();
}
