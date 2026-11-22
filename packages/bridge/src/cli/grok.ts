// Interactive CLI flows for Grok (§12.5, §12.6): `agentbridge add grok` and `agentbridge revoke grok:<name>`.
// Secrets, the relay and the database are handled by the bridge (cli.add_grok / cli.revoke steps); this module only
// talks to the user: clipboard (pbcopy), prompts and hidden input. IO is injectable for tests.
import { spawn } from 'node:child_process';
import type { BeginResult, RoundTripResult } from '../grok/setup.ts';

export interface Io {
  print(s: string): void;
  prompt(question: string): Promise<string>;
  /** Read a line without echoing it (webhook URL and key). */
  promptHidden(question: string): Promise<string>;
  /** Copy to the clipboard; false if it failed (the caller then prints the text). */
  copy(text: string): Promise<boolean>;
  /** Current clipboard text (pbpaste), or null if unavailable. */
  paste(): Promise<string | null>;
}
export type Call = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;

const yes = (s: string, dflt = false): boolean => { const t = s.trim().toLowerCase(); return t === '' ? dflt : t === 'y' || t === 'yes'; };
/** Round trip takes up to 90 s on the bridge (including the POST); leave room for IPC. */
const CHECK_TIMEOUT_MS = 120_000;

async function copyOrShow(io: Io, text: string, what: string): Promise<void> {
  if (await io.copy(text)) { io.print(`✓ ${what} copied to the clipboard.`); return; }
  io.print(`Could not use the clipboard. Copy the ${what} below:\n\n${text}\n`);
}

/**
 * Token hygiene (S1): the token goes to the clipboard and is printed only if the clipboard fails or the user types
 * "show". Once the user is done, the clipboard is cleared if it still holds the token (compared in-process; values
 * travel over stdin/stdout only, never argv).
 */
async function handOverToken(io: Io, token: string, doneQuestion: string, prompt?: { text: string; what: string }): Promise<void> {
  const copied = await io.copy(token);
  if (copied) io.print('✓ Connector token copied to the clipboard (it is not shown; type "show" below to display it once).');
  else io.print(`Could not use the clipboard. Connector token (shown only this once):\n\n  ${token}\n`);
  let shown = !copied;
  for (;;) {
    const a = (await io.prompt(doneQuestion)).trim().toLowerCase();
    if (a === 'show' && !shown) { io.print(`\n  ${token}\n`); shown = true; continue; }
    if (a === 'copy') { await io.copy(token); io.print('✓ Token copied again.'); continue; }
    if (a === 'p' && prompt) { await copyOrShow(io, prompt.text, prompt.what); io.print('(Type "copy" to put the token back on the clipboard.)'); continue; }
    break;
  }
  if (copied && (await io.paste()) === token) { await io.copy(''); io.print('✓ Clipboard cleared.'); }
}

export function printRoundTrip(io: Io, r: RoundTripResult): void {
  if (r.ok) {
    io.print(`✓ Round trip works: ${r.address} replied in ${r.seconds} s${r.run_uuid ? ` (run ${r.run_uuid})` : ''}.`);
    io.print(`  Reply (untrusted): "${r.reply_preview}"`);
    return;
  }
  io.print(`✗ Round trip failed after ${r.seconds} s: ${r.detail}`);
  if (r.stage === 'network') { for (const c of r.causes) io.print(`  ${c}`); return; } // not a Grok-side problem
  if (r.stage === 'no_reply' && r.calls_seen.length > 0) io.print('  The connector works (the run called agentbridge), so the token and connector are fine.');
  if (r.causes.length) {
    io.print('  Likely causes, most likely first:');
    r.causes.forEach((c, i) => io.print(`  ${i + 1}. ${c}`));
  }
}

async function runCheck(call: Call, io: Io, method: 'cli.add_grok' | 'cli.revoke', setupId: string, address: string): Promise<boolean> {
  for (;;) {
    io.print(`\nSending a test delivery to ${address} and waiting up to 90 s for its reply…`);
    const r = await call(method, { step: 'check', setup_id: setupId }, CHECK_TIMEOUT_MS) as RoundTripResult;
    printRoundTrip(io, r);
    if (r.ok) return true;
    if (!yes(await io.prompt('Fix the cause above, then try again? [Y/n] '), true)) {
      io.print(`Run \`agentbridge doctor ${address}\` to repeat the check later.`);
      return false;
    }
  }
}

