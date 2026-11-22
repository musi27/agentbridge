// Socket peer identification (§10). Node exposes no SO_PEERCRED/LOCAL_PEERPID, so on macOS we ask `lsof`
// which process holds the other end of the accepted Unix socket, then `ps` for its parent and uid.
// Best effort by design (§2.3): `null` means "unknown", and the socket's 0600 mode in a 0700 dir is the
// primary same-user barrier.
import { execFile } from 'node:child_process';
import type { Socket } from 'node:net';

export interface ProcInfo { pid: number; ppid: number; uid: number }

export interface PeerResolver {
  /** PID of the process on the other end of `socket`, or null if unknown. */
  peerPid(socket: Socket): Promise<number | null>;
  proc(pid: number): Promise<ProcInfo | null>;
}

function run(cmd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (e, out) => resolve(e ? null : out));
  });
}

/** macOS: match our socket's kernel address against the `->0x…` peer field of every Unix socket. */
export class LsofPeerResolver implements PeerResolver {
  async peerPid(socket: Socket): Promise<number | null> {
    const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
    if (typeof fd !== 'number' || fd < 0) return null;
    const mine = await run('lsof', ['-a', '-p', String(process.pid), '-d', String(fd), '-U', '-F', 'd']);
    const addr = mine && /^d(0x[0-9a-f]+)$/m.exec(mine)?.[1];
    if (!addr) return null;
    const all = await run('lsof', ['-U', '-F', 'pn']);
    if (!all) return null;
    let pid: number | null = null;
    for (const line of all.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line === `n->${addr}` && pid !== null) return pid;
    }
    return null;
  }
  async proc(pid: number): Promise<ProcInfo | null> {
    const out = await run('ps', ['-o', 'ppid=,uid=', '-p', String(pid)]);
    const m = out && /^\s*(\d+)\s+(\d+)\s*$/.exec(out.trim());
    return m ? { pid, ppid: Number(m[1]), uid: Number(m[2]) } : null;
  }
}

/** Is `ancestor` the direct parent of `pid` (§10: hooks and the MCP server are direct children of claude)? null = unknown. */
export async function isDescendant(r: PeerResolver, pid: number, ancestor: number, maxDepth = 1): Promise<boolean | null> {
  let cur = pid;
  for (let i = 0; i < maxDepth; i++) {
    const p = await r.proc(cur);
    if (!p) return i === 0 ? null : false;
    if (p.ppid === ancestor) return true;
    if (p.ppid <= 1) return false;
    cur = p.ppid;
  }
  return false;
}
