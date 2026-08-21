import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import { openDatabase, schemaVersion } from '../persistence/db.js';
import { buildHealthSnapshot, readDiskHealth } from '../runtime/health.js';
import path from 'node:path';

const loaded = await loadConfig();
const database = openDatabase(loaded.config.storage.database_path, {
  busyTimeoutMs: loaded.config.storage.busy_timeout_ms,
});
try {
  const runtimeRequired = process.env.RUNTIME_HEALTH_REQUIRED === '1';
  let runtimeHealthy = true;
  if (runtimeRequired) {
    try {
      const runtimePath = path.join(
        path.dirname(path.resolve(loaded.config.storage.database_path)),
        'runtime-health.json',
      );
      const runtime = JSON.parse(readFileSync(runtimePath, 'utf8')) as {
        status?: string;
        generatedAt?: number;
      };
      const maxAgeMs = loaded.config.chains.sol.discovery.poll_interval_seconds * 3 * 1000;
      const ageMs = Date.now() - (runtime.generatedAt ?? Number.NaN);
      runtimeHealthy =
        runtime.status === 'healthy' && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
    } catch {
      runtimeHealthy = false;
    }
  }
  const snapshot = buildHealthSnapshot({
    commit: loaded.gitCommit,
    configHash: loaded.configHash,
    schemaVersion: schemaVersion(database),
    clockOffsetMs: 0,
    components: {
      sqlite: 'ok',
      ...(runtimeRequired ? { runtime: runtimeHealthy ? 'ok' : 'failed' } : {}),
    },
    disk: readDiskHealth(
      path.dirname(path.resolve(loaded.config.storage.database_path)),
      loaded.config.storage.disk_high_water_percent,
    ),
    generatedAt: Date.now(),
  });
  console.log(JSON.stringify(snapshot));
  if (snapshot.status !== 'healthy') process.exitCode = 1;
} finally {
  database.close();
}
