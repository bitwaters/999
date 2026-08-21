import { loadConfig } from '../config/load.js';
import { openDatabase, schemaVersion } from '../persistence/db.js';
import { buildHealthSnapshot, readDiskHealth } from '../runtime/health.js';

const loaded = await loadConfig();
const database = openDatabase(loaded.config.storage.database_path, {
  busyTimeoutMs: loaded.config.storage.busy_timeout_ms,
});
try {
  const snapshot = buildHealthSnapshot({
    commit: loaded.gitCommit,
    configHash: loaded.configHash,
    schemaVersion: schemaVersion(database),
    clockOffsetMs: 0,
    components: { sqlite: 'ok' },
    disk: readDiskHealth('.', loaded.config.storage.disk_high_water_percent),
    generatedAt: Date.now(),
  });
  console.log(JSON.stringify(snapshot));
  if (snapshot.status !== 'healthy') process.exitCode = 1;
} finally {
  database.close();
}
