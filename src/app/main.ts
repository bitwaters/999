import { ensureConfigVersion } from '../persistence/config-versions.js';
import { openDatabase } from '../persistence/db.js';
import { requireSecretEnv, loadConfig } from '../config/load.js';
import { BotRuntime } from './runtime.js';

const loaded = await loadConfig();
requireSecretEnv(loaded.config);
const database = openDatabase(loaded.config.storage.database_path, {
  busyTimeoutMs: loaded.config.storage.busy_timeout_ms,
});
const configVersion = ensureConfigVersion(
  database,
  {
    config: loaded.config,
    configHash: loaded.configHash,
    gitCommit: loaded.gitCommit,
    normalizedYaml: loaded.normalizedYaml,
    createdAt: Date.now(),
  },
  {
    maxRows: loaded.config.runtime.sqlite.transaction_max_rows,
    maxMs: loaded.config.runtime.sqlite.transaction_max_ms,
  },
);
const runtime = new BotRuntime({
  loaded,
  database,
  configVersionId: configVersion.id,
});

const stop = async (signal: string) => {
  console.error(
    JSON.stringify({ level: 'info', event: 'shutdown_requested', signal, at: Date.now() }),
  );
  await runtime.stop();
  database.close();
};
runtime.start();
const signal = await new Promise<string>((resolve) => {
  process.once('SIGTERM', () => resolve('SIGTERM'));
  process.once('SIGINT', () => resolve('SIGINT'));
});
await stop(signal);
