#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultDirectory = path.join(root, 'preflight-results');
const resultPath = path.join(resultDirectory, 'gmgn-load.json');
const pacingMs = Number(process.env.GMGN_LOAD_PACING_MS || 5200);
const pacedCalls = Number(process.env.GMGN_LOAD_PACED_CALLS || 4);
const concurrency = Number(process.env.GMGN_LOAD_CONCURRENCY || 2);

function envValue(text, key) {
  const line = text.split(/\r?\n/u).find((item) => item.startsWith(`${key}=`));
  return line
    ? line
        .slice(key.length + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/u, '$2')
    : '';
}

function redact(text, apiKey) {
  return String(text || '')
    .replaceAll(apiKey, '[REDACTED]')
    .replace(/(api[_-]?key|token|authorization)[=:][^\s,&]+/giu, '$1=[REDACTED]')
    .slice(0, 500);
}

function classifyError(message) {
  if (/429|rate.?limit|too many requests/iu.test(message)) return 'rate_limited';
  if (/ban|banned|temporar(y|ily)/iu.test(message)) return 'temporarily_banned';
  return 'request_failed';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCli(args, apiKey) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', 'gmgn-cli', ...args, '--raw'], {
      cwd: root,
      env: { ...process.env, GMGN_API_KEY: apiKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: String(error) });
    });
  });
}

async function probe(name, chain, apiKey) {
  const startedAt = performance.now();
  const response = await runCli(
    ['market', 'trending', '--chain', chain, '--interval', '1m', '--limit', '1'],
    apiKey,
  );
  const latencyMs = Math.round(performance.now() - startedAt);
  if (response.code !== 0) {
    const error = redact(response.stderr || response.stdout, apiKey);
    return {
      name,
      chain,
      ok: false,
      latency_ms: latencyMs,
      error_type: classifyError(error),
      error,
    };
  }
  try {
    const json = JSON.parse(response.stdout);
    const rows = json?.data?.rank;
    if (!Array.isArray(rows)) throw new Error('missing data.rank');
    return { name, chain, ok: true, latency_ms: latencyMs, row_count: rows.length };
  } catch (error) {
    const message = redact(error.message, apiKey);
    return {
      name,
      chain,
      ok: false,
      latency_ms: latencyMs,
      error_type: 'invalid_response',
      error: message,
    };
  }
}

const envText = await readFile(path.join(root, '.env.preflight'), 'utf8').catch(() => '');
const apiKey = process.env.GMGN_API_KEY?.trim() || envValue(envText, 'GMGN_API_KEY');
if (!apiKey) throw new Error('缺少 GMGN_API_KEY');
if (
  ![pacingMs, pacedCalls, concurrency].every(Number.isFinite) ||
  pacingMs < 1000 ||
  pacedCalls < 1 ||
  pacedCalls > 10 ||
  concurrency < 1 ||
  concurrency > 4
) {
  throw new Error('负载参数无效：pacing >= 1000ms，calls 1-10，concurrency 1-4');
}

const concurrencyChains = Array.from({ length: concurrency }, (_, index) =>
  index % 2 ? 'bsc' : 'sol',
);
const concurrencyStartedAt = new Date().toISOString();
const concurrencyResults = await Promise.all(
  concurrencyChains.map((chain, index) => probe(`concurrency.${index + 1}`, chain, apiKey)),
);
const hitLimit = (result) =>
  result.error_type === 'rate_limited' || result.error_type === 'temporarily_banned';
const pacedResults = [];
if (!concurrencyResults.some(hitLimit)) {
  for (let index = 0; index < pacedCalls; index += 1) {
    if (index > 0) await delay(pacingMs);
    const result = await probe(`paced.${index + 1}`, index % 2 ? 'bsc' : 'sol', apiKey);
    pacedResults.push(result);
    if (hitLimit(result)) break;
  }
}

const results = [...concurrencyResults, ...pacedResults];
const rateLimitResults = results.filter(hitLimit);
const output = {
  tested_at: new Date().toISOString(),
  safety: {
    retries: 0,
    stops_on_rate_limit_or_ban: true,
    swap_commands: false,
    concurrency_requested: concurrency,
    pacing_ms: pacingMs,
  },
  concurrency: {
    started_at: concurrencyStartedAt,
    attempted: concurrencyResults.length,
    passed: concurrencyResults.filter((result) => result.ok).length,
    results: concurrencyResults,
  },
  paced: {
    attempted: pacedResults.length,
    passed: pacedResults.filter((result) => result.ok).length,
    results: pacedResults,
  },
  reset_or_ban_signal: rateLimitResults.length ? rateLimitResults[0] : 'not_observed',
  production_recommendation: 'hold_shadow',
};

await mkdir(resultDirectory, { recursive: true });
await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
