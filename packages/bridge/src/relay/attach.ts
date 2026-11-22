// Start the relay client for a running bridge service (§13.2): identity from the SecretStore, settings from the signed
// policy, Grok calls into the service's RelayLink. Shared by `agentbridge serve` / the launchd entry and the e2e test.
import type { SecretStore } from '@agentbridge/protocol';
import type { BridgeService } from '../service.ts';
import { loadIdentity } from './identity.ts';
import { RelayRuntime, type RelayClientFactory } from './runtime.ts';

export interface ServiceRelayOptions { factory?: RelayClientFactory; clientOptions?: Record<string, unknown>; log?(line: string): void }

/** Returns the running relay runtime, or null (with a logged reason) when there is no identity yet or policy failed. */
export async function startServiceRelay(svc: BridgeService, secrets: SecretStore, o: ServiceRelayOptions = {}): Promise<RelayRuntime | null> {
  const log = o.log ?? (() => {});
  const identity = await loadIdentity(secrets);
  if (!identity) { log('relay: no identity yet (run agentbridge init); Grok features are off'); return null; }
  const ps = svc.engine.policyStore.current();
  if (!ps.ok) { log('relay: policy integrity failed; relay not started'); return null; }
  const rt = await RelayRuntime.start({
    engine: svc.engine, store: svc.store, policy: ps.policy, identity, log,
    onCall: (c) => svc.relay.handleCall(c),
    beforeStart: (client, endpoint) => svc.relay.attach(client, endpoint),
    ...(o.factory ? { factory: o.factory } : {}), ...(o.clientOptions ? { clientOptions: o.clientOptions } : {}),
  });
  log(`relay: ${ps.policy.transport.relay_mode} connection to ${ps.policy.transport.relay_url} as ${identity.userId}`);
  return rt;
}
