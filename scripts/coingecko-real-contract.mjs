#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";

const resultDir = new URL("../preflight-results/", import.meta.url);
const envText = await readFile(new URL("../.env.preflight", import.meta.url), "utf8");
const keyLine = envText.split(/\r?\n/u).find((line) => line.startsWith("COINGECKO_PRO_API_KEY="));
const apiKey = keyLine?.slice("COINGECKO_PRO_API_KEY=".length).trim().replace(/^(['"])(.*)\1$/u, "$2") || "";
if (!apiKey) throw new Error("缺少 COINGECKO_PRO_API_KEY");

const proBase = "https://pro-api.coingecko.com/api/v3";
const headers = { "x-cg-pro-api-key": apiKey };
const results = [];

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function shape(value, depth = 0) {
  if (depth > 3) return valueType(value);
  if (Array.isArray(value)) return { type: "array", length: value.length, item: value.length ? shape(value[0], depth + 1) : null };
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, depth + 1)]));
  }
  return valueType(value);
}

async function request(name, url, options = {}) {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: AbortSignal.timeout(25_000),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status} 非 JSON`); }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
    const result = {
      name,
      ok: true,
      latency_ms: Math.round(performance.now() - startedAt),
      count: Array.isArray(json?.data) ? json.data.length : null,
      shape: shape(json),
    };
    results.push(result);
    console.log(`PASS ${name} (${result.latency_ms}ms${result.count === null ? "" : `, count=${result.count}`})`);
    return json;
  } catch (error) {
    const result = { name, ok: false, latency_ms: Math.round(performance.now() - startedAt), error: String(error.message).replaceAll(apiKey, "[REDACTED]").slice(0, 500) };
    results.push(result);
    console.log(`FAIL ${name} — ${result.error}`);
    return null;
  }
}

async function gatherPools(network) {
  const pools = [];
  for (let page = 1; page <= 6 && pools.length < 100; page += 1) {
    const json = await request(`pools.list.${network}.page${page}`, `${proBase}/onchain/networks/${network}/pools?page=${page}`);
    if (!json) continue;
    for (const item of json.data || []) {
      const address = item?.attributes?.address;
      if (address && !pools.some((pool) => pool.address === address)) {
        pools.push({
          address,
          base: item?.relationships?.base_token?.data?.id?.replace(`${network}_`, ""),
          quote: item?.relationships?.quote_token?.data?.id?.replace(`${network}_`, ""),
        });
      }
    }
  }
  return pools.slice(0, 100);
}

function assertPoolWindows(json, expectedCount) {
  if ((json?.data?.length || 0) !== expectedCount) throw new Error(`期望 ${expectedCount} 池，实际 ${json?.data?.length || 0}`);
  for (const item of json.data) {
    for (const interval of ["m5", "m15", "m30"]) {
      const window = item?.attributes?.transactions?.[interval];
      if (!window || !["buys", "sells", "buyers", "sellers"].every((key) => key in window)) {
        throw new Error(`${item.id} 缺少 ${interval} 交易字段`);
      }
    }
    if (!item?.attributes?.net_buy_volume_usd) throw new Error(`${item.id} 缺少 net_buy_volume_usd`);
    if (!("base_token_balance" in item.attributes) || !("quote_token_balance" in item.attributes)) {
      throw new Error(`${item.id} 缺少 composition`);
    }
  }
}

function websocketTest(name, channel, code, network, address, extra = {}) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let ack = false;
    let settled = false;
    const identifier = JSON.stringify({ channel });
    const socket = new WebSocket(`wss://stream.coingecko.com/v1?x_cg_pro_api_key=${encodeURIComponent(apiKey)}`);
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      const result = {
        name,
        ok,
        latency_ms: Math.round(performance.now() - startedAt),
        ack,
        ...(ok ? { payload_shape: shape(detail) } : { error: String(detail).replaceAll(apiKey, "[REDACTED]").slice(0, 500) }),
      };
      results.push(result);
      console.log(`${ok ? "PASS" : "FAIL"} ${name} (${result.latency_ms}ms, ack=${ack})${ok ? "" : ` — ${result.error}`}`);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false, "20 秒内未收到数据"), 20_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ command: "subscribe", identifier }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.type === "confirm_subscription") {
          socket.send(JSON.stringify({
            command: "message",
            identifier,
            data: JSON.stringify({ "network_id:pool_addresses": [`${network}:${address}`], action: "set_pools", ...extra }),
          }));
          return;
        }
        if (data.code === 2000) {
          ack = true;
          return;
        }
        if (data.c === code || data.ch === code) finish(true, data);
      } catch (error) {
        finish(false, `消息解析失败：${error.message}`);
      }
    });
    socket.addEventListener("error", () => finish(false, "WebSocket error"));
    socket.addEventListener("close", () => {
      if (!settled) finish(false, "WebSocket 提前关闭");
    });
  });
}

