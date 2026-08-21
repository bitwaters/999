#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const status = JSON.parse(await readFile(path.join(root, "sampling-data/status.json"), "utf8"));
const db = new DatabaseSync(path.join(root, "sampling-data/sampling.sqlite"), { readOnly: true });
const since = Math.max(Date.now() - 60 * 60 * 1000, Date.parse(status.process_started_at || 0));

const output = {
  status,
  current_run_up_to_one_hour: {
    provider_calls: db.prepare(`SELECT provider, COUNT(*) AS calls, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failures, ROUND(AVG(latency_ms)) AS avg_ms FROM provider_calls WHERE observed_at>=? GROUP BY provider`).all(since),
    candidates: db.prepare(`SELECT chain, COUNT(*) AS observations, COUNT(DISTINCT token_address) AS tokens FROM candidate_observations WHERE observed_at>=? GROUP BY chain`).all(since),
    indexing: db.prepare(`SELECT chain, COUNT(*) AS attempts, SUM(indexed) AS indexed_count FROM indexing_attempts WHERE attempted_at>=? GROUP BY chain`).all(since),
    snapshots: db.prepare(`SELECT chain, COUNT(*) AS snapshots FROM pool_snapshots WHERE observed_at>=? GROUP BY chain`).all(since),
    websocket: db.prepare(`SELECT channel, chain, COUNT(*) AS events FROM websocket_events WHERE observed_at>=? GROUP BY channel, chain`).all(since),
  },
};

console.log(JSON.stringify(output, null, 2));
db.close();
