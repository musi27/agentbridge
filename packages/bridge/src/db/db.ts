// SQLite via node:sqlite (no native deps). File 0600, WAL, versioned transactional migrations (§15.1, §15.4).
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, type Migration } from './migrations.ts';

export class SchemaTooNewError extends Error {
  readonly found: number; readonly supported: number;
  constructor(found: number, supported: number) {
    super(`database schema version ${found} is newer than this agentbridge understands (${supported}); upgrade agentbridge`);
    this.found = found; this.supported = supported;
  }
}

export type Row = Record<string, string | number | bigint | null | Uint8Array>;
type Param = string | number | bigint | null | Uint8Array;

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;
  constructor(raw: DatabaseSync) { this.raw = raw; }

  run(sql: string, ...params: Param[]): { changes: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }
  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }
  /** Run `fn` in a transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) { this.depth++; try { return fn(); } finally { this.depth--; } }
    this.raw.exec('BEGIN IMMEDIATE'); this.depth = 1;
    try { const r = fn(); this.raw.exec('COMMIT'); return r; }
    catch (e) { this.raw.exec('ROLLBACK'); throw e; }
    finally { this.depth = 0; }
  }
  close(): void { if (this.raw.isOpen) this.raw.close(); }
}

export function schemaVersion(db: Db): number {
  const t = db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_version'");
  if (!t || t.n === 0) return 0;
  const r = db.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_version');
  return r?.v ?? 0;
}

/** Apply pending migrations, each in its own transaction. Refuses a schema newer than `migrations`. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS, now = Date.now()): number {
  const supported = migrations.at(-1)?.version ?? 0;
  db.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const current = schemaVersion(db);
  if (current > supported) throw new SchemaTooNewError(current, supported);
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.tx(() => {
      db.raw.exec(m.sql);
      db.run('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, now);
    });
  }
  return schemaVersion(db);
}

/** Open (creating if needed) the bridge database. `path` ':memory:' is for tests. */
export function openDatabase(path: string, opts: { migrations?: readonly Migration[] } = {}): Db {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const raw = new DatabaseSync(path);
  const db = new Db(raw);
  try {
    db.raw.exec('PRAGMA foreign_keys = ON');
    db.raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      db.raw.exec('PRAGMA journal_mode = WAL');
      for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
    }
    migrate(db, opts.migrations);
    return db;
  } catch (e) { db.close(); throw e; }
}