const before = await request("key.before", `${proBase}/key`);
const networkPools = {};

for (const network of ["solana", "bsc"]) {
  const pools = await gatherPools(network);
  networkPools[network] = pools;
  if (pools.length < 50) throw new Error(`${network} 只收集到 ${pools.length} 个池，无法验证 50 池上限`);

  const poolAddresses = pools.slice(0, 50).map((pool) => pool.address);
  const poolJson = await request(
    `pools.multi.50.${network}`,
    `${proBase}/onchain/networks/${network}/pools/multi/${poolAddresses.join(",")}?include=base_token,quote_token,dex&include_volume_breakdown=true&include_composition=true`,
  );
  try {
    assertPoolWindows(poolJson, 50);
    console.log(`ASSERT pools.multi.50.${network} 字段与数量通过`);
  } catch (error) {
    results.push({ name: `pools.multi.50.${network}.assert`, ok: false, error: error.message });
    console.log(`FAIL pools.multi.50.${network}.assert — ${error.message}`);
  }

  const tokens = [...new Set(pools.flatMap((pool) => [pool.base, pool.quote]).filter(Boolean))].slice(0, 50);
  if (tokens.length === 50) {
    await request(
      `tokens.multi.50.${network}`,
      `${proBase}/onchain/networks/${network}/tokens/multi/${tokens.join(",")}?include=top_pools&include_composition=true`,
    );
  } else {
    results.push({ name: `tokens.multi.50.${network}`, ok: false, error: `仅收集到 ${tokens.length} 个 token` });
    console.log(`FAIL tokens.multi.50.${network} — 仅收集到 ${tokens.length} 个 token`);
  }

  const pool = pools[0];
  await request(`pool.single.${network}`, `${proBase}/onchain/networks/${network}/pools/${pool.address}?include=base_token,quote_token,dex&include_volume_breakdown=true&include_composition=true`);
  await request(`pool.info.${network}`, `${proBase}/onchain/networks/${network}/pools/${pool.address}/info`);
  if (pool.base) await request(`token.info.${network}`, `${proBase}/onchain/networks/${network}/tokens/${pool.base}/info`);
  await request(`trades.pool.${network}`, `${proBase}/onchain/networks/${network}/pools/${pool.address}/trades`);
  await request(`ohlcv.second30.base.${network}`, `${proBase}/onchain/networks/${network}/pools/${pool.address}/ohlcv/second?aggregate=30&limit=20&currency=usd&token=base`);
  await request(`ohlcv.second30.quote.${network}`, `${proBase}/onchain/networks/${network}/pools/${pool.address}/ohlcv/second?aggregate=30&limit=20&currency=usd&token=quote`);
  await request(`ohlcv.minute1.empty.${network}`, `${proBase}/onchain/networks/${network}/pools/${pool.address}/ohlcv/minute?aggregate=1&limit=20&currency=usd&token=base&include_empty_intervals=true`);
}

await Promise.all(Object.entries(networkPools).flatMap(([network, pools]) => [
  websocketTest(`ws.G2.${network}`, "OnchainTrade", "G2", network, pools[0].address),
  websocketTest(`ws.G3.${network}`, "OnchainOHLCV", "G3", network, pools[0].address, { interval: "1m", token: "base" }),
]));

const after = await request("key.after", `${proBase}/key`);
const beforeCalls = before?.api_key_current_total_monthly_calls;
const afterCalls = after?.api_key_current_total_monthly_calls;
const creditDelta = Number.isFinite(beforeCalls) && Number.isFinite(afterCalls) ? afterCalls - beforeCalls : null;

await mkdir(resultDir, { recursive: true });
await writeFile(new URL("coingecko-contract.json", resultDir), `${JSON.stringify({
  tested_at: new Date().toISOString(),
  plan: before ? {
    name: before.plan,
    rpm: before.api_key_rate_limit_request_per_minute,
    monthly_credit: before.api_key_monthly_call_credit,
  } : null,
  measured_rest_credit_delta: creditDelta,
  websocket_note: "WebSocket messages are billed separately; /key counters may not update immediately.",
  summary: {
    total: results.length,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
  },
  results,
}, null, 2)}\n`);

console.log(`DONE total=${results.length} passed=${results.filter((item) => item.ok).length} failed=${results.filter((item) => !item.ok).length} rest_credit_delta=${creditDelta}`);
