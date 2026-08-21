#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const envText = process.env.COINGECKO_PRO_API_KEY
  ? ''
  : await readFile(new URL('../.env.preflight', import.meta.url), 'utf8');
const keyLine = envText.split(/\r?\n/u).find((line) => line.startsWith('COINGECKO_PRO_API_KEY='));
const apiKey =
  process.env.COINGECKO_PRO_API_KEY ??
  keyLine?.slice('COINGECKO_PRO_API_KEY='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!apiKey) throw new Error('缺少 COINGECKO_PRO_API_KEY');

function redactSecrets(value, secrets) {
  return secrets.reduce(
    (redacted, secret) => (secret ? redacted.replaceAll(secret, '[REDACTED]') : redacted),
    String(value),
  );
}

const baseUrl = 'https://pro-api.coingecko.com/api/v3';
const headers = { 'x-cg-pro-api-key': apiKey };
const calls = [];

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function request(name, path) {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(25_000),
    });
    const text = await response.text();
    const json = JSON.parse(text);
    const call = {
      name,
      ok: response.ok,
      status: response.status,
      latency_ms: Math.round(performance.now() - startedAt),
      count: Array.isArray(json?.data) ? json.data.length : null,
    };
    calls.push(call);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return json;
  } catch (error) {
    const existing = calls.findLast((item) => item.name === name);
    if (!existing) {
      calls.push({
        name,
        ok: false,
        status: null,
        latency_ms: Math.round(performance.now() - startedAt),
        error: redactSecrets(String(error), [apiKey]).slice(0, 300),
      });
    }
    throw error;
  }
}

async function gatherPools(network) {
  const addresses = [];
  for (let page = 1; page <= 4 && addresses.length < 50; page += 1) {
    const json = await request(
      `pools.list.${network}.${page}`,
      `/onchain/networks/${network}/pools?page=${page}`,
    );
    for (const item of json.data ?? []) {
      const address = item?.attributes?.address;
      if (typeof address === 'string' && !addresses.includes(address)) addresses.push(address);
    }
  }
  if (addresses.length < 50) throw new Error(`${network} 只收集到 ${addresses.length} 个池`);
  return addresses.slice(0, 50);
}

function multiPath(network, addresses) {
  return `/onchain/networks/${network}/pools/multi/${addresses.join(',')}?include=base_token,quote_token,dex,launchpad_details&include_volume_breakdown=true&include_composition=true`;
}

function inspectBatch(json, expectedCount) {
  const items = Array.isArray(json?.data) ? json.data : [];
  if (items.length !== expectedCount)
    throw new Error(`批量数量不符：expected=${expectedCount} actual=${items.length}`);

  const missingWindows = [];
  let launchpadAttributeCount = 0;
  let launchpadRelationshipCount = 0;
  for (const item of items) {
    const attributes = item?.attributes ?? {};
    for (const interval of ['m5', 'm15', 'm30']) {
      const window = attributes?.transactions?.[interval];
      if (!window || !['buys', 'sells', 'buyers', 'sellers'].every((key) => key in window)) {
        missingWindows.push(`${item.id}:${interval}`);
      }
    }
    if ('launchpad_details' in attributes) launchpadAttributeCount += 1;
    if ('launchpad_details' in (item?.relationships ?? {})) launchpadRelationshipCount += 1;
  }
  const includedTypes = [...new Set((json.included ?? []).map((item) => item?.type).filter(Boolean))];
  return {
    count: items.length,
    missing_window_count: missingWindows.length,
    all_have_volume_breakdown: items.every(
      (item) =>
        item?.attributes?.net_buy_volume_usd &&
        item?.attributes?.buy_volume_usd &&
        item?.attributes?.sell_volume_usd,
    ),
    all_have_composition: items.every(
      (item) =>
        'base_token_balance' in (item?.attributes ?? {}) &&
        'quote_token_balance' in (item?.attributes ?? {}),
    ),
    launchpad_attribute_count: launchpadAttributeCount,
    launchpad_relationship_count: launchpadRelationshipCount,
    included_types: includedTypes,
  };
}

