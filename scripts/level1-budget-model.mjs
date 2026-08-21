#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';

const databasePath = process.env.BOT_DATABASE_PATH ?? 'data/bot.sqlite';
const configPath = process.env.BOT_CONFIG_PATH ?? 'config/bot.yaml';
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
const config = parseYaml(await readFile(configPath, 'utf8'));
const attentionConfig = config.strategies.emerging_breakout.attention;
const minBuyers = config.strategies.emerging_breakout.conviction.min_buyers;
const minReserve = Number(config.strategies.emerging_breakout.entry_quality.min_reserve_usd);
const minNetBuy = Number(config.strategies.emerging_breakout.conviction.min_net_buy_usd);

function decode(row) {
  const bytes = row.payload_encoding === 'gzip' ? gunzipSync(row.payload) : row.payload;
  return JSON.parse(bytes.toString('utf8'));
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalize(chain, value) {
  if (typeof value !== 'string' || !value || value.trim() !== value) return undefined;
  return chain === 'bsc' ? value.toLowerCase() : value;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function summary(values) {
  return {
    samples: values.length,
    p10: percentile(values, 0.1),
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
  };
}

function sourceFor(capability) {
  if (capability.endsWith('trending.1m')) return 'trending_1m';
  if (capability.endsWith('trending.5m')) return 'trending_5m';
  if (capability.endsWith('hot-searches.1m')) return 'hot_searches';
  return undefined;
}

function observationsFrom(row, payload) {
  const source = sourceFor(row.capability);
  if (!source) return [];
  const values =
    source === 'hot_searches'
      ? record(
          (Array.isArray(payload) ? payload : []).find(
            (item) => record(item).chain === row.chain,
          ),
        ).tokens
      : record(record(payload).data).rank;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value, index) => {
    const item = record(value);
    const tokenAddress = normalize(row.chain, item.address ?? item.token_address);
    if (!tokenAddress) return [];
    return [
      {
        chain: row.chain,
        tokenAddress,
        source,
        observedAt: row.observed_at,
        ...(source === 'hot_searches'
          ? {
              visitingCount:
                typeof item.visiting_count === 'number' &&
                Number.isSafeInteger(item.visiting_count)
                  ? item.visiting_count
                  : undefined,
            }
          : { rank: index + 1 }),
      },
    ];
  });
}

function everAttentionPass(observations) {
  const groups = new Map();
  for (const item of observations) {
    const group = groups.get(item.source) ?? [];
    group.push(item);
    groups.set(item.source, group);
  }
  for (const [source, group] of groups) {
    group.sort((left, right) => left.observedAt - right.observedAt);
    for (let index = 1; index < group.length; index += 1) {
      const before = group[index - 1];
      const after = group[index];
      if (
        source === 'hot_searches' &&
        before.visitingCount !== undefined &&
        after.visitingCount !== undefined &&
        after.visitingCount - before.visitingCount >= attentionConfig.min_hot_search_growth
      )
        return true;
      if (
        source !== 'hot_searches' &&
        before.rank !== undefined &&
        after.rank !== undefined &&
        after.rank <= attentionConfig.max_rank &&
        before.rank - after.rank >= attentionConfig.min_rank_improvement
      )
        return true;
    }
  }
  return false;
}

