import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../persistence/db.js';
import { backupDatabase, restoreDatabaseBackup, verifyDatabaseBackup } from './backup.js';

test('backup retention and restore verify SQLite integrity', async () => {
  const directory = mkdtempSync(path.join('/tmp', 'bot-backup-'));
  const database = openDatabase(path.join(directory, 'source.sqlite'));
  database.prepare('CREATE TABLE sample (value TEXT)').run();
  database.prepare('INSERT INTO sample VALUES (?)').run('ok');
  const first = await backupDatabase({
    database,
    directory,
    runId: 'one',
    retention: 1,
    pageBatch: 2,
    minimumFreeBytes: 1,
  });
  verifyDatabaseBackup(first);
  const restored = path.join(directory, 'restored.sqlite');
  restoreDatabaseBackup(first, restored);
  const check = openDatabase(restored);
  assert.equal(check.prepare('SELECT value FROM sample').pluck().get(), 'ok');
  check.close();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