function mutableSnapshot(json) {
  return (json.data ?? []).map((item) => ({
    id: item.id,
    transactions: item?.attributes?.transactions,
    volume_usd: item?.attributes?.volume_usd,
    reserve_in_usd: item?.attributes?.reserve_in_usd,
    base_token_balance: item?.attributes?.base_token_balance,
    quote_token_balance: item?.attributes?.quote_token_balance,
  }));
}

const before = await request('key.before', '/key');
const result = { tested_at: new Date().toISOString(), chains: {}, concurrency: {} };

for (const network of ['solana', 'bsc']) {
  const addresses = await gatherPools(network);
  const first = await request(`pools.multi.50.${network}.first`, multiPath(network, addresses));
  const firstInspection = inspectBatch(first, 50);

  const invalidAddress =
    network === 'solana'
      ? '11111111111111111111111111111111'
      : '0x0000000000000000000000000000000000000000';
  const mixed = await request(
    `pools.multi.mixed_unknown.${network}`,
    multiPath(network, [addresses[0], invalidAddress]),
  );

  await new Promise((resolve) => setTimeout(resolve, 11_000));
  const second = await request(`pools.multi.50.${network}.after_11s`, multiPath(network, addresses));
  const secondInspection = inspectBatch(second, 50);
  const firstMutable = mutableSnapshot(first);
  const secondMutable = mutableSnapshot(second);

  result.chains[network] = {
    batch_50: firstInspection,
    batch_50_after_11s: secondInspection,
    mixed_unknown: {
      requested: 2,
      returned: Array.isArray(mixed?.data) ? mixed.data.length : null,
      returned_known_pool: (mixed?.data ?? []).some(
        (item) => item?.attributes?.address?.toLowerCase() === addresses[0].toLowerCase(),
      ),
      returned_unknown_pool: (mixed?.data ?? []).some(
        (item) => item?.attributes?.address?.toLowerCase() === invalidAddress.toLowerCase(),
      ),
    },
    refresh_after_ms: 11_000,
    mutable_hash_before: hash(firstMutable),
    mutable_hash_after: hash(secondMutable),
    mutable_payload_changed: hash(firstMutable) !== hash(secondMutable),
  };

  const pairs = [addresses.slice(0, 25), addresses.slice(25, 50)];
  const pairStarted = performance.now();
  await Promise.all(
    pairs.map((batch, index) =>
      request(`pools.multi.concurrent2.${network}.${index + 1}`, multiPath(network, batch)),
    ),
  );
  result.concurrency[`${network}_2`] = {
    requests: 2,
    elapsed_ms: Math.round(performance.now() - pairStarted),
  };

  const quarters = [
    addresses.slice(0, 13),
    addresses.slice(13, 26),
    addresses.slice(26, 38),
    addresses.slice(38, 50),
  ];
  const quarterStarted = performance.now();
  await Promise.all(
    quarters.map((batch, index) =>
      request(`pools.multi.concurrent4.${network}.${index + 1}`, multiPath(network, batch)),
    ),
  );
  result.concurrency[`${network}_4`] = {
    requests: 4,
    elapsed_ms: Math.round(performance.now() - quarterStarted),
  };
}

const after = await request('key.after', '/key');
result.key = {
  plan: after.plan,
  rpm: after.api_key_rate_limit_request_per_minute,
  monthly_credit: after.api_key_monthly_call_credit,
  calls_before: before.api_key_current_total_monthly_calls,
  calls_after: after.api_key_current_total_monthly_calls,
  measured_credit_delta:
    after.api_key_current_total_monthly_calls - before.api_key_current_total_monthly_calls,
};
result.calls = calls;
result.summary = {
  total: calls.length,
  passed: calls.filter((item) => item.ok).length,
  failed: calls.filter((item) => !item.ok).length,
};

if (process.env.CONTRACT_STDOUT_ONLY !== '1') {
  await writeFile(
    new URL('../preflight-results/coingecko-level1-contract.json', import.meta.url),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}
console.log(JSON.stringify(result, null, 2));
if (result.summary.failed > 0) process.exitCode = 1;
