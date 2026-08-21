import type { BotConfig } from '../config/schema.js';
import { backupDatabase } from '../runtime/backup.js';
import {
  buildHealthSnapshot,
  conservativeDegradation,
  createStructuredLogger,
  readDiskHealth,
  type HealthSnapshot,
} from '../runtime/health.js';
import { EventLoopLagMonitor } from '../persistence/event-loop-lag.js';
import type { SqliteDatabase } from '../persistence/db.js';
import type { LoadedConfig } from '../config/load.js';
import type { ProviderProbe } from './provider-probe.js';
import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type RuntimeOptions = {
  loaded: LoadedConfig;
  database: SqliteDatabase;
  configVersionId: number;
  providerProbe: ProviderProbe;
  logger?: ReturnType<typeof createStructuredLogger>;
};

export class BotRuntime {
  private readonly config: BotConfig;
  private readonly logger: ReturnType<typeof createStructuredLogger>;
  private readonly lagMonitor: EventLoopLagMonitor;
  private readonly healthPath: string;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private backupTimer: NodeJS.Timeout | undefined;
  private backupInFlight: Promise<void> | undefined;
  private stopping = false;

  public constructor(private readonly options: RuntimeOptions) {
    this.config = options.loaded.config;
    this.logger = options.logger ?? createStructuredLogger();
    this.healthPath = path.join(
      path.dirname(path.resolve(this.config.storage.database_path)),
      'runtime-health.json',
    );
    this.lagMonitor = new EventLoopLagMonitor(
      this.config.runtime.event_loop_lag.sample_interval_ms,
      this.config.runtime.event_loop_lag.incomplete_threshold_ms,
    );
    this.options.providerProbe.onStatusChange(() => this.emitHeartbeat());
  }

  public start(): void {
    if (this.heartbeatTimer) return;
    this.lagMonitor.start();
    this.options.providerProbe.start();
    const heartbeatMs = this.config.chains.sol.discovery.poll_interval_seconds * 1000;
    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), heartbeatMs);
    this.backupTimer = setInterval(
      () => void this.runBackup(),
      this.config.storage.backup_interval_seconds * 1000,
    );
    this.emitHeartbeat();
    this.logger('info', 'runtime_started', {
      config_version_id: this.options.configVersionId,
      run_mode: this.config.global.run_mode,
      commit: this.options.loaded.gitCommit,
    });
  }

  public async stop(): Promise<void> {
    if (this.stopping) return this.backupInFlight;
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.backupTimer) clearInterval(this.backupTimer);
    this.heartbeatTimer = undefined;
    this.backupTimer = undefined;
    this.lagMonitor.stop();
    await this.options.providerProbe.stop();
    await this.backupInFlight;
    this.logger('info', 'runtime_stopped', { config_version_id: this.options.configVersionId });
  }

  public healthSnapshot(): HealthSnapshot {
    const lag = this.lagMonitor.snapshot();
    const providerStatus = this.options.providerProbe.status();
    const disk = readDiskHealth(
      path.dirname(path.resolve(this.config.storage.database_path)),
      this.config.storage.disk_high_water_percent,
    );
    return buildHealthSnapshot({
      commit: this.options.loaded.gitCommit,
      configHash: this.options.loaded.configHash,
      schemaVersion: Number(this.options.database.pragma('user_version', { simple: true })),
      clockOffsetMs: 0,
      components: {
        provider: providerStatus.provider,
        safety: providerStatus.safety,
        level1: providerStatus.level1,
        g2: providerStatus.g2,
        telegram: providerStatus.telegram,
        sqlite: 'ok',
        event_loop: lag.incomplete ? 'degraded' : 'ok',
      },
      disk,
      generatedAt: Date.now(),
    });
  }

  private emitHeartbeat(): void {
    try {
      const snapshot = this.healthSnapshot();
      const providerStatus = this.options.providerProbe.status();
      this.writeHealthSnapshot(snapshot);
      this.logger(snapshot.status === 'healthy' ? 'info' : 'warn', 'runtime_health', {
        status: snapshot.status,
        config_hash: snapshot.configHash,
        schema_version: snapshot.schemaVersion,
        components: snapshot.components,
        disk: snapshot.disk,
        degradation: conservativeDegradation(snapshot),
        provider_probe: providerStatus,
      });
    } catch (error) {
      this.logger('error', 'runtime_health_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private writeHealthSnapshot(snapshot: HealthSnapshot): void {
    const temporary = `${this.healthPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    renameSync(temporary, this.healthPath);
  }

  private async runBackup(): Promise<void> {
    if (this.stopping || this.backupInFlight) return;
    this.backupInFlight = backupDatabase({
      database: this.options.database,
      directory: this.config.storage.backup_directory,
      runId: `${Date.now()}`,
      retention: this.config.storage.backup_retention,
      pageBatch: this.config.replay.backup_page_batch,
    })
      .then((filename) => this.logger('info', 'runtime_backup_completed', { filename }))
      .catch((error: unknown) => {
        this.logger('error', 'runtime_backup_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.backupInFlight = undefined;
      });
    await this.backupInFlight;
  }
}
