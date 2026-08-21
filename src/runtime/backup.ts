import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { SqliteDatabase } from '../persistence/db.js';

export async function backupDatabase(input: {
  database: SqliteDatabase;
  directory: string;
  runId: string;
  retention: number;
  pageBatch: number;
  minimumFreeBytes?: number;
}): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.runId)) throw new Error('Invalid backup run id');
  if (!Number.isInteger(input.retention) || input.retention <= 0)
    throw new Error('Invalid backup retention');
  if (!Number.isInteger(input.pageBatch) || input.pageBatch <= 0)
    throw new Error('Invalid backup page batch');
  mkdirSync(input.directory, { recursive: true });
  const filesystem = statfsSync(input.directory);
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (freeBytes < (input.minimumFreeBytes ?? 1)) throw new Error('Insufficient disk for backup');
  const destination = path.join(input.directory, `bot-${input.runId}.sqlite`);
  const temporary = `${destination}.tmp`;
  rmSync(temporary, { force: true });
  await input.database.backup(temporary, { progress: () => input.pageBatch });
  rmSync(destination, { force: true });
  renameSync(temporary, destination);
  const backups = readdirSync(input.directory)
    .filter((name) => /^bot-[a-zA-Z0-9_-]+\.sqlite$/u.test(name))
    .map((name) => ({ name, mtime: statSync(path.join(input.directory, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  for (const backup of backups.slice(input.retention))
    rmSync(path.join(input.directory, backup.name), { force: true });
  return destination;
}

export function verifyDatabaseBackup(filename: string): void {
  const database = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const result = database.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`Backup integrity check failed: ${String(result)}`);
  } finally {
    database.close();
  }
}

export function restoreDatabaseBackup(filename: string, destination: string): void {
  verifyDatabaseBackup(filename);
  mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  const temporary = `${destination}.restore.tmp`;
  rmSync(temporary, { force: true });
  copyFileSync(filename, temporary);
  verifyDatabaseBackup(temporary);
  rmSync(destination, { force: true });
  renameSync(temporary, destination);
}