/** `agentbridge add grok` (§12.5). Returns the exit code. An error or Ctrl-C before the webhook step undoes the bot. */
export async function addGrokFlow(call: Call, io: Io): Promise<number> {
  io.print('agentbridge: add a Grok bot. You will need your Grok Bot chat open; this takes about 4 minutes.\n');
  let name = '';
  while (!name.trim()) name = await io.prompt('Name for this bot (letters, digits, dashes; e.g. researcher): ');
  const b = await call('cli.add_grok', { step: 'begin', name: name.trim() }) as BeginResult;
  io.print(`\nCreated ${b.address} and registered it with the relay (${b.relay_origin}).`);
  let webhookSaved = false;
  try {
    io.print('\nStep 1 of 4: connector, routine and Allow rule');
    await copyOrShow(io, b.bootstrap, 'setup prompt');
    io.print('Paste it into a chat with your Grok bot, but do not send it yet.');
    // the token replaces the prompt on the clipboard, so only copy it once the prompt is pasted (e2e run 1)
    while ((await io.prompt('Pasted it into the bot\'s chat (not sent)? Press Enter to copy the token next ("p" copies the prompt again): ')).trim().toLowerCase() === 'p') {
      await copyOrShow(io, b.bootstrap, 'setup prompt');
    }
    await handOverToken(io, b.token, 'Replace the word TOKEN in the pasted prompt with the token and send it. Press Enter when done ("show" displays the token, "p" copies the prompt again): ', { text: b.bootstrap, what: 'setup prompt' });
    io.print(`Approve each step the bot confirms, including the Allow rule card for ${b.allow_rule_tools.join(', ')}.`);
    io.print('Do not add an "Ask first" rule: it can hold the replies.');
    await io.prompt('Press Enter when the bot has added the connector, created the routine and you approved the Allow rule… ');

    io.print('\nStep 2 of 4: routine instruction');
    await copyOrShow(io, b.instruction, 'routine instruction');
    io.print('Open the routine "Inbox from agentbridge", replace its whole instruction with the copied text, and save.');
    while (!yes(await io.prompt('Does the routine panel now show text starting "You receive deliveries from agentbridge"? [y/N] '))) {
      io.print('Paste it again and press Save (in testing, the first paste did not always save).');
      if (yes(await io.prompt('Copy the instruction again? [y/N] '))) await copyOrShow(io, b.instruction, 'routine instruction');
    }

    io.print('\nStep 3 of 4: webhook URL and key (from the routine panel; input is hidden)');
    for (;;) {
      const url = (await io.promptHidden('Webhook URL: ')).trim();
      const key = (await io.promptHidden('Webhook key: ')).trim();
      try { await call('cli.add_grok', { step: 'webhook', setup_id: b.setup_id, webhook_url: url, webhook_key: key }); webhookSaved = true; io.print('✓ Stored in the keychain.'); break; }
      catch (e) { io.print(`✗ ${(e as Error).message}. Try again.`); }
    }
  } catch (e) {
    if (!webhookSaved) {
      try { await call('cli.add_grok', { step: 'abort', setup_id: b.setup_id }); io.print(`Setup cancelled: ${b.address} was removed again (relay registration and token).`); } catch { /* the bridge cleans up when the setup expires */ }
    }
    throw e;
  }

  io.print('\nStep 4 of 4: round-trip check');
  const ok = await runCheck(call, io, 'cli.add_grok', b.setup_id, b.address);
  if (ok) io.print(`\nDone. Your Claude Code sessions can now talk to ${b.address}.`);
  return ok ? 0 : 1;
}

