import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Migration = { version: number; name: string; sql: string };

export const migrations: Migration[] = [
  {
    version: 1,
    name: '001_initial',
    sql: readFileSync(
      fileURLToPath(new URL('./migrations/001_initial.sql', import.meta.url)),
      'utf8',
    ),
  },
  {
    version: 2,
    name: '002_outcome_latency',
    sql: readFileSync(
      fileURLToPath(new URL('./migrations/002_outcome_latency.sql', import.meta.url)),
      'utf8',
    ),
  },
  {
    version: 3,
    name: '003_pool_retry_backoff',
    sql: readFileSync(
      fileURLToPath(new URL('./migrations/003_pool_retry_backoff.sql', import.meta.url)),
      'utf8',
    ),
  },
];
