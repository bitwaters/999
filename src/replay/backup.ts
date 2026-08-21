import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { statfsSync } from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase } from '../persistence/db.js';

export type ReplayBackupOptions = {
  destination: string;
  runId?: number;
  pageBatch: number;
  minimumFreeBytes: number;
  onProgress?: (remainingPages: number, totalPages: number) => void;
};

export async function createReplayBackup(
  source: SqliteDatabase,
  options: ReplayBackupOptions,
): Promise<{ destination: string; totalPages: number }> {
  if (!Number.isInteger(options.pageBatch) || options.pageBatch <= 0)
    throw new Error('Invalid replay backup page batch');
  if (!Number.isSafeInteger(options.minimumFreeBytes) || options.minimumFreeBytes < 0)
    throw new Error('Invalid replay backup disk threshold');
  const directory = path.dirname(path.resolve(options.destination));
  mkdirSync(directory, { recursive: true });
  const filesystem = statfsSync(directory);
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (freeBytes < options.minimumFreeBytes) throw new Error('Insufficient disk for replay backup');
  const temporary = options.runId
    ? path.join(directory, `replay-${options.runId}.sqlite.tmp`)
    : `${options.destination}.run-${process.pid}-${Date.now()}.tmp`;
  rmSync(temporary, { force: true });
  try {
    const metadata = await source.backup(temporary, {
      progress: (info) => {
        options.onProgress?.(info.remainingPages, info.totalPages);
        return options.pageBatch;
      },
    });
    rmSync(options.destination, { force: true });
    renameSync(temporary, options.destination);
    return { destination: options.destination, totalPages: metadata.totalPages };
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function cleanupReplayTemporary(directory: string, runId: number): void {
  if (!Number.isInteger(runId) || runId <= 0) throw new Error('Invalid replay run id');
  rmSync(path.join(path.resolve(directory), `replay-${runId}.sqlite.tmp`), { force: true });
}
