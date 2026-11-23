#!/usr/bin/env python3
"""Drive the interactive Codex TUI in a pty, answering the terminal queries it sends at start-up.
Usage: codex-tui.py <steps.json> <log> <command...>. Steps, in order:
  {"wait": secs}  {"until": "regex", "timeout": secs}  {"send": "text"}  {"key": "enter"|"ctrl-c"|...}
  {"file": "path"}  (wait until the file exists: lets a driving script sequence its own checks)
  {"mark": "name"}  (written into the log)"""
import json, os, pty, re, select, subprocess, sys, time, fcntl, termios, struct
steps = json.load(open(sys.argv[1])); logpath = sys.argv[2]; argv = sys.argv[3:]
log = open(logpath, 'wb')
ANSI = re.compile(rb'\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78DME]')
seen = bytearray()
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'; os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
KEYS = {'enter': b'\r', 'ctrl-c': b'\x03', 'esc': b'\x1b', 'down': b'\x1b[B', 'up': b'\x1b[A', 'tab': b'\t'}
def pump(secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if not r: continue
        try: data = os.read(fd, 65536)
        except OSError: return False
        if not data: return False
        log.write(data); log.flush(); seen.extend(data)
        if b'\x1b[6n' in data: os.write(fd, b'\x1b[1;1R')          # cursor position report
        if b'\x1b[c' in data or b'\x1b[0c' in data: os.write(fd, b'\x1b[?62;22c')  # device attributes
        if b'\x1b]10;?' in data: os.write(fd, b'\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
        if b'\x1b]11;?' in data: os.write(fd, b'\x1b]11;rgb:0000/0000/0000\x1b\\')
        if b'\x1b[?u' in data: os.write(fd, b'\x1b[?0u')
    return True
for s in steps:
    if 'wait' in s: pump(s['wait'])
    elif 'send' in s:
        for ch in s['send']: os.write(fd, ch.encode()); pump(0.02)
    elif 'key' in s: os.write(fd, KEYS.get(s['key'], s['key'].encode())); pump(0.3)
    elif 'until' in s:
        rx = re.compile(s['until']); end = time.time() + s.get('timeout', 60); ok = False
        while time.time() < end:
            if rx.search(ANSI.sub(b' ', bytes(seen)).decode('utf8', 'replace').replace('\r', ' ')): ok = True; break
            if not pump(0.5): break
        print('[until]', s['until'], 'ok' if ok else 'TIMEOUT', flush=True)
        if not ok: break
    elif 'file' in s:
        end = time.time() + s.get('timeout', 120)
        while time.time() < end and not os.path.exists(s['file']): pump(0.5)
    elif 'shell' in s:
        out = subprocess.run(s['shell'], shell=True, capture_output=True, text=True)
        print('[shell]', s['shell'][:80], '->', out.returncode, (out.stdout + out.stderr).strip()[:300], flush=True)
    elif 'mark' in s: log.write(f"\n=====MARK {s['mark']}=====\n".encode())
try: os.kill(pid, 9)
except Exception: pass
