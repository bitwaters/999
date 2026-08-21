#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from './redact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  await readFile(path.join(root, 'config/preflight-sampling.json'), 'utf8'),
);
const envText = await readFile(path.join(root, '.env.preflight'), 'utf8').catch(() => '');

function envValue(key) {
  const processValue = process.env[key]?.trim();
  if (processValue) return processValue;
  const line = envText.split(/\r?\n/u).find((item) => item.startsWith(`${key}=`));
  return line
    ? line
        .slice(key.length + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/u, '$2')
    : '';
}

const gmgnKey = envValue('GMGN_API_KEY');
const cgKey = envValue('COINGECKO_PRO_API_KEY');
if (!gmgnKey || !cgKey) throw new Error('持续采样需要 GMGN_API_KEY 和 COINGECKO_PRO_API_KEY');
const gmgnCli = path.join(root, 'node_modules/gmgn-cli/dist/index.js');
await access(gmgnCli);

const storageDir = path.join(root, config.storage.directory);
await mkdir(storageDir, { recursive: true });
const db = new DatabaseSync(path.join(storageDir, config.storage.database));
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS provider_calls (
    id INTEGER PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    provider TEXT NOT NULL,
    capability TEXT NOT NULL,
    chain TEXT,
    ok INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    row_count INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_provider_calls_time ON provider_calls(observed_at);

  CREATE TABLE IF NOT EXISTS candidate_observations (
    id INTEGER PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    chain TEXT NOT NULL,
    interval TEXT,
    token_address TEXT NOT NULL,
    pool_hint TEXT,
    created_at INTEGER,
    opened_at INTEGER,
    rank INTEGER,
    price TEXT,
    price_change TEXT,
    volume TEXT,
    liquidity TEXT,
    market_cap TEXT,
    swaps INTEGER,
    buys INTEGER,
    sells INTEGER,
    holders INTEGER,
    visiting INTEGER,
    hot_level INTEGER,
    safety_json TEXT,
    payload_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_candidates_token_time ON candidate_observations(chain, token_address, observed_at);
  CREATE INDEX IF NOT EXISTS idx_candidates_created ON candidate_observations(chain, created_at);

  CREATE TABLE IF NOT EXISTS indexing_attempts (
    id INTEGER PRIMARY KEY,
    attempted_at INTEGER NOT NULL,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    created_at INTEGER,
    indexed INTEGER NOT NULL,
    pool_address TEXT,
    pool_created_at INTEGER,
    indexing_latency_seconds INTEGER,
    request_latency_ms INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_indexing_token_time ON indexing_attempts(chain, token_address, attempted_at);

  CREATE TABLE IF NOT EXISTS token_pools (
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    first_indexed_at INTEGER NOT NULL,
    pool_created_at INTEGER,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY(chain, token_address)
  );

  CREATE TABLE IF NOT EXISTS pool_snapshots (
    id INTEGER PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    pool_created_at INTEGER,
    reserve_usd TEXT,
    base_token_id TEXT,
    quote_token_id TEXT,
    transactions_json TEXT,
    volume_json TEXT,
    net_buy_json TEXT,
    price_change_json TEXT,
    payload_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pool_snapshots_time ON pool_snapshots(chain, pool_address, observed_at);

  CREATE TABLE IF NOT EXISTS websocket_events (
    id INTEGER PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    channel TEXT NOT NULL,
    chain TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    event_at INTEGER,
    tx_hash TEXT,
    side TEXT,
    token_amount TEXT,
    quote_amount TEXT,
    volume_usd TEXT,
    price_usd TEXT,
    candle_json TEXT,
    payload_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ws_time ON websocket_events(channel, chain, pool_address, observed_at);

  CREATE TABLE IF NOT EXISTS credit_samples (
    id INTEGER PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    plan TEXT,
    rpm INTEGER,
    monthly_credit INTEGER,
    used_credit INTEGER,
    remaining_credit INTEGER
  );
`);

const insertCall = db.prepare(`INSERT INTO provider_calls
  (observed_at, provider, capability, chain, ok, latency_ms, row_count, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insertCandidate = db.prepare(`INSERT INTO candidate_observations
  (observed_at, source, chain, interval, token_address, pool_hint, created_at, opened_at, rank, price, price_change, volume, liquidity, market_cap, swaps, buys, sells, holders, visiting, hot_level, safety_json, payload_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertIndexing = db.prepare(`INSERT INTO indexing_attempts
  (attempted_at, chain, token_address, first_seen_at, created_at, indexed, pool_address, pool_created_at, indexing_latency_seconds, request_latency_ms, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const upsertPool = db.prepare(`INSERT INTO token_pools
  (chain, token_address, pool_address, first_indexed_at, pool_created_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(chain, token_address) DO UPDATE SET pool_address=excluded.pool_address, pool_created_at=excluded.pool_created_at, last_seen_at=excluded.last_seen_at`);
const insertSnapshot = db.prepare(`INSERT INTO pool_snapshots
  (observed_at, chain, token_address, pool_address, pool_created_at, reserve_usd, base_token_id, quote_token_id, transactions_json, volume_json, net_buy_json, price_change_json, payload_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertWs = db.prepare(`INSERT INTO websocket_events
  (observed_at, channel, chain, pool_address, event_at, tx_hash, side, token_amount, quote_amount, volume_usd, price_usd, candle_json, payload_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertCredit = db.prepare(`INSERT INTO credit_samples
  (observed_at, plan, rpm, monthly_credit, used_credit, remaining_credit)
  VALUES (?, ?, ?, ?, ?, ?)`);

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function asText(value) {
  return value === null || value === undefined ? null : String(value);
}

function addressKey(chain, address) {
  return chain === 'bsc' && typeof address === 'string' ? address.toLowerCase() : address;
}

function safeError(value, limit = 500) {
  return redactSecrets(value, [gmgnKey, cgKey]).slice(0, limit);
}

function countRows(json) {
  if (Array.isArray(json)) return json.length;
  for (const value of [json?.data?.rank, json?.data, json?.list, json?.new_creation])
    if (Array.isArray(value)) return value.length;
  return null;
}

function gmgn(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gmgnCli, ...args, '--raw'], {
      cwd: root,
      env: { ...process.env, GMGN_API_KEY: gmgnKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      if (!settled) {
        settled = true;
        reject(new Error(`GMGN request timeout after ${config.gmgn.request_timeout_ms}ms`));
      }
    }, config.gmgn.request_timeout_ms);
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
    child.on('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      } else reject(new Error(stderr.trim() || `exit ${code}`));
    });
  });
}

let gmgnNextAllowedAt = 0;
let gmgnBlockedUntil = 0;
async function throttledGmgn(args) {
  const waitUntil = Math.max(gmgnNextAllowedAt, gmgnBlockedUntil);
  if (waitUntil > Date.now())
    await new Promise((resolve) => setTimeout(resolve, waitUntil - Date.now()));
  gmgnNextAllowedAt = Date.now() + config.gmgn.minimum_interval_ms;
  try {
    return await gmgn(args);
  } catch (error) {
    const message = String(error.message);
    if (message.includes('HTTP 429')) {
      const remaining = Number(message.match(/~(\d+)s remaining/u)?.[1] || 30);
      gmgnBlockedUntil = Date.now() + (remaining + 3) * 1000;
    }
    throw error;
  }
}

async function providerCall(provider, capability, chain, fn) {
  const startedAt = performance.now();
  try {
    const json = await fn();
    const latency = Math.round(performance.now() - startedAt);
    insertCall.run(Date.now(), provider, capability, chain, 1, latency, countRows(json), null);
    return { json, latency };
  } catch (error) {
    const latency = Math.round(performance.now() - startedAt);
    insertCall.run(
      Date.now(),
      provider,
      capability,
      chain,
      0,
      latency,
      null,
      safeError(error.message),
    );
    return { json: null, latency, error };
  }
}

async function cg(pathname) {
  const response = await fetch(`https://pro-api.coingecko.com/api/v3${pathname}`, {
    headers: { 'x-cg-pro-api-key': cgKey },
    signal: AbortSignal.timeout(20_000),
  });
  const json = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

function normalizeCandidate(token, source, chain, interval, observedAt, rank = null) {
  const address = token.address || token.token_address;
  if (!address) return;
  const safety =
    chain === 'sol'
      ? {
          renounced_mint: token.renounced_mint,
          renounced_freeze_account: token.renounced_freeze_account,
          rug_ratio: token.rug_ratio,
          bundler_rate: token.bundler_rate ?? token.bundler_trader_amount_rate,
          rat_trader_amount_rate: token.rat_trader_amount_rate,
          top_10_holder_rate: token.top_10_holder_rate,
          dev_team_hold_rate: token.dev_team_hold_rate,
          top70_sniper_hold_rate: token.top70_sniper_hold_rate,
        }
      : {
          is_honeypot: token.is_honeypot,
          is_renounced: token.is_renounced ?? token.owner_renounced,
          is_open_source: token.is_open_source ?? token.open_source,
          buy_tax: token.buy_tax,
          sell_tax: token.sell_tax,
          rug_ratio: token.rug_ratio,
          bundler_rate: token.bundler_rate ?? token.bundler_trader_amount_rate,
          rat_trader_amount_rate: token.rat_trader_amount_rate,
          top_10_holder_rate: token.top_10_holder_rate,
          dev_team_hold_rate: token.dev_team_hold_rate,
        };
  const selected = {
    source,
    chain,
    interval,
    address,
    pool: token.pool_address,
    created: token.creation_timestamp ?? token.created_timestamp,
    opened: token.open_timestamp,
    rank,
    price: token.price,
    price_change: token.price_change_percent,
    volume: token.volume ?? token.volume_24h,
    liquidity: token.liquidity,
    market_cap: token.market_cap ?? token.usd_market_cap,
    swaps: token.swaps ?? token.swaps_24h,
    buys: token.buys ?? token.buys_24h,
    sells: token.sells ?? token.sells_24h,
    holders: token.holder_count,
    visiting: token.visiting_count,
    hot_level: token.hot_level,
    safety,
  };
  insertCandidate.run(
    observedAt,
    source,
    chain,
    interval,
    address,
    selected.pool || null,
    selected.created || null,
    selected.opened || null,
    rank,
    asText(selected.price),
    asText(selected.price_change),
    asText(selected.volume),
    asText(selected.liquidity),
    asText(selected.market_cap),
    selected.swaps ?? null,
    selected.buys ?? null,
    selected.sells ?? null,
    selected.holders ?? null,
    selected.visiting ?? null,
    selected.hot_level ?? null,
    JSON.stringify(safety),
    hash(selected),
  );
}

async function collectDiscovery(tick) {
  const tasks = [];
  for (const chain of ['sol', 'bsc']) {
    for (const interval of config.gmgn.trending_intervals) {
      tasks.push(async () => {
        const observedAt = Date.now();
        const { json } = await providerCall('gmgn', `trending.${interval}`, chain, () =>
          throttledGmgn([
            'market',
            'trending',
            '--chain',
            chain,
            '--interval',
            interval,
            '--limit',
            String(config.gmgn.trending_limit),
          ]),
        );
        for (const [index, token] of (json?.data?.rank || []).entries())
          normalizeCandidate(token, 'trending', chain, interval, observedAt, index + 1);
      });
    }
    if (tick % config.gmgn.hot_search_every_ticks === 0) {
      tasks.push(async () => {
        const observedAt = Date.now();
        const interval = config.gmgn.hot_search_interval;
        const { json } = await providerCall('gmgn', `hot-searches.${interval}`, chain, () =>
          throttledGmgn([
            'market',
            'hot-searches',
            '--chain',
            chain,
            '--interval',
            interval,
            '--limit',
            String(config.gmgn.hot_search_limit),
          ]),
        );
        const group = Array.isArray(json) ? json.find((item) => item.chain === chain) : null;
        for (const [index, token] of (group?.tokens || []).entries())
          normalizeCandidate(token, 'hot-searches', chain, interval, observedAt, index + 1);
      });
    }
    if (tick % config.gmgn.trenches_every_ticks === 0) {
      tasks.push(async () => {
        const observedAt = Date.now();
        const { json } = await providerCall('gmgn', 'trenches', chain, () =>
          throttledGmgn([
            'market',
            'trenches',
            '--chain',
            chain,
            '--type',
            'new_creation',
            '--limit',
            String(config.gmgn.trenches_limit),
          ]),
        );
        for (const token of json?.new_creation || [])
          normalizeCandidate(token, 'trenches', chain, 'new_creation', observedAt);
      });
    }
  }
  for (const task of tasks) await task();
}

function recentCandidates(chain) {
  const cutoff = Date.now() - config.coingecko.pending_ttl_minutes * 60_000;
  const now = Date.now();
  const candidates = db
    .prepare(
      `
    SELECT c.token_address, MIN(c.observed_at) AS first_seen_at, MIN(c.created_at) AS created_at,
           (SELECT COUNT(*) FROM indexing_attempts i
            WHERE i.chain=c.chain AND i.token_address=c.token_address) AS indexing_attempts,
           (SELECT MAX(i.attempted_at) FROM indexing_attempts i
            WHERE i.chain=c.chain AND i.token_address=c.token_address) AS last_indexing_at
    FROM candidate_observations c
    LEFT JOIN token_pools p ON p.chain=c.chain AND p.token_address=c.token_address
    WHERE c.chain=? AND c.observed_at>=? AND p.token_address IS NULL
    GROUP BY c.token_address
    ORDER BY first_seen_at DESC
    LIMIT ?
  `,
    )
    .all(chain, cutoff, config.coingecko.max_tokens_per_chain * 20);
  return candidates
    .filter((candidate) => {
      if (candidate.last_indexing_at === null) return true;
      const attempt = Number(candidate.indexing_attempts ?? 0);
      const delaySeconds = Math.min(
        config.coingecko.index_retry_max_seconds,
        config.coingecko.index_retry_initial_seconds * 2 ** Math.min(Math.max(attempt - 1, 0), 30),
      );
      return now >= Number(candidate.last_indexing_at) + delaySeconds * 1000;
    })
    .slice(0, config.coingecko.max_tokens_per_chain);
}

async function collectIndexing() {
  for (const [chain, network] of [
    ['sol', 'solana'],
    ['bsc', 'bsc'],
  ]) {
    const candidates = recentCandidates(chain);
    if (!candidates.length) continue;
    const addresses = candidates.map((item) => item.token_address);
    const attemptedAt = Date.now();
    const { json, latency, error } = await providerCall(
      'coingecko',
      'tokens.multi.indexing',
      chain,
      () =>
        cg(`/onchain/networks/${network}/tokens/multi/${addresses.join(',')}?include=top_pools`),
    );
    const tokenMap = new Map(
      (json?.data || []).map((item) => [addressKey(chain, item.attributes?.address), item]),
    );
    const includedMap = new Map(
      (json?.included || []).filter((item) => item.type === 'pool').map((item) => [item.id, item]),
    );
    for (const candidate of candidates) {
      const token = tokenMap.get(addressKey(chain, candidate.token_address));
      const poolId = token?.relationships?.top_pools?.data?.[0]?.id;
      const pool = includedMap.get(poolId);
      const poolAddress =
        pool?.attributes?.address || (poolId ? poolId.replace(`${network}_`, '') : null);
      const poolCreatedAt = pool?.attributes?.pool_created_at
        ? Date.parse(pool.attributes.pool_created_at)
        : null;
      const indexed = Boolean(poolAddress);
      const baseTime = candidate.created_at ? candidate.created_at * 1000 : candidate.first_seen_at;
      const indexingLatency = indexed
        ? Math.max(0, Math.round((attemptedAt - baseTime) / 1000))
        : null;
      insertIndexing.run(
        attemptedAt,
        chain,
        candidate.token_address,
        candidate.first_seen_at,
        candidate.created_at || null,
        indexed ? 1 : 0,
        poolAddress,
        poolCreatedAt,
        indexingLatency,
        latency,
        error ? safeError(error.message) : null,
      );
      if (indexed)
        upsertPool.run(
          chain,
          candidate.token_address,
          poolAddress,
          attemptedAt,
          poolCreatedAt,
          attemptedAt,
        );
    }
  }
}

async function collectPoolSnapshots() {
  const cutoff = Date.now() - config.coingecko.active_pool_ttl_minutes * 60_000;
  for (const [chain, network] of [
    ['sol', 'solana'],
    ['bsc', 'bsc'],
  ]) {
    const rows = db
      .prepare(
        `
      SELECT p.chain, p.token_address, p.pool_address, p.pool_created_at
      FROM token_pools p
      WHERE p.chain=? AND p.last_seen_at>=?
      ORDER BY p.first_indexed_at DESC
      LIMIT ?
    `,
      )
      .all(chain, cutoff, config.coingecko.max_pools_per_chain);
    if (!rows.length) continue;
    const addresses = rows.map((item) => item.pool_address);
    const observedAt = Date.now();
    const { json } = await providerCall('coingecko', 'pools.multi.snapshot', chain, () =>
      cg(
        `/onchain/networks/${network}/pools/multi/${addresses.join(',')}?include=base_token,quote_token&include_volume_breakdown=true&include_composition=true`,
      ),
    );
    const poolMap = new Map(
      rows.map((item) => [
        chain === 'bsc' ? item.pool_address.toLowerCase() : item.pool_address,
        item,
      ]),
    );
    for (const item of json?.data || []) {
      const attributes = item.attributes || {};
      const address = attributes.address;
      const local = poolMap.get(chain === 'bsc' ? address?.toLowerCase() : address);
      if (!local) continue;
      const selected = {
        transactions: attributes.transactions,
        volume: attributes.volume_usd,
        net_buy: attributes.net_buy_volume_usd,
        price_change: attributes.price_change_percentage,
        reserve: attributes.reserve_in_usd,
      };
      insertSnapshot.run(
        observedAt,
        chain,
        local.token_address,
        address,
        local.pool_created_at,
        asText(attributes.reserve_in_usd),
        item.relationships?.base_token?.data?.id || null,
        item.relationships?.quote_token?.data?.id || null,
        JSON.stringify(attributes.transactions || null),
        JSON.stringify(attributes.volume_usd || null),
        JSON.stringify(attributes.net_buy_volume_usd || null),
        JSON.stringify(attributes.price_change_percentage || null),
        hash(selected),
      );
    }
  }
}

let remainingCredits = Infinity;
async function collectCredits() {
  const { json } = await providerCall('coingecko', 'key', null, () => cg('/key'));
  if (!json) return;
  const monthly = json.api_key_monthly_call_credit;
  const used = json.api_key_current_total_monthly_calls;
  remainingCredits = Number(monthly) - Number(used);
  insertCredit.run(
    Date.now(),
    json.plan || null,
    json.api_key_rate_limit_request_per_minute || null,
    monthly || null,
    used || null,
    remainingCredits,
  );
}

function wsOne(channel, code, chain, network, poolAddress, durationMs) {
  return new Promise((resolve) => {
    const identifier = JSON.stringify({ channel });
    const socket = new WebSocket(
      `wss://stream.coingecko.com/v1?x_cg_pro_api_key=${encodeURIComponent(cgKey)}`,
    );
    let messages = 0;
    let ack = false;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {}
      resolve({ messages, ack });
    };
    const timer = setTimeout(close, durationMs);
    socket.addEventListener('open', () =>
      socket.send(JSON.stringify({ command: 'subscribe', identifier })),
    );
    socket.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (data.type === 'confirm_subscription') {
        socket.send(
          JSON.stringify({
            command: 'message',
            identifier,
            data: JSON.stringify({
              'network_id:pool_addresses': [`${network}:${poolAddress}`],
              action: 'set_pools',
              ...(code === 'G3' ? { interval: '1m', token: 'base' } : {}),
            }),
          }),
        );
      } else if (data.code === 2000) {
        ack = true;
      } else if (data.c === code || data.ch === code) {
        messages += 1;
        insertWs.run(
          Date.now(),
          code,
          chain,
          poolAddress,
          data.t || null,
          data.tx || null,
          data.ty || null,
          asText(data.to),
          asText(data.toq),
          asText(data.vo),
          asText(data.pu),
          code === 'G3'
            ? JSON.stringify({
                interval: data.i,
                open: data.o,
                high: data.h,
                low: data.l,
                close: data.c,
                volume: data.v,
              })
            : null,
          hash(data),
        );
      }
    });
    socket.addEventListener('error', close);
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      close();
    });
  });
}

async function collectWebsocket() {
  const jobs = [];
  for (const [chain, network] of [
    ['sol', 'solana'],
    ['bsc', 'bsc'],
  ]) {
    const rows = db
      .prepare(
        `SELECT pool_address FROM token_pools WHERE chain=? ORDER BY first_indexed_at DESC LIMIT ?`,
      )
      .all(chain, config.websocket.pools_per_chain);
    for (const row of rows) {
      for (const code of config.websocket.channels) {
        const channel = code === 'G2' ? 'OnchainTrade' : 'OnchainOHLCV';
        jobs.push(
          providerCall('coingecko-ws', code, chain, () =>
            wsOne(
              channel,
              code,
              chain,
              network,
              row.pool_address,
              config.websocket.burst_seconds * 1000,
            ),
          ),
        );
      }
    }
  }
  await Promise.all(jobs);
}

const statusPath = path.join(storageDir, config.storage.status);
async function writeStatus(status) {
  const temp = `${statusPath}.tmp`;
  await writeFile(temp, `${JSON.stringify(status, null, 2)}\n`);
  await rename(temp, statusPath);
}

let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});

