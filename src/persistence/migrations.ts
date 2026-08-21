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
];
