// Addresses `<agent>:<name>` (§5). Names are labels; ids are identity.
import { AGENT_TYPES, type AgentType } from './enums.ts';
import { LIMITS } from './limits.ts';

export const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export interface Address { agent: AgentType; name: string }

export function parseAddress(s: string): Address | null {
  const i = s.indexOf(':');
  if (i <= 0) return null;
  const agent = s.slice(0, i); const name = s.slice(i + 1);
  if (!(AGENT_TYPES as readonly string[]).includes(agent) || !NAME_RE.test(name)) return null;
  return { agent: agent as AgentType, name };
}

export const formatAddress = (a: Address): string => `${a.agent}:${a.name}`;

/** Turn any display name into a valid address name; never returns ''. */
export function slugifyName(display: string): string {
  const s = display.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, LIMITS.nameChars);
  return s || 'unnamed';
}
