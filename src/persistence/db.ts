import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrations, type Migration } from './migrations.js';

export type SqliteDatabase = Database.Database;

export type DatabaseOptions = {
  busyTimeoutMs?: number;
  migrationsOverride?: Migration[];
};

export function openDatabase(filename: string, options: DatabaseOptions = {}): SqliteDatabase {
  if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const database = new Database(filename);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 1000}`);
  runMigrations(database, options.migrationsOverride ?? migrations);
  return database;
}

export function runMigrations(database: SqliteDatabase, pending: Migration[]): void {
  const currentVersion = Number(database.pragma('user_version', { simple: true }));
  const ordered = [...pending].sort((a, b) => a.version - b.version);
  let expectedVersion = currentVersion + 1;
  for (const migration of ordered) {
    if (migration.version <= currentVersion) continue;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration sequence gap: expected ${expectedVersion}, received ${migration.version}`,
      );
    }
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      database.pragma(`user_version = ${migration.version}`);
    });
    apply();
    expectedVersion += 1;
  }
}

export function schemaVersion(database: SqliteDatabase): number {
  return Number(database.pragma('user_version', { simple: true }));
}