function batchItems(row) {
  const payload = decode(row);
  return (Array.isArray(payload.data) ? payload.data : []).flatMap((value) => {
    const item = record(value);
    const attributes = record(item.attributes);
    const address = normalize(row.chain, attributes.address ?? item.id);
    if (!address) return [];
    const transactions = record(attributes.transactions);
    const volumeWindows = record(attributes.volume_usd);
    const buyVolumeWindows = record(attributes.buy_volume_usd);
    const sellVolumeWindows = record(attributes.sell_volume_usd);
    const netBuyWindows = record(attributes.net_buy_volume_usd);
    const windowsComplete = ['m5', 'm15', 'm30'].every((key) => {
      const window = record(transactions[key]);
      return (
        ['buys', 'sells', 'buyers', 'sellers'].every(
          (field) =>
            typeof window[field] === 'number' &&
            Number.isSafeInteger(window[field]) &&
            window[field] >= 0,
        ) &&
        [volumeWindows[key], buyVolumeWindows[key], sellVolumeWindows[key], netBuyWindows[key]].every(
          (field) => Number.isFinite(Number(field)),
        )
      );
    });
    const reserve = Number(attributes.reserve_in_usd);
    const buyers = Number(record(transactions.m5).buyers);
    const volume = Number(record(attributes.volume_usd).m5);
    const netBuy = Number(record(attributes.net_buy_volume_usd).m5);
    const compositionComplete =
      Number.isFinite(Number(attributes.base_token_balance)) &&
      Number.isFinite(Number(attributes.quote_token_balance));
    const identityComplete =
      typeof attributes.address === 'string' &&
      record(record(item.relationships).base_token).data !== undefined &&
      record(record(item.relationships).quote_token).data !== undefined;
    const priceComplete =
      Number.isFinite(Number(attributes.base_token_price_usd)) ||
      Number.isFinite(Number(attributes.quote_token_price_usd));
    return [
      {
        key: `${row.chain}:${address}`,
        observedAt: row.observed_at,
        structuralComplete:
          identityComplete &&
          windowsComplete &&
          compositionComplete &&
          priceComplete &&
          Number.isFinite(reserve) &&
          reserve >= 0,
        buyers,
        reserve,
        volume,
        netBuy,
      },
    ];
  });
}

const candidates = database
  .prepare(
    `SELECT id, chain, token_address, cycle_started_at, last_seen_at, status, funnel_status,
            safety_status, pool_address
     FROM candidates ORDER BY chain, token_address, cycle_started_at`,
  )
  .all();
const cyclesByToken = new Map();
for (const candidate of candidates) {
  const key = `${candidate.chain}:${normalize(candidate.chain, candidate.token_address)}`;
  const group = cyclesByToken.get(key) ?? [];
  group.push({ ...candidate, observations: [] });
  cyclesByToken.set(key, group);
}

const marketEvents = database
  .prepare(
    `SELECT capability, chain, observed_at, payload_encoding, payload
     FROM provider_events
     WHERE provider = 'gmgn' AND capability LIKE 'market.%'
     ORDER BY observed_at`,
  )
  .all();
for (const row of marketEvents) {
  for (const observation of observationsFrom(row, decode(row))) {
    const cycles = cyclesByToken.get(`${observation.chain}:${observation.tokenAddress}`) ?? [];
    const cycle = cycles.find(
      (item) =>
        observation.observedAt >= item.cycle_started_at && observation.observedAt <= item.last_seen_at,
    );
    if (cycle) cycle.observations.push(observation);
  }
}

const poolTimeline = new Map();
const poolEvents = database
  .prepare(
    `SELECT chain, observed_at, payload_encoding, payload
     FROM provider_events
     WHERE provider = 'coingecko' AND capability = 'pools.multi.level1'
       AND json_extract(request_meta_json, '$.endpoint_name') = 'onchain.pools.multi'
     ORDER BY observed_at`,
  )
  .all();
for (const row of poolEvents) {
  for (const item of batchItems(row)) {
    const timeline = poolTimeline.get(item.key) ?? [];
    timeline.push(item);
    poolTimeline.set(item.key, timeline);
  }
}

function poolsInCycle(candidate) {
  if (!candidate.pool_address) return undefined;
  const endAt =
    candidate.last_seen_at + config.chains[candidate.chain].discovery.candidate_ttl_seconds * 1000;
  return (
    poolTimeline.get(`${candidate.chain}:${normalize(candidate.chain, candidate.pool_address)}`) ?? []
  ).filter(
    (snapshot) =>
      snapshot.observedAt >= candidate.cycle_started_at && snapshot.observedAt <= endAt,
  );
}

function recovery(items, field, threshold) {
  const initiallyBelow = items.filter(
    (item) => Number.isFinite(item.snapshots[0]?.[field]) && item.snapshots[0][field] < threshold,
  );
  const recovered = initiallyBelow.filter((item) =>
    item.snapshots.slice(1).some((snapshot) => snapshot[field] >= threshold),
  );
  return {
    initially_below: initiallyBelow.length,
    later_recovered: recovered.length,
    recovery_percent:
      initiallyBelow.length === 0
        ? null
        : Number(((recovered.length / initiallyBelow.length) * 100).toFixed(2)),
  };
}

