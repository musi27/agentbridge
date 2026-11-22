// Local relay: node scripts/dev-server.ts [port]. In-memory store unless REDIS_URL is set; RELAY_KEY_PREFIX applies.
import { relayFromEnv } from '../src/env.ts';

const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
relayFromEnv().server.listen(port, '127.0.0.1', () => console.log(`agentbridge relay on http://127.0.0.1:${port}`));
