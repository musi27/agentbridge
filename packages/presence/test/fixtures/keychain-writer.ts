// Child process for the concurrent-writers test: <stateDir> <fake keychain state file> <prefix> <count>
import { MacKeychainStore } from '../../src/keychain.ts';
import { FakeKeychain } from '../fake-keychain.ts';

const [stateDir, statePath, prefix, count] = process.argv.slice(2) as [string, string, string, string];
const fk = new FakeKeychain({ statePath });
const s = new MacKeychainStore({ runner: fk.runner, helperPath: fk.helperPath, stateDir, service: 'agentbridge.test.concurrent' });
for (let i = 0; i < Number(count); i++) await s.set(`${prefix}.${i}`, `v-${prefix}-${i}`);
