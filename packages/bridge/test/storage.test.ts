import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, migrate, schemaVersion, SchemaTooNewError, Db } from '../src/db/db.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/db/migrations.ts';
import { DatabaseSync } from 'node:sqlite';

const tmp = (): string => mkdtempSync('/tmp/ab-st-');

test('storage: creates file 0600 in WAL mode with the current schema', () => {
  const dir = tmp();
  try {
    const db = openDatabase(join(dir, 'x', 'agentbridge.db'));
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal((statSync(join(dir, 'x', 'agentbridge.db')).mode & 0o777), 0o600);
    assert.equal((statSync(join(dir, 'x')).mode & 0o777), 0o700);
    assert.equal(db.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode, 'wal');
    for (const t of ['participants', 'sessions', 'bots', 'conversations', 'messages', 'deliveries', 'idempotency', 'policy', 'events', 'schema_version'])
      assert.ok(db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, t), t);
    db.close();
    // reopening is idempotent
    const db2 = openDatabase(join(dir, 'x', 'agentbridge.db'));
    assert.equal(db2.all('SELECT * FROM schema_version').length, MIGRATIONS.length);
    db2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('storage: refuses to start on a newer schema', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'a.db');
    openDatabase(path).close();
    const raw = new DatabaseSync(path); raw.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(SCHEMA_VERSION + 1, 'future', 0); raw.close();
    assert.throws(() => openDatabase(path), SchemaTooNewError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('storage: migrations are transactional (a failing migration leaves no trace)', () => {
  const db = new Db(new DatabaseSync(':memory:'));
  const ms = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, name: 'bad', sql: 'CREATE TABLE t_ok (a); CREATE TABLE participants (x);' }];
  assert.throws(() => migrate(db, ms));
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  assert.equal(db.get(`SELECT name FROM sqlite_master WHERE name='t_ok'`), undefined);
  // the good migration applies
  migrate(db, [...MIGRATIONS, { version: SCHEMA_VERSION + 1, name: 'good', sql: 'CREATE TABLE t_ok (a);' }]);
  assert.equal(schemaVersion(db), SCHEMA_VERSION + 1);
});

test('storage: tx rolls back on error and nests', () => {
  const db = openDatabase(':memory:');
  db.raw.exec('CREATE TABLE k (v)');
  assert.throws(() => db.tx(() => { db.run('INSERT INTO k VALUES (1)'); db.tx(() => db.run('INSERT INTO k VALUES (2)')); throw new Error('x'); }));
  assert.equal(db.all('SELECT * FROM k').length, 0);
  db.tx(() => { db.run('INSERT INTO k VALUES (1)'); db.tx(() => db.run('INSERT INTO k VALUES (2)')); });
  assert.equal(db.all('SELECT * FROM k').length, 2);
});