const output = { generated_at: new Date().toISOString(), config: { minBuyers, minReserve, minNetBuy }, chains: {} };
for (const chain of ['sol', 'bsc']) {
  const chainCycles = [...cyclesByToken.values()]
    .flat()
    .filter((candidate) => candidate.chain === chain);
  const safetyPass = chainCycles.filter((candidate) => candidate.safety_status === 'pass');
  const resolved = safetyPass.filter((candidate) => candidate.pool_address);
  const withBatch = resolved.flatMap((candidate) => {
    const snapshots = poolsInCycle(candidate);
    return snapshots?.length ? [{ candidate, snapshots, snapshot: snapshots.at(-1) }] : [];
  });
  const structural = withBatch.filter((item) => item.snapshot.structuralComplete);
  const legacyArmed = resolved.filter(
    (candidate) =>
      candidate.status === 'armed' ||
      ['armed', 'confirmed-pending-anchor', 'delivered', 'completed'].includes(
        candidate.funnel_status,
      ),
  );
  const structuralCandidateIds = new Set(structural.map((item) => item.candidate.id));
  const legacyArmedPreserved = legacyArmed.filter((candidate) =>
    structuralCandidateIds.has(candidate.id),
  );
  const attention = structural.filter((item) => everAttentionPass(item.candidate.observations));
  const everArmed = structural.filter(
    (item) =>
      item.candidate.status === 'armed' ||
      ['armed', 'confirmed-pending-anchor', 'delivered', 'completed'].includes(
        item.candidate.funnel_status,
      ),
  );
  const dynamic = structural.map((item) => item.snapshot);
  const per100 = (count, denominator) =>
    denominator === 0 ? null : Number(((count / denominator) * 100).toFixed(2));
  output.chains[chain] = {
    candidate_cycles: chainCycles.length,
    safety_pass: safetyPass.length,
    safety_pass_with_pool: resolved.length,
    batch_snapshot_matched: withBatch.length,
    structural_complete: structural.length,
    attention_ever_pass: attention.length,
    ever_armed: everArmed.length,
    ab_retention: {
      legacy_ever_armed: legacyArmed.length,
      legacy_armed_preserved_by_structural: legacyArmedPreserved.length,
      unexplained_legacy_armed_loss: legacyArmed.length - legacyArmedPreserved.length,
    },
    dynamic_distributions: {
      buyers_m5: summary(dynamic.map((item) => item.buyers).filter(Number.isFinite)),
      reserve_usd: summary(dynamic.map((item) => item.reserve).filter(Number.isFinite)),
      volume_m5_usd: summary(dynamic.map((item) => item.volume).filter(Number.isFinite)),
      net_buy_m5_usd: summary(dynamic.map((item) => item.netBuy).filter(Number.isFinite)),
      below_buyers_now: dynamic.filter((item) => item.buyers < minBuyers).length,
      below_reserve_now: dynamic.filter((item) => item.reserve < minReserve).length,
      below_net_buy_now: dynamic.filter((item) => item.netBuy < minNetBuy).length,
      recovery: {
        buyers: recovery(structural, 'buyers', minBuyers),
        reserve: recovery(structural, 'reserve', minReserve),
        net_buy: recovery(structural, 'netBuy', minNetBuy),
      },
    },
    per_100_structural_candidates: {
      attention_finalist_upper_bound: per100(attention.length, structural.length),
      observed_ever_armed: per100(everArmed.length, structural.length),
      legacy_rest_calls: 102,
      adaptive_rest_calls_upper_bound:
        structural.length === 0
          ? null
          : Number((2 + (attention.length / structural.length) * 100).toFixed(2)),
      adaptive_rest_calls_observed:
        structural.length === 0
          ? null
          : Number((2 + (everArmed.length / structural.length) * 100).toFixed(2)),
      observed_rest_call_reduction_percent:
        structural.length === 0
          ? null
          : Number(
              (
                (1 - (2 + (everArmed.length / structural.length) * 100) / 102) *
                100
              ).toFixed(2),
            ),
    },
  };
}

console.log(JSON.stringify(output, null, 2));
