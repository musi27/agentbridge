// Every secret name the bridge may have saved (for the keychain's one-time move from one item per secret, and for
// uninstall --purge-data). Per-bot names need the bot ids, which live in the database.
import { existsSync } from 'node:fs';
import { allSecretNames } from '@agentbridge/protocol';

/** Bot ids from the database at `dbPath`; [] when there is none, null when it can't be read. */
export async function knownBotIds(dbPath: string): Promise<string[] | null> {
  if (!existsSync(dbPath)) return [];
  try {
    const { openDatabase } = await import('../db/db.ts'); const { Store } = await import('../db/store.ts');
    const db = openDatabase(dbPath);
    try { return new Store(db).bots().map((b) => b.bot_id); } finally { db.close(); }
  } catch { return null; }
}

export async function knownSecretNames(dbPath: string): Promise<string[]> {
  return allSecretNames((await knownBotIds(dbPath)) ?? []);
}
