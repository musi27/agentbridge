// Entry point of the plugin hooks (bundled to plugin/runtime/hook.mjs). Always exits 0.
import { CODEX_START_TIMEOUT_MS, runHook } from './hook.ts';

// AGENTBRIDGE_HOOK_TIMING=1: report on stderr at exit how long the hook's own code ran (from this module starting to
// exit) and how long Node took to boot before that. Tests check the former against the < 1 s budget: Node's start-up
// is outside the hook's control and can take seconds on a heavily loaded machine.
const started = performance.now();
const timing = process.env.AGENTBRIDGE_HOOK_TIMING === '1';
const exit = (): never => {
  if (timing) process.stderr.write(`agentbridge-hook-ms=${Math.round(performance.now() - started)} boot-ms=${Math.round(started)}\n`);
  process.exit(0);
};

const host = process.argv.includes('--host=codex') ? 'codex' : 'claude';
// never hold the host up, whatever happens; a Codex SessionStart may wait for the standing instruction (§11a)
const hardStop = setTimeout(exit, host === 'codex' ? CODEX_START_TIMEOUT_MS + 1500 : 900);
let stdin = '';
try {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdin += chunk as string;
  const out = await runHook(stdin, { host });
  if (out) process.stdout.write(out + '\n');
} catch {
  // swallow: hooks must not fail the session
}
clearTimeout(hardStop);
exit();
