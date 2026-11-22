// Platform doctor checks the service adds to `agentbridge doctor` (§11.2, §12.5, §13): Claude Code (via the Claude
// adapter's doctor: version, node, crossSessionInbound, deny rules, bare mode), the presence helper, the launchd agent,
// and the relay (health + a signed pending check). Each source is a seam so tests need no real machine state.
import type { DoctorCheck, SecretStore } from '@agentbridge/protocol';
import { loadIdentity, relayHealth, relayPending } from './relay/identity.ts';
import type { Policy } from './policy/policy.ts';

export interface PlatformDoctorOptions {
  /** ClaudeCodeAdapter.doctor() */
  claude?: () => Promise<DoctorCheck[]>;
  /** presence verifyHelper(): resolves { path, version } or throws with a fix-it message. */
  helper?: () => Promise<{ path: string; version: string }>;
  launchd?: () => Promise<'running' | 'stopped' | 'not_installed'>;
  /** Checks of the plist's program (node + entry exist, node runs, node path stable). */
  launchdProgram?: () => Promise<DoctorCheck[]>;
  /** Is a manually started bridge running instead of the launchd job? */
  launchdOwner?: () => Promise<DoctorCheck | null>;
  /** Relay checks need the policy (URL) and the identity keys. */
  relay?: { policy: () => Policy | null; secrets: SecretStore | null; fetch?: typeof fetch; connected?: () => boolean | null };
}

export async function platformDoctor(o: PlatformDoctorOptions): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  if (o.claude) {
    try { out.push(...(await o.claude())); } catch (e) { out.push({ id: 'claude_code', ok: false, detail: `Claude Code checks failed: ${(e as Error).message}` }); }
  }
  if (o.helper) {
    try { const h = await o.helper(); out.push({ id: 'presence_helper', ok: true, detail: `presence helper ${h.version} at ${h.path}` }); }
    catch (e) { out.push({ id: 'presence_helper', ok: false, detail: (e as Error).message, fix: 'npm run build:helper -w @agentbridge/presence' }); }
  }
  if (o.launchd) {
    try {
      const s = await o.launchd();
      out.push({ id: 'launchd', ok: s === 'running', detail: `launchd agent ${s.replace('_', ' ')}`, ...(s === 'running' ? {} : { fix: 'agentbridge init (installs the login service)' }) });
    } catch (e) { out.push({ id: 'launchd', ok: false, detail: `launchd status failed: ${(e as Error).message}` }); }
  }
  if (o.launchdOwner) {
    try { const c = await o.launchdOwner(); if (c) out.push(c); } catch (e) { out.push({ id: 'launchd_owner', ok: false, detail: `launchd owner check failed: ${(e as Error).message}` }); }
  }
  if (o.launchdProgram) {
    try { out.push(...(await o.launchdProgram())); } catch (e) { out.push({ id: 'launchd_program', ok: false, detail: `launchd plist check failed: ${(e as Error).message}` }); }
  }
  if (o.relay) {
    const pol = o.relay.policy();
    const url = pol?.transport.relay_url;
    if (!url) out.push({ id: 'relay', ok: false, detail: 'relay URL unknown (policy unavailable)' });
    else {
      const f = o.relay.fetch ?? fetch;
      try {
        const h = await relayHealth(url, f);
        out.push({ id: 'relay_health', ok: h.ok, detail: `relay ${url} ${h.ok ? `reachable (${h.ms} ms)` : `answered ${h.status}`}` });
      } catch (e) { out.push({ id: 'relay_health', ok: false, detail: `relay ${url} unreachable: ${(e as Error).message}`, fix: 'check the network or transport.relay_url' }); }
      if (o.relay.secrets) try {
        const id = await loadIdentity(o.relay.secrets);
        if (!id) out.push({ id: 'relay_identity', ok: false, detail: 'no identity keys yet', fix: 'agentbridge init' });
        else {
          const p = await relayPending(url, id, f);
          const conn = o.relay.connected?.();
          out.push({ id: 'relay_identity', ok: true, detail: `relay knows identity ${id.userId}; ${p.pending} waiting${conn === null || conn === undefined ? '' : conn ? '; connected' : '; idle (on demand)'}` });
        }
      } catch (e) { out.push({ id: 'relay_identity', ok: false, detail: `signed relay check failed: ${(e as Error).message}`, fix: 'agentbridge init (registers the identity with the relay)' }); }
    }
  }
  return out;
}
