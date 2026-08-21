import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  coingeckoG2RawSchema,
  coingeckoOhlcv30sRawSchema,
  gmgnHotSearchesRawSchema,
  gmgnTrendingRawSchema,
} from './raw-schemas.js';

const fixtureRoot = path.resolve('src/test/fixtures/providers');

async function validateFixture(
  name: string,
  parser: { parse: (value: unknown) => unknown },
): Promise<void> {
  const value = JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8')) as unknown;
  parser.parse(value);
  console.log(`PASS fixture ${name}`);
}

await validateFixture('gmgn-trending.json', gmgnTrendingRawSchema);
await validateFixture('gmgn-hot-searches.json', gmgnHotSearchesRawSchema);
await validateFixture('coingecko-g2.json', coingeckoG2RawSchema);
await validateFixture('coingecko-ohlcv-30s.json', coingeckoOhlcv30sRawSchema);

if (process.argv.includes('--live')) {
  const run = (script: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        cwd: process.cwd(),
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${script} exited with ${code ?? 'unknown'}`)),
      );
    });
  await run('scripts/gmgn-real-contract.mjs');
  await run('scripts/coingecko-real-contract.mjs');
  console.log('Live contract scripts completed and refreshed redacted preflight results.');
  console.log(
    'No key values, Authorization headers, or full authenticated URLs are written by this command.',
  );
}
