import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotConfig } from '../config/schema.js';
import { insertProviderEvent } from '../persistence/provider-events.js';
import type { SqliteDatabase } from '../persistence/db.js';
import { boundedWrite, type WriteBudget } from '../persistence/write-budget.js';
import { requestJson, type HttpClientOptions } from '../providers/http.js';
import { gmgnTrendingRawSchema } from '../providers/raw-schemas.js';
import { gmgnHotSearchesRawSchema } from '../providers/raw-schemas.js';
import { CandidateCycleTracker, type DiscoveryObservation } from '../pipeline/candidate.js';
import { readDiskHealth } from '../runtime/health.js';

type ProbeState = 'ok' | 'failed' | 'unknown';
type ProbeLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

export type ProviderProbeStatus = {
  provider: ProbeState;
  telegram: ProbeState;
  lastProbeAt?: number;
  lastError?: string;
};

export type ProviderProbeOptions = {
  config: BotConfig;
  secrets: Record<string, string>;
  database: SqliteDatabase;
  writeBudget: WriteBudget;
  configVersionId: number;
  logger: ProbeLogger;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gmgnCli = path.join(root, 'node_modules', 'gmgn-cli', 'dist', 'index.js');

export class ProviderProbe {
  private gmgn: ProbeState = 'unknown';
  private coingecko: ProbeState = 'unknown';
  private telegram: ProbeState = 'unknown';
  private lastProbeAt: number | undefined;
  private lastError: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopping = false;
  private statusChangeListener: (() => void) | undefined;
  private readonly trackers: Record<'sol' | 'bsc', CandidateCycleTracker>;

  public constructor(private readonly options: ProviderProbeOptions) {
    this.trackers = {
      sol: new CandidateCycleTracker(options.config.chains.sol.discovery.candidate_ttl_seconds),
      bsc: new CandidateCycleTracker(options.config.chains.bsc.discovery.candidate_ttl_seconds),
    };
  }

  public start(): void {
    if (this.timer) return;
    const intervalMs =
      Math.min(
        this.options.config.chains.sol.discovery.poll_interval_seconds,
        this.options.config.chains.bsc.discovery.poll_interval_seconds,
      ) * 1000;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    void this.runOnce();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  public status(): ProviderProbeStatus {
    const providerStates = [this.gmgn, this.coingecko];
    return {
      provider: providerStates.every((state) => state === 'ok')
        ? 'ok'
        : providerStates.includes('failed')
          ? 'failed'
          : 'unknown',
      telegram: this.telegram,
      ...(this.lastProbeAt === undefined ? {} : { lastProbeAt: this.lastProbeAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  public onStatusChange(listener: () => void): void {
    this.statusChangeListener = listener;
  }

  private async runOnce(): Promise<void> {
    if (this.stopping || this.inFlight) return;
    this.inFlight = Promise.allSettled([
      this.probeGmgn(),
      this.probeCoinGecko(),
      this.probeTelegram(),
    ])
      .then((results) => {
        this.lastProbeAt = Date.now();
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => this.safeError(result.reason));
        this.lastError = failures[0];
        this.statusChangeListener?.();
        this.options.logger('info', 'provider_probe_status', {
          status: this.status(),
          failure_count: failures.length,
        });
        if (failures.length > 0)
          this.options.logger('warn', 'provider_probe_failed', { errors: failures });
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    await this.inFlight;
  }

  private async probeGmgn(): Promise<void> {
    const key = this.options.secrets[this.options.config.providers.gmgn.api_key_env];
    if (!key) throw new Error('GMGN secret is not configured');
    try {
      const disk = readDiskHealth(
        path.dirname(path.resolve(this.options.config.storage.database_path)),
        this.options.config.storage.disk_high_water_percent,
      );
      if (disk.highWater) throw new Error('disk:high_water');
      for (const chain of ['sol', 'bsc'] as const) {
        const intervals = this.options.config.chains[chain].discovery.trending_intervals;
        for (const interval of intervals) {
          const observedAt = Date.now();
          const raw = await runGmgn(
            [
              'market',
              'trending',
              '--chain',
              chain,
              '--interval',
              interval,
              '--limit',
              String(this.options.config.chains[chain].discovery.max_candidates),
            ],
            key,
            this.options.config.providers.gmgn.request_timeout_ms,
          );
          const parsed = gmgnTrendingRawSchema.parse(JSON.parse(raw));
          this.recordGmgnEvent(raw, `market.trending.${interval}`, chain, observedAt);
          this.ingestTrending(chain, interval, parsed.data.rank, observedAt);
          await delay(this.options.config.providers.gmgn.rate_limit.minimum_interval_ms);
        }

        const observedAt = Date.now();
        const raw = await runGmgn(
          [
            'market',
            'hot-searches',
            '--chain',
            chain,
            '--interval',
            this.options.config.chains[chain].discovery.hot_search_interval,
            '--limit',
            String(this.options.config.chains[chain].discovery.max_candidates),
          ],
          key,
          this.options.config.providers.gmgn.request_timeout_ms,
        );
        const parsed = gmgnHotSearchesRawSchema.parse(JSON.parse(raw));
        this.recordGmgnEvent(raw, 'market.hot-searches.1m', chain, observedAt);
        const group = parsed.find((item) => item.chain === chain);
        this.ingestHotSearches(chain, group?.tokens ?? [], observedAt);
        this.closeExpired(chain, observedAt);
        if (chain === 'sol')
          await delay(this.options.config.providers.gmgn.rate_limit.minimum_interval_ms);
      }
      this.gmgn = 'ok';
    } catch (error) {
      this.gmgn = 'failed';
      throw error;
    }
  }

  private recordGmgnEvent(
    raw: string,
    capability: string,
    chain: 'sol' | 'bsc',
    observedAt: number,
  ): void {
    insertProviderEvent(
      this.options.database,
      {
        provider: 'gmgn',
        capability,
        chain,
        observedAt,
        schemaVersion: 'gmgn.market.v1',
        payload: raw,
        requestMeta: {
          endpoint_name: capability,
          method: 'cli',
          response_bytes: Buffer.byteLength(raw),
        },
      },
      this.options.writeBudget,
    );
  }

  private ingestTrending(
    chain: 'sol' | 'bsc',
    interval: '1m' | '5m',
    tokens: Record<string, unknown>[],
    observedAt: number,
  ): void {
    tokens.forEach((token, index) => {
      this.ingestCandidate({
        chain,
        tokenAddress: String(token.address ?? token.token_address ?? ''),
        source: interval === '1m' ? 'trending_1m' : 'trending_5m',
        observedAt,
        rank: index + 1,
      });
    });
  }

  private ingestHotSearches(
    chain: 'sol' | 'bsc',
    tokens: Record<string, unknown>[],
    observedAt: number,
  ): void {
    tokens.forEach((token) => {
      const visitingCount = readSafeInteger(token.visiting_count);
      this.ingestCandidate({
        chain,
        tokenAddress: String(token.address ?? token.token_address ?? ''),
        source: 'hot_searches',
        observedAt,
        ...(visitingCount === undefined ? {} : { visitingCount }),
      });
    });
  }

  private ingestCandidate(observation: DiscoveryObservation): void {
    if (!observation.tokenAddress) return;
    try {
      const result = this.trackers[observation.chain].ingest(observation);
      const cycle = result.cycle;
      const existing = this.options.database
        .prepare(
          'SELECT id FROM candidates WHERE chain = ? AND token_address = ? AND cycle_started_at = ?',
        )
        .pluck()
        .get(cycle.chain, cycle.tokenAddress, cycle.cycleStartedAt);
      boundedWrite(this.options.database, this.options.writeBudget, (context) => {
        if (existing === undefined) {
          const info = this.options.database
            .prepare(
              `INSERT INTO candidates
               (chain, token_address, cycle_started_at, first_seen_at, last_seen_at, status,
                safety_status, funnel_status, config_version_id, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
            )
            .run(
              cycle.chain,
              cycle.tokenAddress,
              cycle.cycleStartedAt,
              cycle.firstSeenAt,
              cycle.lastSeenAt,
              cycle.status,
              'discovery',
              this.options.configVersionId,
              Date.now(),
            );
          context.addRows(info.changes);
        } else {
          const info = this.options.database
            .prepare(
              'UPDATE candidates SET last_seen_at = ?, status = ?, updated_at = ? WHERE id = ?',
            )
            .run(cycle.lastSeenAt, cycle.status, Date.now(), existing);
          context.addRows(info.changes);
        }
      });
      if (result.closedCycle) this.closeCandidate(result.closedCycle);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid')) {
        this.options.logger('warn', 'candidate_ingest_skipped', {
          chain: observation.chain,
          reason: this.safeError(error),
        });
        return;
      }
      throw error;
    }
  }

  private closeExpired(chain: 'sol' | 'bsc', now: number): void {
    for (const cycle of this.trackers[chain].closeExpired(now)) this.closeCandidate(cycle);
  }

  private closeCandidate(cycle: {
    chain: 'sol' | 'bsc';
    tokenAddress: string;
    cycleStartedAt: number;
  }): void {
    boundedWrite(this.options.database, this.options.writeBudget, (context) => {
      const info = this.options.database
        .prepare(
          `UPDATE candidates SET status = 'expired', close_reason = 'discovery_ttl', updated_at = ?
           WHERE chain = ? AND token_address = ? AND cycle_started_at = ?`,
        )
        .run(Date.now(), cycle.chain, cycle.tokenAddress, cycle.cycleStartedAt);
      context.addRows(info.changes);
    });
  }

  private async probeCoinGecko(): Promise<void> {
    const key = this.options.secrets[this.options.config.providers.coingecko.api_key_env];
    if (!key) throw new Error('CoinGecko secret is not configured');
    const options = httpOptions(this.options.config, 'coingecko', 'key');
    try {
      const result = await requestJson<Record<string, unknown>>(
        `${this.options.config.providers.coingecko.rest_base_url}/key`,
        { headers: { 'x-cg-pro-api-key': key } },
        options,
      );
      const observedAt = Date.now();
      const payload = JSON.stringify(result.data);
      insertProviderEvent(
        this.options.database,
        {
          provider: 'coingecko',
          capability: 'key',
          observedAt,
          schemaVersion: 'coingecko.key.v1',
          payload,
          requestMeta: {
            endpoint_name: 'key',
            method: 'GET',
            status: result.diagnostic.status,
            response_bytes: Buffer.byteLength(payload),
          },
        },
        this.options.writeBudget,
      );
      this.coingecko = 'ok';
    } catch (error) {
      this.coingecko = 'failed';
      throw error;
    }
  }

  private async probeTelegram(): Promise<void> {
    const token = this.options.secrets[this.options.config.providers.telegram.bot_token_env];
    if (!token) throw new Error('Telegram secret is not configured');
    try {
      await requestJson<Record<string, unknown>>(
        `https://api.telegram.org/bot${token}/getMe`,
        {},
        httpOptions(this.options.config, 'telegram', 'getMe'),
      );
      this.telegram = 'ok';
    } catch (error) {
      this.telegram = 'failed';
      throw error;
    }
  }

  private safeError(error: unknown): string {
    const values = Object.values(this.options.secrets);
    const details =
      error && typeof error === 'object' && 'diagnostic' in error
        ? JSON.stringify((error as { diagnostic: unknown }).diagnostic)
        : '';
    return redact(
      `${error instanceof Error ? error.message : String(error)}${details ? ` ${details}` : ''}`,
      values,
    ).slice(0, 500);
  }
}

function httpOptions(
  config: BotConfig,
  provider: 'coingecko' | 'telegram',
  capability: string,
): HttpClientOptions {
  const source = config.providers[provider];
  return {
    provider,
    capability,
    timeoutMs: source.request_timeout_ms,
    maxResponseBytes: source.max_response_bytes,
    maxDecompressedBytes: source.max_decompressed_bytes,
    maxAttempts: 1,
    baseDelayMs: 1,
    maxDelayMs: 1,
  };
}

function runGmgn(args: string[], apiKey: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gmgnCli, ...args, '--raw'], {
      cwd: root,
      env: { ...process.env, GMGN_API_KEY: apiKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `gmgn-cli exit ${code}`));
      else resolve(stdout.trim());
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (text, secret) =>
        text.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]'),
      value,
    );
}

function readSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
