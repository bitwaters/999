#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const ENV_FILE = new URL("../.env.preflight", import.meta.url);

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`无效配置行：${rawLine}`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} 退出码 ${code}`));
    });
  });
}

async function getJson(url, headers = {}) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  const body = await response.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`${url} 返回非 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const message = json?.error || json?.description || JSON.stringify(json);
    throw new Error(`${url} HTTP ${response.status}: ${message}`);
  }
  return { json, elapsedMs };
}

function pass(name, detail = "") {
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name, reason) {
  console.log(`SKIP  ${name} — ${reason}`);
}

function fail(name, error) {
  console.error(`FAIL  ${name} — ${error.message}`);
}

async function checkGmgn(apiKey) {
  if (!apiKey) {
    skip("GMGN", "请先填写 GMGN_API_KEY");
    return;
  }

  for (const chain of ["sol", "bsc"]) {
    for (const interval of ["1m", "5m"]) {
      try {
        const raw = await run("npx", ["--yes", "gmgn-cli", "market", "trending", "--chain", chain, "--interval", interval, "--limit", "3", "--raw"], { GMGN_API_KEY: apiKey });
        const json = JSON.parse(raw);
        const rows = json?.data?.rank;
        if (!Array.isArray(rows) || rows.length === 0) throw new Error("Trending 无数据");
        const required = chain === "sol"
          ? ["renounced_mint", "renounced_freeze_account"]
          : ["is_honeypot", "is_renounced", "is_open_source", "buy_tax", "sell_tax"];
        const missing = required.filter((key) => !(key in rows[0]));
        if (missing.length) throw new Error(`缺少链安全字段：${missing.join(", ")}`);
        pass(`GMGN Trending ${chain} ${interval}`, `${rows.length} 条；链安全字段存在`);
      } catch (error) {
        fail(`GMGN Trending ${chain} ${interval}`, error);
      }
    }
  }

  try {
    const raw = await run("npx", ["--yes", "gmgn-cli", "market", "hot-searches", "--chain", "sol", "bsc", "--interval", "1m", "--limit", "3", "--raw"], { GMGN_API_KEY: apiKey });
    const json = JSON.parse(raw);
    if (!Array.isArray(json) || json.length !== 2) throw new Error("未返回 SOL、BSC 两组结果");
    pass("GMGN Hot Searches 1m", "SOL、BSC 均返回");
  } catch (error) {
    fail("GMGN Hot Searches 1m", error);
  }
}

async function checkCoinGecko(apiKey) {
  if (!apiKey) {
    skip("CoinGecko Pro", "请先填写 COINGECKO_PRO_API_KEY");
    return;
  }
  const headers = { "x-cg-pro-api-key": apiKey };
  try {
    const { json, elapsedMs } = await getJson("https://pro-api.coingecko.com/api/v3/key", headers);
    pass("CoinGecko /key", `${json.plan}; key RPM=${json.api_key_rate_limit_request_per_minute}; key monthly=${json.api_key_monthly_call_credit}; ${elapsedMs}ms`);
  } catch (error) {
    fail("CoinGecko /key", error);
    return;
  }

  const samples = [
    ["solana", "So11111111111111111111111111111111111111112"],
    ["bsc", "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"],
  ];
  for (const [network, address] of samples) {
    try {
      const url = `https://pro-api.coingecko.com/api/v3/onchain/networks/${network}/tokens/multi/${address}?include=top_pools&include_composition=true`;
      const { json, elapsedMs } = await getJson(url, headers);
      const pool = json?.included?.find((item) => item.type === "pool");
      const tx = pool?.attributes?.transactions;
      for (const window of ["m5", "m15", "m30"]) {
        if (!tx?.[window] || !("buyers" in tx[window]) || !("sellers" in tx[window])) {
          throw new Error(`缺少 ${window} buys/sells/buyers/sellers`);
        }
      }
      pass(`CoinGecko ${network} 批量池字段`, `m5/m15/m30 完整；${elapsedMs}ms`);
    } catch (error) {
      fail(`CoinGecko ${network} 批量池字段`, error);
    }
  }
}

async function checkTelegram(token, values) {
  if (!token) {
    skip("Telegram", "请先填写 TELEGRAM_BOT_TOKEN");
    return;
  }
  const base = `https://api.telegram.org/bot${token}`;
  try {
    const { json, elapsedMs } = await getJson(`${base}/getMe`);
    pass("Telegram getMe", `@${json.result.username}; ${elapsedMs}ms`);
  } catch (error) {
    fail("Telegram getMe", error);
    return;
  }

  for (const key of ["TELEGRAM_ADMIN_CHAT_ID", "TELEGRAM_CHANNEL_CHAT_ID", "TELEGRAM_GROUP_CHAT_ID"]) {
    const chatId = values[key];
    if (!chatId) {
      skip(`Telegram ${key}`, "未填写");
      continue;
    }
    try {
      const { json } = await getJson(`${base}/getChat?chat_id=${encodeURIComponent(chatId)}`);
      pass(`Telegram ${key}`, `${json.result.type}: ${json.result.title || json.result.username || json.result.id}`);
    } catch (error) {
      fail(`Telegram ${key}`, error);
    }
  }
}

let values;
try {
  values = parseEnv(await readFile(ENV_FILE, "utf8"));
} catch (error) {
  console.error(`无法读取 .env.preflight：${error.message}`);
  process.exitCode = 1;
  throw error;
}

console.log("供应商开发前预检（不会输出 Token，也不会发送 Telegram 消息）");
await checkGmgn(values.GMGN_API_KEY);
await checkCoinGecko(values.COINGECKO_PRO_API_KEY);
await checkTelegram(values.TELEGRAM_BOT_TOKEN, values);
