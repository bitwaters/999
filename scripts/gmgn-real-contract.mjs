#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { redactSecrets } from './redact.mjs';
import { sanitizeGmgnFixture } from './gmgn-fixture.mjs';

const root = new URL('../', import.meta.url);
const resultDir = new URL('../preflight-results/', import.meta.url);

function envValue(text, key) {
  const line = text.split(/\r?\n/u).find((item) => item.startsWith(`${key}=`));
  return line
    ? line
        .slice(key.length + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/u, '$2')
    : '';
}

function runCli(args, apiKey) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', 'gmgn-cli', ...args, '--raw'], {
      cwd: root,
      env: { ...process.env, GMGN_API_KEY: apiKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `exit ${code}`));
    });
  });
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function shape(value, depth = 0) {
  if (depth > 3) return valueType(value);
  if (Array.isArray(value))
    return {
      type: 'array',
      length: value.length,
      item: value.length ? shape(value[0], depth + 1) : null,
    };
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shape(item, depth + 1)]),
    );
  }
  return valueType(value);
}

function countPrimary(json) {
  if (Array.isArray(json)) return json.length;
  for (const key of [
    'rank',
    'list',
    'data',
    'holders',
    'traders',
    'new_creation',
    'near_completion',
    'completed',
  ]) {
    const value = json?.[key] ?? json?.data?.[key];
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

async function test(name, args, apiKey) {
  const startedAt = performance.now();
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const raw = await runCli(args, apiKey);
      const json = JSON.parse(raw);
      const result = {
        name,
        ok: true,
        attempts: attempt,
        latency_ms: Math.round(performance.now() - startedAt),
        count: countPrimary(json),
        shape: shape(json),
      };
      results.push(result);
      console.log(`PASS ${name} (${result.latency_ms}ms, attempts=${attempt})`);
      await delay(1000);
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 1000);
    }
  }
  const result = {
    name,
    ok: false,
    attempts: 3,
    latency_ms: Math.round(performance.now() - startedAt),
    error: redactSecrets(String(lastError?.message || lastError), [apiKey]).slice(0, 500),
  };
  results.push(result);
  console.log(`FAIL ${name} — ${result.error}`);
  return null;
}

const envText = await readFile(new URL('../.env.preflight', import.meta.url), 'utf8').catch(
  () => '',
);
const apiKey = process.env.GMGN_API_KEY?.trim() || envValue(envText, 'GMGN_API_KEY');
if (!apiKey) throw new Error('缺少 GMGN_API_KEY');

const fixtureDir = process.env.GMGN_FIXTURE_DIR ? path.resolve(process.env.GMGN_FIXTURE_DIR) : null;

async function writeFixture(name, value) {
  if (!fixtureDir || value === null || value === undefined) return;
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(
    path.join(fixtureDir, name),
    `${JSON.stringify(sanitizeGmgnFixture(value, [apiKey]), null, 2)}\n`,
  );
}

const samples = {};
for (const chain of ['sol', 'bsc']) {
  for (const interval of ['1m', '5m', '1h', '6h', '24h']) {
    const json = await test(
      `trending.${chain}.${interval}`,
      ['market', 'trending', '--chain', chain, '--interval', interval, '--limit', '3'],
      apiKey,
    );
    if (interval === '1m') await writeFixture(`gmgn-trending-${chain}.json`, json);
    const address = json?.data?.rank?.[0]?.address;
    if (!samples[chain] && address) samples[chain] = address;
  }
  for (const interval of ['1m', '5m', '1h', '6h', '24h']) {
    const json = await test(
      `hot-searches.${chain}.${interval}`,
      ['market', 'hot-searches', '--chain', chain, '--interval', interval, '--limit', '3'],
      apiKey,
    );
    if (interval === '1m') await writeFixture(`gmgn-hot-searches-${chain}.json`, json);
  }
  await test(`trenches.${chain}`, ['market', 'trenches', '--chain', chain, '--limit', '2'], apiKey);
  await test(`signals.${chain}`, ['market', 'signal', '--chain', chain], apiKey);
  await test(
    `smartmoney.${chain}`,
    ['track', 'smartmoney', '--chain', chain, '--limit', '3'],
    apiKey,
  );
  await test(`kol.${chain}`, ['track', 'kol', '--chain', chain, '--limit', '3'], apiKey);

  const address = samples[chain];
  if (!address) continue;
  await test(
    `token.info.${chain}`,
    ['token', 'info', '--chain', chain, '--address', address],
    apiKey,
  );
  const security = await test(
    `token.security.${chain}`,
    ['token', 'security', '--chain', chain, '--address', address],
    apiKey,
  );
  await writeFixture(`gmgn-security-${chain}.json`, security);
  await test(
    `token.pool.${chain}`,
    ['token', 'pool', '--chain', chain, '--address', address],
    apiKey,
  );
  await test(
    `token.holders.${chain}`,
    ['token', 'holders', '--chain', chain, '--address', address, '--limit', '5'],
    apiKey,
  );
  await test(
    `token.traders.${chain}`,
    ['token', 'traders', '--chain', chain, '--address', address, '--limit', '5'],
    apiKey,
  );
  for (const resolution of ['30s', '1m', '5m', '15m', '1h', '4h', '1d']) {
    await test(
      `kline.${chain}.${resolution}`,
      ['market', 'kline', '--chain', chain, '--address', address, '--resolution', resolution],
      apiKey,
    );
  }
}

await mkdir(resultDir, { recursive: true });
await writeFile(
  new URL('gmgn-contract.json', resultDir),
  `${JSON.stringify(
    {
      tested_at: new Date().toISOString(),
      cli: 'gmgn-cli',
      chains: ['sol', 'bsc'],
      samples,
      summary: {
        total: results.length,
        passed: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok).length,
      },
      results,
    },
    null,
    2,
  )}\n`,
);

const failedCount = results.filter((item) => !item.ok).length;
console.log(
  `DONE total=${results.length} passed=${results.length - failedCount} failed=${failedCount}`,
);
if (failedCount > 0) process.exitCode = 1;