let tick = 0;
let lastError = null;
const processStartedAt = Date.now();
await collectCredits();
while (!stopping) {
  const tickStartedAt = Date.now();
  tick += 1;
  try {
    await collectDiscovery(tick);
    const creditSamplingAllowed =
      !config.coingecko.enforce_minimum_remaining_credits ||
      remainingCredits > config.coingecko.minimum_remaining_credits;
    if (creditSamplingAllowed) {
      if (tick % config.coingecko.index_check_every_ticks === 0) await collectIndexing();
      if (tick % config.coingecko.pool_snapshot_every_ticks === 0) await collectPoolSnapshots();
      if (tick % config.coingecko.usage_check_every_ticks === 0) await collectCredits();
      if (
        config.websocket.enabled &&
        (tick === 1 || tick % config.websocket.burst_every_ticks === 0)
      )
        await collectWebsocket();
    }
    lastError = null;
  } catch (error) {
    lastError = safeError(error.message, 1000);
  }
  const counts = Object.fromEntries(
    [
      ['candidate_observations', 'candidate_observations'],
      ['indexing_attempts', 'indexing_attempts'],
      ['token_pools', 'token_pools'],
      ['pool_snapshots', 'pool_snapshots'],
      ['websocket_events', 'websocket_events'],
      ['provider_calls', 'provider_calls'],
    ].map(([key, table]) => [
      key,
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]),
  );
  await writeStatus({
    state: stopping ? 'stopping' : 'running',
    pid: process.pid,
    process_started_at: new Date(processStartedAt).toISOString(),
    tick,
    started_tick_at: new Date(tickStartedAt).toISOString(),
    updated_at: new Date().toISOString(),
    tick_duration_ms: Date.now() - tickStartedAt,
    remaining_credits: remainingCredits,
    last_error: lastError,
    counts,
  });
  const waitMs = Math.max(1000, config.tick_seconds * 1000 - (Date.now() - tickStartedAt));
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

await writeStatus({
  state: 'stopped',
  pid: process.pid,
  process_started_at: new Date(processStartedAt).toISOString(),
  tick,
  updated_at: new Date().toISOString(),
  last_error: lastError,
});
db.close();