/** `agentbridge revoke grok:<name>` (§12.6): new token, old one stops working at once; then the round trip (§12.5). */
export async function revokeGrokFlow(call: Call, io: Io, address: string): Promise<number> {
  const r = await call('cli.revoke', { step: 'begin', address }) as { setup_id: string; address: string; token: string };
  io.print(`The old token for ${r.address} no longer works.`);
  io.print('In Grok, edit the agentbridge connector and set the header to "Authorization: Bearer <new token>" (or ask the bot to update the connector header with the token you paste).');
  await handOverToken(io, r.token, 'Press Enter once the connector uses the new token (or type "show"): ');
  if ((await io.prompt('Press Enter to run the round-trip check (type "skip" to skip): ')).trim().toLowerCase() === 'skip') {
    io.print(`Skipped. Run \`agentbridge doctor ${r.address}\` soon: replies fail until the connector has the new token.`);
    return 0;
  }
  return (await runCheck(call, io, 'cli.revoke', r.setup_id, r.address)) ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------- terminal IO

/**
 * Splits terminal input into lines without losing anything: text after a newline in the same chunk (a pasted
 * "url⏎key⏎") stays buffered for the next read. Handles CR/LF, backspace, Ctrl-C and bracketed-paste markers.
 */
export class LineSplitter {
  private cur = '';
  private esc = '';
  private lastWasCr = false;
  readonly lines: string[] = [];
  cancelled = false;
  push(chunk: string): void {
    for (const ch of chunk) {
      if (this.esc) { this.esc += ch; if (/^\x1b\[[0-9;]*[~A-Za-z]$/.test(this.esc) || this.esc.length > 8) this.esc = ''; continue; }
      if (ch === '\x1b') { this.esc = ch; continue; }
      if (ch === '\r' || ch === '\n') { if (ch === '\n' && this.lastWasCr) { this.lastWasCr = false; continue; } this.lastWasCr = ch === '\r'; this.lines.push(this.cur); this.cur = ''; continue; }
      this.lastWasCr = false;
      if (ch === '\u0003') { this.cancelled = true; continue; }
      if (ch === '\u007f' || ch === '\b') { this.cur = Array.from(this.cur).slice(0, -1).join(''); continue; }
      if (ch >= ' ') this.cur += ch;
    }
  }
  shift(): string | undefined { return this.lines.shift(); }
}

export function terminalIo(): Io {
  const stdin = process.stdin;
  const split = new LineSplitter();
  /** One reader for every prompt (piped input is read once, never by competing readline instances). */
  const nextLine = (question: string, hidden: boolean): Promise<string> => {
    process.stdout.write(question);
    const queued = split.shift();
    if (queued !== undefined) { if (hidden || !stdin.isTTY) process.stdout.write('\n'); return Promise.resolve(queued); }
    return new Promise((resolve, reject) => {
      const raw = hidden && stdin.isTTY;
      if (raw) stdin.setRawMode(true);
      stdin.setEncoding('utf8'); stdin.resume();
      const onData = (chunk: string): void => {
        split.push(chunk);
        if (split.cancelled) { finish(); reject(new Error('cancelled')); return; }
        const l = split.shift();
        if (l !== undefined) { finish(); resolve(l); }
      };
      const onEnd = (): void => { finish(); reject(new Error('input closed')); };
      const finish = (): void => {
        stdin.off('data', onData); stdin.off('end', onEnd); stdin.pause();
        if (raw) stdin.setRawMode(false);
        if (hidden || !stdin.isTTY) process.stdout.write('\n');
      };
      stdin.on('data', onData); stdin.on('end', onEnd);
    });
  };
  return {
    print: (s) => process.stdout.write(`${s}\n`),
    prompt: (q) => nextLine(q, false),
    promptHidden: (q) => nextLine(q, true),
    copy: (text) => new Promise((resolve) => {
      try {
        const p = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
        p.stdin.end(text); // value over stdin only
      } catch { resolve(false); }
    }),
    paste: () => new Promise((resolve) => {
      try {
        const p = spawn('pbpaste', [], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = ''; p.stdout.setEncoding('utf8'); p.stdout.on('data', (d: string) => { out += d; });
        p.on('error', () => resolve(null));
        p.on('close', (code) => resolve(code === 0 ? out : null));
      } catch { resolve(null); }
    }),
  };
}
