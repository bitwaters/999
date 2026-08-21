import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal } from 'decimal.js';
import type { BotConfig } from '../config/schema.js';
import { insertProviderEvent } from '../persistence/provider-events.js';
import type { SqliteDatabase } from '../persistence/db.js';
import { boundedWrite, type WriteBudget } from '../persistence/write-budget.js';
import { requestJson, type HttpClientOptions } from '../providers/http.js';
import { gmgnTrendingRawSchema } from '../providers/raw-schemas.js';
import {
  gmgnHotSearchesRawSchema,
  coingeckoPoolBatchRawSchema,
  coingeckoTradesRawSchema,
  coingeckoG2RawSchema,
  coingeckoOhlcv30sRawSchema,
} from '../providers/raw-schemas.js';
import { CandidateCycleTracker, type DiscoveryObservation } from '../pipeline/candidate.js';
import { readDiskHealth } from '../runtime/health.js';
import { evaluateBscSafety, evaluateSolSafety, type SafetyResult } from '../domain/safety.js';
import { parsePool, selectPrimaryPool, type CanonicalPool } from '../market-data/pools.js';
import { assertAnalystEndpoint } from '../providers/http.js';
import {
  latestTradeAt,
  level1RawForPool,
  parseCoinGeckoOhlcv30s,
  poolRawForAddress,
  poolRawsForToken,
  toCandle,
} from '../providers/coingecko-adapter.js';
import { isLevel1Fresh, parseLevel1Snapshot, type Level1Snapshot } from '../market-data/level1.js';
import { CoinGeckoG2Client } from '../providers/coingecko-g2.js';
import { evaluateAttention, evaluateDispatchGuard, type SignalSnapshot } from '../pipeline/ace.js';
import { createLiveSignal } from './live-signal.js';
import {
  evaluateExecution,
  evaluateHorizon,
  insertOutcome,
  selectEntry,
  type Candle,
} from '../outcomes/evaluation.js';
import {
  aggregateG2Window,
  G2IngestQueue,
  TradeDeduper,
  hashG2Message,
  normalizeG2Item,
  type NormalizedTrade,
  type RawG2Item,
} from '../market-data/g2.js';
import type { OutboxRow } from '../delivery/outbox.js';

type ProbeState = 'ok' | 'failed' | 'unknown';
type ProbeLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

type PendingG2 = {
  raw: RawG2Item;
  observedAt: number;
  providerEventId: number;
};

export type ProviderProbeStatus = {
  provider: ProbeState;
  safety: ProbeState;
  level1: ProbeState;
  g2: ProbeState;
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
  private safety: ProbeState = 'unknown';
  private level1: ProbeState = 'unknown';
  private readonly level1Snapshots = new Map<string, Level1Snapshot>();
  private readonly previousLevel1Snapshots = new Map<string, Level1Snapshot>();
  private readonly level1Pools = new Map<string, CanonicalPool>();
  private readonly g2Queue: G2IngestQueue<PendingG2>;
  private readonly g2Deduper = new TradeDeduper();
  private g2Client: CoinGeckoG2Client | undefined;
  private g2DrainScheduled = false;
  private g2DrainInFlight: Promise<void> | undefined;
  private g2QueueIncomplete = false;
  private readonly signalCheckTimers = new Map<string, NodeJS.Timeout>();
  private readonly outcomePollAt = new Map<string, number>();
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
    this.g2Queue = new G2IngestQueue(
      options.config.runtime.g2_queue.capacity,
      options.config.runtime.g2_queue.high_watermark,
      options.config.runtime.g2_queue.hard_limit,
      {
        onHighWatermark: () => {
          this.options.logger('warn', 'g2_queue_high_watermark', {
            size: this.g2Queue.size(),
          });
        },
        onHardLimit: () => {
          this.g2QueueIncomplete = true;
          this.options.logger('error', 'g2_queue_hard_limit', {
            size: this.g2Queue.size(),
          });
        },
      },
    );
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
    for (const timer of this.signalCheckTimers.values()) clearTimeout(timer);
    this.signalCheckTimers.clear();
    this.outcomePollAt.clear();
    await this.inFlight;
    await this.g2DrainInFlight;
    await this.g2Client?.stop();
  }

  public status(): ProviderProbeStatus {
    const providerStates = [this.gmgn, this.coingecko];
    return {
      provider: providerStates.every((state) => state === 'ok')
        ? 'ok'
        : providerStates.includes('failed')
          ? 'failed'
          : 'unknown',
      safety: this.safety,
      level1: this.level1,
      g2: this.g2QueueIncomplete ? 'failed' : (this.g2Client?.status() ?? 'unknown'),
      telegram: this.telegram,
      ...(this.lastProbeAt === undefined ? {} : { lastProbeAt: this.lastProbeAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  public dispatchGuardForOutbox(
    row: OutboxRow,
    now: number,
  ):
    | { status: 'send' }
    | { status: 'defer'; reason: string; dueAt?: number }
    | { status: 'cancel'; reason: string } {
    if (row.messageType !== 'ENTRY_SIGNAL' || row.signalId === undefined) return { status: 'send' };
    const record = this.options.database
      .prepare(
        `SELECT signals.snapshot_json, candidates.chain, candidates.token_address, candidates.pool_address,
                candidates.safety_json
         FROM signals JOIN candidates ON candidates.id = signals.candidate_id
         WHERE signals.id = ?`,
      )
      .get(row.signalId) as
      | {
          snapshot_json: string;
          chain: 'sol' | 'bsc';
          token_address: string;
          pool_address: string | null;
          safety_json: string | null;
        }
      | undefined;
    if (!record?.pool_address || !record.safety_json)
      return { status: 'defer', reason: 'dispatch:missing_signal_evidence' };
    const signal = parseSignalSnapshot(record.snapshot_json);
    const safety = parseSafety(record.safety_json);
    const pool = this.level1Pools.get(
      `${record.chain}:${record.pool_address}:${record.token_address}`,
    );
    const level1 = pool ? this.level1Snapshots.get(pool.identityKey) : undefined;
    if (!signal || !safety || !pool || !level1)
      return { status: 'defer', reason: 'dispatch:runtime_evidence_unavailable' };
    const windowEnd = Math.floor(signal.confirmedAt / 30_000) * 30_000;
    const g2 = aggregateG2Window(
      readNormalizedTrades(
        this.options.database,
        { chain: record.chain, poolAddress: pool.poolAddress, tokenAddress: pool.tokenAddress },
        windowEnd - 30_000,
        windowEnd,
      ),
      windowEnd - 30_000,
      windowEnd,
      now,
    );
    const guard = evaluateDispatchGuard({
      signal,
      now,
      safety,
      latestPoolStable: level1.poolStatus === 'stable',
      latestPoolFresh: isLevel1Fresh(
        level1,
        now,
        this.options.config.chains[record.chain].level1.buyers_freshness_seconds,
      ),
      latestG2State: g2.status,
      latestPriceUsd: level1.priceUsd,
      maxPreSendDrift: String(
        this.options.config.strategies.emerging_breakout.entry_quality.max_pre_send_drift,
      ),
    });
    if (guard.status === 'send') return guard;
    if (guard.reason === 'expired:entry_ttl' || guard.reason === 'pre_send_drift:overextended')
      return { status: 'cancel', reason: guard.reason };
    return { status: 'defer', reason: guard.reason };
  }

  public onStatusChange(listener: () => void): void {
    this.statusChangeListener = listener;
  }

  private async runOnce(): Promise<void> {
    if (this.stopping || this.inFlight) return;
    this.inFlight = Promise.allSettled([this.probeGmgn(), this.probeTelegram()])
      .then(async (results) => {
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => this.safeError(result.reason));
        try {
          await this.probeCoinGecko();
        } catch (error) {
          failures.push(this.safeError(error));
        }
        return failures;
      })
      .then((results) => {
        this.lastProbeAt = Date.now();
        this.lastError = results[0];
        this.statusChangeListener?.();
        this.options.logger('info', 'provider_probe_status', {
          status: this.status(),
          failure_count: results.length,
        });
        if (results.length > 0)
          this.options.logger('warn', 'provider_probe_failed', { errors: results });
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
          const event = this.recordGmgnEvent(raw, `market.trending.${interval}`, chain, observedAt);
          this.ingestTrending(chain, interval, parsed.data.rank, observedAt, event.id);
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
        const event = this.recordGmgnEvent(raw, 'market.hot-searches.1m', chain, observedAt);
        const group = parsed.find((item) => item.chain === chain);
        this.ingestHotSearches(chain, group?.tokens ?? [], observedAt, event.id);
        this.closeExpired(chain, observedAt);
        if (chain === 'sol')
          await delay(this.options.config.providers.gmgn.rate_limit.minimum_interval_ms);
      }
      this.safety = 'ok';
      this.gmgn = 'ok';
    } catch (error) {
      this.safety = 'failed';
      this.gmgn = 'failed';
      throw error;
    }
  }

  private recordGmgnEvent(
    raw: string,
    capability: string,
    chain: 'sol' | 'bsc',
    observedAt: number,
  ): { id: number } {
    return insertProviderEvent(
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
    providerEventId: number,
  ): void {
    tokens.forEach((token, index) => {
      this.ingestCandidate(
        {
          chain,
          tokenAddress: String(token.address ?? token.token_address ?? ''),
          source: interval === '1m' ? 'trending_1m' : 'trending_5m',
          observedAt,
          rank: index + 1,
        },
        token,
        providerEventId,
      );
    });
  }

  private ingestHotSearches(
    chain: 'sol' | 'bsc',
    tokens: Record<string, unknown>[],
    observedAt: number,
    providerEventId: number,
  ): void {
    tokens.forEach((token) => {
      const visitingCount = readSafeInteger(token.visiting_count);
      this.ingestCandidate(
        {
          chain,
          tokenAddress: String(token.address ?? token.token_address ?? ''),
          source: 'hot_searches',
          observedAt,
          ...(visitingCount === undefined ? {} : { visitingCount }),
        },
        token,
        providerEventId,
      );
    });
  }

  private ingestCandidate(
    observation: DiscoveryObservation,
    rawToken: Record<string, unknown>,
    providerEventId: number,
  ): void {
    if (!observation.tokenAddress) return;
    try {
      const result = this.trackers[observation.chain].ingest(observation);
      const cycle = result.cycle;
      const safety = this.evaluateSafety(
        observation.chain,
        rawToken,
        providerEventId,
        observation.observedAt,
      );
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
                safety_status, safety_json, funnel_status, config_version_id, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              cycle.chain,
              cycle.tokenAddress,
              cycle.cycleStartedAt,
              cycle.firstSeenAt,
              cycle.lastSeenAt,
              cycle.status,
              safety.status,
              JSON.stringify(safety),
              'safety_checked',
              this.options.configVersionId,
              Date.now(),
            );
          context.addRows(info.changes);
        } else {
          const info = this.options.database
            .prepare(
              `UPDATE candidates SET last_seen_at = ?,
               status = CASE WHEN status IN ('armed', 'confirmed-pending-anchor', 'delivered', 'completed')
                             THEN status ELSE ? END,
               safety_status = ?, safety_json = ?,
               funnel_status = CASE WHEN funnel_status IN ('armed', 'confirmed-pending-anchor', 'delivered', 'completed')
                                    THEN funnel_status ELSE 'safety_checked' END,
               updated_at = ? WHERE id = ?`,
            )
            .run(
              cycle.lastSeenAt,
              cycle.status,
              safety.status,
              JSON.stringify(safety),
              Date.now(),
              existing,
            );
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

  private evaluateSafety(
    chain: 'sol' | 'bsc',
    raw: Record<string, unknown>,
    providerEventId: number,
    checkedAt: number,
  ): SafetyResult {
    const context = {
      checkedAt,
      providerEventId: String(providerEventId),
      configVersionId: String(this.options.configVersionId),
    };
    return chain === 'sol'
      ? evaluateSolSafety(raw, this.options.config.chains.sol.safety, context)
      : evaluateBscSafety(raw, this.options.config.chains.bsc.safety, context);
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
      await this.resolveCoinGeckoPools(key);
      await this.refreshLevel1(key);
      await this.armEligibleCandidates(key);
      await this.processOutcomes(key);
      this.coingecko = 'ok';
    } catch (error) {
      this.coingecko = 'failed';
      throw error;
    }
  }

  private async refreshLevel1(key: string): Promise<void> {
    const rows = this.options.database
      .prepare(
        `SELECT chain, token_address, pool_address FROM candidates
         WHERE safety_status = 'pass' AND status != 'expired' AND pool_address IS NOT NULL
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(this.options.config.providers.coingecko.max_pools_per_batch * 2) as Array<{
      chain: 'sol' | 'bsc';
      token_address: string;
      pool_address: string;
    }>;
    let attempted = 0;
    let complete = 0;
    for (const chain of ['sol', 'bsc'] as const) {
      const chainRows = rows
        .filter((row) => row.chain === chain)
        .slice(0, this.options.config.providers.coingecko.max_pools_per_batch);
      const poolRows = dedupePools(chainRows);
      if (poolRows.length === 0) continue;
      const network = chain === 'sol' ? 'solana' : 'bsc';
      const addresses = poolRows.map((row) => row.pool_address);
      const url = `${this.options.config.providers.coingecko.rest_base_url}/onchain/networks/${network}/pools/multi/${addresses.map(encodeURIComponent).join(',')}?include=base_token,quote_token&include_volume_breakdown=true&include_composition=true`;
      assertAnalystEndpoint(url, this.options.config.providers.coingecko.rest_base_url);
      const result = await requestJson<Record<string, unknown>>(
        url,
        { headers: { 'x-cg-pro-api-key': key } },
        httpOptions(this.options.config, 'coingecko', 'pools.multi.level1'),
      );
      const parsed = coingeckoPoolBatchRawSchema.parse(result.data);
      const observedAt = Date.now();
      insertProviderEvent(
        this.options.database,
        {
          provider: 'coingecko',
          capability: 'pools.multi.level1',
          chain,
          observedAt,
          schemaVersion: 'coingecko.pools.multi.v1',
          payload: JSON.stringify(parsed),
          billingBucket: 'pool_screening',
          requestMeta: {
            endpoint_name: 'onchain.pools.multi',
            method: 'GET',
            status: result.diagnostic.status,
            response_bytes: Buffer.byteLength(JSON.stringify(parsed)),
          },
        },
        this.options.writeBudget,
      );
      for (const row of poolRows) {
        const raw = poolRawForAddress(parsed, network, row.pool_address, row.token_address);
        if (!raw) {
          attempted += 1;
          continue;
        }
        const parsedPool = parsePool(raw, chain, row.token_address);
        if (parsedPool.status !== 'complete') {
          attempted += 1;
          continue;
        }
        const tradeUrl = `${this.options.config.providers.coingecko.rest_base_url}/onchain/networks/${network}/pools/${encodeURIComponent(row.pool_address)}/trades`;
        assertAnalystEndpoint(tradeUrl, this.options.config.providers.coingecko.rest_base_url);
        const tradeResult = await requestJson<Record<string, unknown>>(
          tradeUrl,
          { headers: { 'x-cg-pro-api-key': key } },
          httpOptions(this.options.config, 'coingecko', 'trades.level1'),
        );
        const tradePayload = coingeckoTradesRawSchema.parse(tradeResult.data);
        const tradeObservedAt = Date.now();
        insertProviderEvent(
          this.options.database,
          {
            provider: 'coingecko',
            capability: 'trades.level1',
            chain,
            tokenAddress: row.token_address,
            poolAddress: row.pool_address,
            observedAt: tradeObservedAt,
            schemaVersion: 'coingecko.trades.v1',
            payload: JSON.stringify(tradePayload),
            billingBucket: 'pool_screening',
            requestMeta: {
              endpoint_name: 'onchain.pools.trades',
              method: 'GET',
              status: tradeResult.diagnostic.status,
              response_bytes: Buffer.byteLength(JSON.stringify(tradePayload)),
            },
          },
          this.options.writeBudget,
        );
        attempted += 1;
        const level1 = parseLevel1Snapshot(
          level1RawForPool(
            raw,
            parsedPool.pool,
            findPoolAttributes(parsed, network, row.pool_address),
            observedAt,
            latestTradeAt(tradePayload),
          ),
          parsedPool.pool,
          observedAt,
        );
        if (level1.status !== 'complete') continue;
        complete += 1;
        const previous = this.level1Snapshots.get(parsedPool.pool.identityKey);
        if (previous) this.previousLevel1Snapshots.set(parsedPool.pool.identityKey, previous);
        this.level1Snapshots.set(parsedPool.pool.identityKey, level1.snapshot);
        this.level1Pools.set(`${chain}:${row.pool_address}:${row.token_address}`, parsedPool.pool);
        boundedWrite(this.options.database, this.options.writeBudget, (context) => {
          const info = this.options.database
            .prepare(
              `UPDATE candidates SET funnel_status = 'level1_checked', updated_at = ?
               WHERE chain = ? AND token_address = ? AND pool_address = ? AND safety_status = 'pass'
                 AND funnel_status != 'armed'`,
            )
            .run(observedAt, chain, row.token_address, row.pool_address);
          context.addRows(info.changes);
        });
      }
      await delay(60_000 / this.options.config.providers.coingecko.rest_requests_per_minute);
    }
    this.level1 =
      complete > 0 && complete === attempted ? 'ok' : attempted > 0 ? 'failed' : 'unknown';
  }

  private async armEligibleCandidates(key: string): Promise<void> {
    const rows = this.options.database
      .prepare(
        `SELECT chain, token_address, pool_address FROM candidates
         WHERE safety_status = 'pass' AND status != 'expired' AND funnel_status = 'level1_checked'
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(this.options.config.providers.coingecko.max_pools_per_batch * 2) as Array<{
      chain: 'sol' | 'bsc';
      token_address: string;
      pool_address: string;
    }>;
    const pools: CanonicalPool[] = [];
    for (const row of rows) {
      const pool = this.level1Pools.get(`${row.chain}:${row.pool_address}:${row.token_address}`);
      const cycle = this.trackers[row.chain].get(row.chain, row.token_address);
      const snapshot = pool ? this.level1Snapshots.get(pool.identityKey) : undefined;
      if (
        !pool ||
        !cycle ||
        !snapshot ||
        !isLevel1Fresh(
          snapshot,
          Date.now(),
          this.options.config.chains[row.chain].level1.buyers_freshness_seconds,
        )
      )
        continue;
      const attention = evaluateAttention(
        attentionInput(cycle.evidence),
        this.options.config.strategies.emerging_breakout.attention,
      );
      if (attention.status !== 'pass') continue;
      pools.push(pool);
    }
    if (pools.length === 0) return;
    this.g2Client ??= new CoinGeckoG2Client({
      websocketUrl: this.options.config.providers.coingecko.websocket_url,
      apiKey: key,
      maxSubscriptions: this.options.config.providers.coingecko.g2.max_subscriptions_per_socket,
      maxResponseBytes: this.options.config.providers.coingecko.max_response_bytes,
      connectTimeoutMs: this.options.config.providers.coingecko.request_timeout_ms,
      reconnectDelayMs: 1_000,
      logger: this.options.logger,
      onMessage: (message, observedAt) => this.recordG2Message(message, observedAt),
    });
    await this.g2Client.start();
    for (const pool of pools) {
      const result = this.g2Client.request(pool, 'armed');
      if (result === 'rejected_capacity') continue;
      boundedWrite(this.options.database, this.options.writeBudget, (context) => {
        const info = this.options.database
          .prepare(
            `UPDATE candidates SET status = 'armed', funnel_status = 'armed', updated_at = ?
             WHERE chain = ? AND token_address = ? AND pool_address = ? AND safety_status = 'pass'`,
          )
          .run(Date.now(), pool.chain, pool.tokenAddress, pool.poolAddress);
        context.addRows(info.changes);
      });
    }
  }

  private async processOutcomes(key: string): Promise<void> {
    const anchorDestination = this.options.config.delivery.outcome_anchor_destination;
    const rows = this.options.database
      .prepare(
        `SELECT s.id AS signal_id, s.config_version_id, s.snapshot_json, s.pre_send_drift,
                c.chain, c.token_address, c.pool_address, c.target_side,
                o.status AS anchor_status, o.sent_at, o.delivery_uncertain
         FROM signals s
         JOIN candidates c ON c.id = s.candidate_id
         JOIN delivery_outbox o ON o.signal_id = s.id
          AND o.destination = ? AND o.message_type = 'ENTRY_SIGNAL'
         LEFT JOIN outcomes x ON x.signal_id = s.id
         WHERE x.id IS NULL AND o.status IN ('sent', 'expired')
         ORDER BY o.sent_at ASC, s.id ASC LIMIT 20`,
      )
      .all(anchorDestination) as Array<{
      signal_id: number;
      config_version_id: number;
      snapshot_json: string;
      pre_send_drift: string | null;
      chain: 'sol' | 'bsc';
      token_address: string;
      pool_address: string | null;
      target_side: 'base' | 'quote' | null;
      anchor_status: 'sent' | 'expired';
      sent_at: number | null;
      delivery_uncertain: number;
    }>;
    for (const row of rows) {
      if (row.delivery_uncertain === 1) {
        this.expireSignal(row.signal_id, 'anchor:delivery_uncertain');
        continue;
      }
      if (row.anchor_status === 'expired' || row.sent_at === null) {
        this.expireSignal(row.signal_id, 'anchor:expired');
        continue;
      }
      this.markSignalDelivered(row.signal_id);
      const signal = parseSignalSnapshot(row.snapshot_json);
      const pool = row.pool_address
        ? [...this.level1Pools.values()].find(
            (candidate) =>
              candidate.chain === row.chain &&
              candidate.poolAddress === row.pool_address &&
              candidate.tokenAddress === row.token_address,
          )
        : undefined;
      if (!signal || !pool || row.target_side === null) continue;
      const now = Date.now();
      const pollKey = pool.identityKey;
      const lastPollAt = this.outcomePollAt.get(pollKey);
      const ageSeconds = Math.max(0, Math.floor((now - row.sent_at) / 1000));
      const pollMs = outcomePollIntervalMs(
        ageSeconds,
        this.options.config.outcomes.rest_poll_segments_seconds,
        this.options.config.providers.coingecko.rest_requests_per_minute,
      );
      if (lastPollAt !== undefined && now - lastPollAt < pollMs) continue;
      this.outcomePollAt.set(pollKey, now);
      const maxHorizon = Math.max(...this.options.config.outcomes.horizons_seconds);
      const finalCutoff =
        row.sent_at +
        (maxHorizon + this.options.config.outcomes.outcome_max_lateness_seconds) * 1000;
      try {
        const candles = await this.fetchOutcomeCandles(key, pool, row.sent_at, now);
        if (now < finalCutoff) continue;
        const trades = readNormalizedTrades(
          this.options.database,
          pool,
          row.sent_at - this.options.config.outcomes.entry_max_event_delay_seconds * 1000,
          finalCutoff,
        );
        const entry = selectEntry({
          trades,
          chain: row.chain,
          poolAddress: pool.poolAddress,
          tokenAddress: pool.tokenAddress,
          anchorDeliveredAt: row.sent_at,
          now,
          entryTimeoutSeconds: this.options.config.outcomes.entry_timeout_seconds,
          maxTransportDelaySeconds: this.options.config.outcomes.entry_max_event_delay_seconds,
          maxFutureSkewSeconds: this.options.config.outcomes.max_future_event_skew_seconds,
          anchorToleranceSeconds: this.options.config.outcomes.entry_max_event_delay_seconds,
        });
        const selectedEntry = entry.status === 'executable' ? entry.trade : undefined;
        const execution = evaluateExecution({
          entry,
          g2CoverageComplete: !this.g2QueueIncomplete,
          restCoverageComplete: hasCandleCoverage(
            candles,
            row.sent_at,
            row.sent_at + maxHorizon * 1000,
          ),
          restConflict:
            selectedEntry !== undefined &&
            !candleContainsTrade(candles, selectedEntry, row.sent_at),
        });
        const entryPartial = selectedEntry ? partialFromTrades(selectedEntry, trades) : undefined;
        const horizonResults = this.options.config.outcomes.horizons_seconds.map((horizonSeconds) =>
          evaluateHorizon({
            anchorDeliveredAt: row.sent_at!,
            horizonSeconds,
            outcomeMaxLatenessSeconds: this.options.config.outcomes.outcome_max_lateness_seconds,
            ...(selectedEntry
              ? {
                  entry: { observedAt: selectedEntry.observedAt, priceUsd: selectedEntry.priceUsd },
                }
              : {}),
            candles,
            ...(entryPartial ? { entryPartial } : {}),
          }),
        );
        const entryEventId = selectedEntry
          ? findTradeId(this.options.database, selectedEntry)
          : undefined;
        insertOutcome(this.options.database, {
          signalId: row.signal_id,
          configVersionId: row.config_version_id,
          anchorDestination,
          anchorDeliveredAt: row.sent_at,
          executionStatus: execution.status,
          executionReason: execution.reason,
          ...(entryEventId === undefined ? {} : { entryEventId }),
          ...(selectedEntry
            ? {
                entryObservedAt: selectedEntry.observedAt,
                deliveryToEntryLatencyMs: selectedEntry.observedAt - row.sent_at,
                entryPrice: selectedEntry.priceUsd,
                deliveryDrift: drift(selectedEntry.priceUsd, signal.confirmationPriceUsd),
              }
            : {}),
          ...(row.pre_send_drift === null ? {} : { preSendDrift: row.pre_send_drift }),
          horizonResults,
          createdAt: now,
          budget: this.options.writeBudget,
        });
        this.completeSignal(row.signal_id);
      } catch (error) {
        this.options.logger('warn', 'outcome_runtime_incomplete', {
          signal_id: row.signal_id,
          error: this.safeError(error),
        });
      }
    }
  }

  private async fetchOutcomeCandles(
    key: string,
    pool: CanonicalPool,
    anchorDeliveredAt: number,
    now: number,
  ): Promise<Candle[]> {
    const network = pool.chain === 'sol' ? 'solana' : 'bsc';
    const limit = Math.min(
      500,
      Math.ceil(
        (Math.max(...this.options.config.outcomes.horizons_seconds) +
          this.options.config.outcomes.outcome_max_lateness_seconds +
          this.options.config.outcomes.entry_timeout_seconds) /
          30,
      ) + 4,
    );
    const url = `${this.options.config.providers.coingecko.rest_base_url}/onchain/networks/${network}/pools/${encodeURIComponent(pool.poolAddress)}/ohlcv/second?aggregate=30&limit=${limit}&currency=usd&token=${pool.targetSide}&include_empty_intervals=true`;
    assertAnalystEndpoint(url, this.options.config.providers.coingecko.rest_base_url);
    const result = await requestJson<Record<string, unknown>>(
      url,
      { headers: { 'x-cg-pro-api-key': key } },
      httpOptions(this.options.config, 'coingecko', 'ohlcv.30s'),
    );
    const observedAt = Date.now();
    const parsed = coingeckoOhlcv30sRawSchema.parse(result.data);
    const payload = JSON.stringify(parsed);
    const providerEvent = insertProviderEvent(
      this.options.database,
      {
        provider: 'coingecko',
        capability: 'ohlcv.30s',
        chain: pool.chain,
        tokenAddress: pool.tokenAddress,
        poolAddress: pool.poolAddress,
        observedAt,
        schemaVersion: 'coingecko.ohlcv.30s.v1',
        payload,
        billingBucket: 'outcome',
        requestMeta: {
          endpoint_name: 'onchain.pools.ohlcv.second',
          method: 'GET',
          status: result.diagnostic.status,
          response_bytes: Buffer.byteLength(payload),
        },
      },
      this.options.writeBudget,
    );
    const rows = parseCoinGeckoOhlcv30s(parsed, pool, observedAt).filter(
      (row) =>
        row.timestampMs < now + 30_000 && row.timestampMs + 30_000 > anchorDeliveredAt - 30_000,
    );
    for (const row of rows) {
      const latest = this.options.database
        .prepare(
          `SELECT revision, open_price, high_price, low_price, close_price, volume, is_closed
           FROM candles_30s WHERE chain = ? AND pool_address = ? AND token_address = ?
             AND target_side = ? AND open_time = ? ORDER BY revision DESC LIMIT 1`,
        )
        .get(pool.chain, pool.poolAddress, pool.tokenAddress, pool.targetSide, row.timestampMs) as
        | {
            revision: number;
            open_price: string;
            high_price: string;
            low_price: string;
            close_price: string;
            volume: string;
            is_closed: number;
          }
        | undefined;
      const revision =
        latest && sameCandleDbValues(latest, row) ? latest.revision : (latest?.revision ?? -1) + 1;
      const candle = toCandle(pool, row, observedAt, revision);
      if (
        latest &&
        sameCandleDbValues(latest, row) &&
        latest.is_closed === (candle.isClosed ? 1 : 0)
      )
        continue;
      boundedWrite(this.options.database, this.options.writeBudget, (context) => {
        this.options.database
          .prepare(
            `INSERT INTO candles_30s
             (provider_event_id, chain, pool_address, token_address, target_side, interval_seconds,
              open_time, revision, observed_at, is_closed, open_price, high_price, low_price, close_price, volume, parser_version)
             VALUES (?, ?, ?, ?, ?, 30, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'coingecko.ohlcv.30s.v1')`,
          )
          .run(
            providerEvent.id,
            candle.chain,
            candle.poolAddress,
            candle.tokenAddress,
            candle.targetSide,
            candle.openTime,
            candle.revision,
            candle.observedAt,
            candle.isClosed ? 1 : 0,
            candle.openPrice,
            candle.highPrice,
            candle.lowPrice,
            candle.closePrice,
            candle.volume,
          );
        context.addRows(1);
      });
    }
    return readCandles(this.options.database, pool, anchorDeliveredAt - 30_000, now + 30_000);
  }

  private expireSignal(signalId: number, reason: string): void {
    boundedWrite(this.options.database, this.options.writeBudget, (context) => {
      const signal = this.options.database
        .prepare(
          `UPDATE signals SET status = 'expired', cancel_reason = ? WHERE id = ? AND status != 'completed'`,
        )
        .run(reason, signalId);
      const candidate = this.options.database
        .prepare(
          `UPDATE candidates SET status = 'expired', funnel_status = 'expired', close_reason = ?, updated_at = ?
           WHERE id = (SELECT candidate_id FROM signals WHERE id = ?) AND status != 'completed'`,
        )
        .run(reason, Date.now(), signalId);
      context.addRows(signal.changes + candidate.changes);
    });
    this.unsetSignalG2(signalId);
  }

  private markSignalDelivered(signalId: number): void {
    boundedWrite(this.options.database, this.options.writeBudget, (context) => {
      const signal = this.options.database
        .prepare(
          `UPDATE signals SET status = 'delivered'
           WHERE id = ? AND status = 'confirmed-pending-anchor'`,
        )
        .run(signalId);
      const candidate = this.options.database
        .prepare(
          `UPDATE candidates SET status = 'delivered', funnel_status = 'delivered', updated_at = ?
           WHERE id = (SELECT candidate_id FROM signals WHERE id = ?)
             AND status = 'confirmed-pending-anchor'`,
        )
        .run(Date.now(), signalId);
      context.addRows(signal.changes + candidate.changes);
    });
  }

  private completeSignal(signalId: number): void {
    boundedWrite(this.options.database, this.options.writeBudget, (context) => {
      const signal = this.options.database
        .prepare(`UPDATE signals SET status = 'completed' WHERE id = ? AND status != 'completed'`)
        .run(signalId);
      const candidate = this.options.database
        .prepare(
          `UPDATE candidates SET status = 'completed', funnel_status = 'completed', updated_at = ?
           WHERE id = (SELECT candidate_id FROM signals WHERE id = ?) AND status != 'completed'`,
        )
        .run(Date.now(), signalId);
      context.addRows(signal.changes + candidate.changes);
    });
    this.unsetSignalG2(signalId);
  }

  private unsetSignalG2(signalId: number): void {
    const signal = this.options.database
      .prepare(
        `SELECT c.chain, c.pool_address, c.token_address
         FROM signals s JOIN candidates c ON c.id = s.candidate_id WHERE s.id = ?`,
      )
      .get(signalId) as
      { chain: 'sol' | 'bsc'; pool_address: string | null; token_address: string } | undefined;
    if (signal?.pool_address)
      this.g2Client?.unset(`${signal.chain}:${signal.pool_address}:${signal.token_address}`);
  }

  private recordG2Message(message: Record<string, unknown>, observedAt: number): void {
    const parsed = coingeckoG2RawSchema.safeParse(message);
    if (!parsed.success) {
      this.markG2Incomplete('schema:rejected');
      return;
    }
    const network = parsed.data.n;
    const poolAddress = parsed.data.pa;
    const chain = network === 'solana' ? 'sol' : 'bsc';
    const providerEvent = insertProviderEvent(
      this.options.database,
      {
        provider: 'coingecko',
        capability: 'G2',
        chain,
        poolAddress,
        observedAt,
        ...(typeof parsed.data.t === 'number' ? { eventAt: parsed.data.t } : {}),
        schemaVersion: 'coingecko.g2.v1',
        payload: JSON.stringify(parsed.data),
        billingBucket: 'g2_confirmation',
        requestMeta: { endpoint_name: 'OnchainTrade', method: 'WebSocket' },
      },
      this.options.writeBudget,
    );
    const result = this.g2Queue.enqueue(
      { raw: parsed.data, observedAt, providerEventId: providerEvent.id },
      observedAt,
      1,
    );
    if (!result.accepted) return;
    this.scheduleG2Drain();
  }

  private scheduleG2Drain(): void {
    if (this.g2DrainScheduled) return;
    this.g2DrainScheduled = true;
    setImmediate(() => {
      this.g2DrainScheduled = false;
      this.g2DrainInFlight = this.drainG2().finally(() => {
        this.g2DrainInFlight = undefined;
      });
    });
  }

  private async drainG2(): Promise<void> {
    const items = this.g2Queue.drain(this.g2Queue.size());
    for (const item of items) {
      const network = item.value.raw.n;
      const chain = network === 'solana' ? 'sol' : 'bsc';
      const pool = [...this.level1Pools.values()].find(
        (candidate) => candidate.chain === chain && candidate.poolAddress === item.value.raw.pa,
      );
      if (!pool) {
        this.markG2Incomplete('identity:unknown_pool');
        continue;
      }
      const parsed = normalizeG2Item(item.value.raw, pool, item.value.observedAt);
      if (parsed.status !== 'complete') {
        this.markG2Incomplete(parsed.reason);
        continue;
      }
      const deduped = this.g2Deduper.ingest(hashG2Message(item.value.raw), [parsed.trade]);
      for (const trade of deduped.trades) {
        boundedWrite(this.options.database, this.options.writeBudget, (context) => {
          const info = this.options.database
            .prepare(
              `INSERT OR IGNORE INTO trades
               (provider_event_id, chain, pool_address, token_address, raw_side, target_side,
                token_amount, quote_amount, volume_usd, price_usd, event_at, observed_at,
                tx_hash, provider_trade_id, log_index, leg_index, item_index, identity_key,
                dedup_status, ambiguity_status, parser_version)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              item.value.providerEventId,
              trade.chain,
              trade.poolAddress,
              trade.tokenAddress,
              trade.rawSide,
              trade.targetSide,
              trade.tokenAmount,
              trade.quoteAmount,
              trade.quoteAmount,
              trade.priceUsd,
              trade.eventAt,
              trade.observedAt,
              trade.txHash ?? null,
              trade.providerTradeId ?? null,
              trade.logIndex ?? null,
              trade.legIndex ?? null,
              trade.itemIndex,
              trade.identityKey ?? null,
              trade.dedupStatus,
              trade.ambiguityStatus,
              'coingecko.g2.v1',
            );
          context.addRows(info.changes);
        });
        this.tryCreateLiveSignal(trade);
      }
    }
  }

  private tryCreateLiveSignal(trade: NormalizedTrade): void {
    const candidate = this.options.database
      .prepare(
        `SELECT id, cycle_started_at, safety_json FROM candidates
         WHERE chain = ? AND token_address = ? AND pool_address = ?
           AND status = 'armed' AND safety_status = 'pass'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(trade.chain, trade.tokenAddress, trade.poolAddress) as
      { id: number; cycle_started_at: number; safety_json: string | null } | undefined;
    if (!candidate?.safety_json) return;
    const cycle = this.trackers[trade.chain].get(trade.chain, trade.tokenAddress);
    const pool = [...this.level1Pools.values()].find(
      (item) =>
        item.chain === trade.chain &&
        item.tokenAddress === trade.tokenAddress &&
        item.poolAddress === trade.poolAddress,
    );
    if (!cycle || !pool) return;
    const level1 = this.level1Snapshots.get(pool.identityKey);
    if (!level1) return;
    const now = Date.now();
    const windowEnd = Math.floor(now / 30_000) * 30_000;
    if (trade.eventAt >= windowEnd) {
      this.scheduleSignalCheck(trade, windowEnd + 100);
      return;
    }
    const windowStart = windowEnd - 30_000;
    const g2 = aggregateG2Window(
      readNormalizedTrades(this.options.database, trade, windowStart, windowEnd),
      windowStart,
      windowEnd,
      windowEnd,
    );
    const safety = parseSafety(candidate.safety_json);
    if (!safety) return;
    const anchorCooldownUntil = this.findAnchorCooldown(trade.chain, trade.tokenAddress, now);
    let result;
    try {
      result = createLiveSignal({
        config: this.options.config,
        database: this.options.database,
        writeBudget: this.options.writeBudget,
        configVersionId: this.options.configVersionId,
        candidateId: candidate.id,
        cycle,
        safety,
        pool,
        level1,
        ...(this.previousLevel1Snapshots.has(pool.identityKey)
          ? { previousLevel1: this.previousLevel1Snapshots.get(pool.identityKey)! }
          : {}),
        g2,
        attention: evaluateAttention(
          attentionInput(cycle.evidence),
          this.options.config.strategies.emerging_breakout.attention,
        ),
        confirmedAt: now,
        ...(anchorCooldownUntil === undefined ? {} : { anchorCooldownUntil }),
      });
    } catch (error) {
      this.options.logger('error', 'live_signal_evaluation_failed', {
        chain: trade.chain,
        pool_address: trade.poolAddress,
        error: this.safeError(error),
      });
      return;
    }
    if (result.status !== 'created') return;
    this.g2Client?.request(pool, 'confirmed-pending-anchor');
    this.options.logger('info', 'signal_created', {
      signal_id: result.signalId,
      candidate_id: candidate.id,
      chain: trade.chain,
      pool_address: trade.poolAddress,
    });
  }

  private scheduleSignalCheck(trade: NormalizedTrade, at: number): void {
    const key = `${trade.chain}:${trade.poolAddress}:${trade.tokenAddress}:${at}`;
    if (this.signalCheckTimers.has(key)) return;
    const timer = setTimeout(
      () => {
        this.signalCheckTimers.delete(key);
        this.tryCreateLiveSignal(trade);
      },
      Math.max(1, at - Date.now()),
    );
    this.signalCheckTimers.set(key, timer);
  }

  private findAnchorCooldown(
    chain: 'sol' | 'bsc',
    tokenAddress: string,
    now: number,
  ): number | undefined {
    const row = this.options.database
      .prepare(
        `SELECT signals.confirmed_at FROM signals
         JOIN candidates ON candidates.id = signals.candidate_id
         WHERE candidates.chain = ? AND candidates.token_address = ?
         ORDER BY signals.confirmed_at DESC LIMIT 1`,
      )
      .get(chain, tokenAddress) as { confirmed_at: number } | undefined;
    if (!row) return undefined;
    const until =
      row.confirmed_at + this.options.config.strategies.emerging_breakout.cooldown_seconds * 1000;
    return until > now ? until : undefined;
  }

  private markG2Incomplete(reason: string): void {
    this.g2QueueIncomplete = true;
    this.g2Queue.markIncomplete(reason);
    this.options.logger('warn', 'g2_evidence_incomplete', { reason });
  }

  private async resolveCoinGeckoPools(key: string): Promise<void> {
    const disk = readDiskHealth(
      path.dirname(path.resolve(this.options.config.storage.database_path)),
      this.options.config.storage.disk_high_water_percent,
    );
    if (disk.highWater) throw new Error('disk:high_water');
    const rows = this.options.database
      .prepare(
        `SELECT id, chain, token_address FROM candidates
         WHERE safety_status = 'pass' AND status != 'expired' AND pool_address IS NULL
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(this.options.config.providers.coingecko.max_pools_per_batch * 2) as Array<{
      id: number;
      chain: 'sol' | 'bsc';
      token_address: string;
    }>;
    for (const chain of ['sol', 'bsc'] as const) {
      const chainRows = rows.filter((row) => row.chain === chain);
      const tokens = [...new Set(chainRows.map((row) => row.token_address))].slice(
        0,
        this.options.config.providers.coingecko.max_pools_per_batch,
      );
      if (tokens.length === 0) continue;
      const network = chain === 'sol' ? 'solana' : 'bsc';
      const url = `${this.options.config.providers.coingecko.rest_base_url}/onchain/networks/${network}/tokens/multi/${tokens.map(encodeURIComponent).join(',')}?include=top_pools&include_composition=true`;
      assertAnalystEndpoint(url, this.options.config.providers.coingecko.rest_base_url);
      const result = await requestJson<Record<string, unknown>>(
        url,
        { headers: { 'x-cg-pro-api-key': key } },
        httpOptions(this.options.config, 'coingecko', 'tokens.multi'),
      );
      const parsed = coingeckoPoolBatchRawSchema.parse(result.data);
      const observedAt = Date.now();
      insertProviderEvent(
        this.options.database,
        {
          provider: 'coingecko',
          capability: 'tokens.multi',
          chain,
          observedAt,
          schemaVersion: 'coingecko.tokens.multi.v1',
          payload: JSON.stringify(parsed),
          billingBucket: 'pool_screening',
          requestMeta: {
            endpoint_name: 'onchain.tokens.multi',
            method: 'GET',
            status: result.diagnostic.status,
            response_bytes: Buffer.byteLength(JSON.stringify(parsed)),
          },
        },
        this.options.writeBudget,
      );
      this.applyPoolSelections(
        chainRows.filter((row) => tokens.includes(row.token_address)),
        parsed,
        network,
        observedAt,
      );
      await delay(60_000 / this.options.config.providers.coingecko.rest_requests_per_minute);
    }
  }

  private applyPoolSelections(
    rows: Array<{ id: number; chain: 'sol' | 'bsc'; token_address: string }>,
    response: Record<string, unknown>,
    network: 'solana' | 'bsc',
    observedAt: number,
  ): void {
    for (const token of [...new Set(rows.map((row) => row.token_address))]) {
      const parsedPools = poolRawsForToken(response, network, token)
        .map((raw) => parsePool(raw, network === 'solana' ? 'sol' : 'bsc', token))
        .filter(
          (result): result is { status: 'complete'; pool: CanonicalPool } =>
            result.status === 'complete',
        )
        .map((result) => result.pool);
      const selection = selectPrimaryPool(parsedPools);
      const tokenRows = rows.filter((row) => row.token_address === token);
      boundedWrite(this.options.database, this.options.writeBudget, (context) => {
        if (selection.status === 'resolved') {
          const pool = selection.pool;
          const info = this.options.database
            .prepare(
              `UPDATE candidates SET pool_address = ?, target_side = ?, funnel_status = 'pool_resolved', updated_at = ?
               WHERE chain = ? AND token_address = ? AND safety_status = 'pass' AND pool_address IS NULL`,
            )
            .run(pool.poolAddress, pool.targetSide, observedAt, pool.chain, token);
          context.addRows(info.changes);
        } else {
          const info = this.options.database
            .prepare(
              `UPDATE candidates SET funnel_status = 'pool_unresolved', updated_at = ?
               WHERE chain = ? AND token_address = ? AND safety_status = 'pass' AND pool_address IS NULL`,
            )
            .run(observedAt, tokenRows[0]?.chain ?? (network === 'solana' ? 'sol' : 'bsc'), token);
          context.addRows(info.changes);
        }
      });
      this.options.logger('info', 'candidate_pool_resolution', {
        chain: network === 'solana' ? 'sol' : 'bsc',
        token_address: token,
        status: selection.status,
        ...(selection.status === 'resolved'
          ? { pool_address: selection.pool.poolAddress }
          : { reason: selection.reason }),
      });
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

function attentionInput(evidence: readonly DiscoveryObservation[]): {
  rankBefore?: number;
  rankAfter?: number;
  visitingBefore?: number;
  visitingAfter?: number;
} {
  const bySource = new Map<string, DiscoveryObservation[]>();
  for (const item of evidence)
    bySource.set(item.source, [...(bySource.get(item.source) ?? []), item]);
  const choices = [...bySource.values()]
    .map((items) => items.sort((left, right) => left.observedAt - right.observedAt))
    .filter((items) => items.length >= 2)
    .sort((left, right) => right.at(-1)!.observedAt - left.at(-1)!.observedAt);
  const selected = choices[0];
  if (!selected) return {};
  const previous = selected.at(-2)!;
  const latest = selected.at(-1)!;
  return selected[0]!.source === 'hot_searches'
    ? {
        ...(previous.visitingCount === undefined ? {} : { visitingBefore: previous.visitingCount }),
        ...(latest.visitingCount === undefined ? {} : { visitingAfter: latest.visitingCount }),
      }
    : {
        ...(previous.rank === undefined ? {} : { rankBefore: previous.rank }),
        ...(latest.rank === undefined ? {} : { rankAfter: latest.rank }),
      };
}

function parseSafety(value: string): SafetyResult | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      record.status !== 'pass' &&
      record.status !== 'fatal' &&
      record.status !== 'policy_reject' &&
      record.status !== 'incomplete'
    )
      return undefined;
    if (
      !Array.isArray(record.reasons) ||
      !record.reasons.every((reason) => typeof reason === 'string') ||
      !Number.isSafeInteger(record.checkedAt) ||
      !Number.isSafeInteger(record.expiresAt) ||
      typeof record.providerEventId !== 'string' ||
      typeof record.configVersionId !== 'string' ||
      !record.canonical ||
      typeof record.canonical !== 'object' ||
      Array.isArray(record.canonical)
    )
      return undefined;
    return record as unknown as SafetyResult;
  } catch {
    return undefined;
  }
}

function parseSignalSnapshot(value: string): SignalSnapshot | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      record.signalType !== 'Emerging Breakout' ||
      (record.chain !== 'sol' && record.chain !== 'bsc') ||
      typeof record.candidateKey !== 'string' ||
      typeof record.tokenAddress !== 'string' ||
      typeof record.poolAddress !== 'string' ||
      typeof record.configVersionId !== 'string' ||
      typeof record.confirmationPriceUsd !== 'string' ||
      !Number.isSafeInteger(record.cycleStartedAt) ||
      !Number.isSafeInteger(record.confirmedAt) ||
      !Number.isSafeInteger(record.expiresAt)
    )
      return undefined;
    return record as unknown as SignalSnapshot;
  } catch {
    return undefined;
  }
}

function sameCandleDbValues(
  latest: {
    open_price: string;
    high_price: string;
    low_price: string;
    close_price: string;
    volume: string;
  },
  row: {
    openPrice: string;
    highPrice: string;
    lowPrice: string;
    closePrice: string;
    volume: string;
  },
): boolean {
  return (
    latest.open_price === row.openPrice &&
    latest.high_price === row.highPrice &&
    latest.low_price === row.lowPrice &&
    latest.close_price === row.closePrice &&
    latest.volume === row.volume
  );
}

function readCandles(
  database: SqliteDatabase,
  pool: CanonicalPool,
  start: number,
  end: number,
): Candle[] {
  const rows = database
    .prepare(
      `SELECT chain, pool_address, token_address, target_side, interval_seconds, open_time,
              revision, observed_at, is_closed, open_price, high_price, low_price, close_price, volume
       FROM candles_30s
       WHERE chain = ? AND pool_address = ? AND token_address = ? AND target_side = ?
         AND open_time >= ? AND open_time < ?
       ORDER BY open_time ASC, revision ASC`,
    )
    .all(pool.chain, pool.poolAddress, pool.tokenAddress, pool.targetSide, start, end) as Array<
    Record<string, unknown>
  >;
  return rows.flatMap((row) => {
    if (
      (row.chain !== 'sol' && row.chain !== 'bsc') ||
      typeof row.pool_address !== 'string' ||
      typeof row.token_address !== 'string' ||
      (row.target_side !== 'base' && row.target_side !== 'quote') ||
      row.interval_seconds !== 30 ||
      !Number.isSafeInteger(row.open_time) ||
      !Number.isSafeInteger(row.revision) ||
      !Number.isSafeInteger(row.observed_at) ||
      (row.is_closed !== 0 && row.is_closed !== 1) ||
      typeof row.open_price !== 'string' ||
      typeof row.high_price !== 'string' ||
      typeof row.low_price !== 'string' ||
      typeof row.close_price !== 'string' ||
      typeof row.volume !== 'string'
    )
      return [];
    return [
      {
        chain: row.chain,
        poolAddress: row.pool_address,
        tokenAddress: row.token_address,
        targetSide: row.target_side,
        intervalSeconds: 30,
        openTime: row.open_time,
        revision: row.revision,
        observedAt: row.observed_at,
        isClosed: row.is_closed === 1,
        openPrice: row.open_price,
        highPrice: row.high_price,
        lowPrice: row.low_price,
        closePrice: row.close_price,
        volume: row.volume,
      } as Candle,
    ];
  });
}

function hasCandleCoverage(candles: readonly Candle[], start: number, end: number): boolean {
  const first = Math.ceil(start / 30_000) * 30_000;
  const latest = new Set(
    candles.filter((candle) => candle.isClosed).map((candle) => candle.openTime),
  );
  for (let openTime = first; openTime < end; openTime += 30_000)
    if (!latest.has(openTime)) return false;
  return true;
}

function candleContainsTrade(
  candles: readonly Candle[],
  trade: NormalizedTrade,
  anchorDeliveredAt: number,
): boolean {
  const openTime = Math.floor(trade.eventAt / 30_000) * 30_000;
  if (openTime < Math.ceil(anchorDeliveredAt / 30_000) * 30_000) return true;
  const candle = candles
    .filter((item) => item.isClosed && item.openTime === openTime)
    .sort((left, right) => right.revision - left.revision)
    .at(0);
  if (!candle) return false;
  try {
    const price = new Decimal(trade.priceUsd);
    return (
      price.greaterThanOrEqualTo(new Decimal(candle.lowPrice)) &&
      price.lessThanOrEqualTo(new Decimal(candle.highPrice))
    );
  } catch {
    return false;
  }
}

function outcomePollIntervalMs(
  ageSeconds: number,
  segments: readonly number[],
  requestsPerMinute: number,
): number {
  const [first = 600, second = 1_800] = segments;
  const base = Math.max(60_000 / requestsPerMinute, 30_000);
  if (ageSeconds < first) return base;
  if (ageSeconds < second) return Math.max(base, 60_000);
  return Math.max(base, 120_000);
}

function partialFromTrades(
  entry: NormalizedTrade,
  trades: readonly NormalizedTrade[],
): { highPrice: string; lowPrice: string; complete: boolean } | undefined {
  if (entry.observedAt % 30_000 === 0) return undefined;
  const nextBoundary = Math.ceil(entry.observedAt / 30_000) * 30_000;
  const partial = trades.filter(
    (trade) =>
      trade.observedAt >= entry.observedAt &&
      trade.observedAt < nextBoundary &&
      trade.dedupStatus === 'unique' &&
      trade.ambiguityStatus === 'none',
  );
  if (partial.length === 0)
    return { highPrice: entry.priceUsd, lowPrice: entry.priceUsd, complete: false };
  const prices = partial.map((trade) => new Decimal(trade.priceUsd));
  return {
    highPrice: prices.reduce((max, value) => (value.greaterThan(max) ? value : max)).toString(),
    lowPrice: prices.reduce((min, value) => (value.lessThan(min) ? value : min)).toString(),
    complete: true,
  };
}

function findTradeId(database: SqliteDatabase, trade: NormalizedTrade): number | undefined {
  const row = database
    .prepare(
      `SELECT id FROM trades
       WHERE chain = ? AND pool_address = ? AND token_address = ? AND event_at = ?
         AND observed_at = ? AND item_index = ? ORDER BY id ASC LIMIT 1`,
    )
    .get(
      trade.chain,
      trade.poolAddress,
      trade.tokenAddress,
      trade.eventAt,
      trade.observedAt,
      trade.itemIndex,
    ) as { id: number } | undefined;
  return row?.id;
}

function drift(price: string, confirmation: string): string {
  return new Decimal(price).div(new Decimal(confirmation)).minus(1).toString();
}

function readNormalizedTrades(
  database: SqliteDatabase,
  identity: Pick<NormalizedTrade, 'chain' | 'poolAddress' | 'tokenAddress'>,
  windowStart: number,
  windowEnd: number,
): NormalizedTrade[] {
  const rows = database
    .prepare(
      `SELECT chain, pool_address, token_address, raw_side, target_side, token_amount, quote_amount,
              price_usd, event_at, observed_at, tx_hash, provider_trade_id, log_index, leg_index,
              item_index, identity_key, dedup_status, ambiguity_status
       FROM trades
       WHERE chain = ? AND pool_address = ? AND token_address = ?
         AND event_at >= ? AND event_at < ? AND observed_at <= ?
       ORDER BY event_at ASC, observed_at ASC, id ASC`,
    )
    .all(
      identity.chain,
      identity.poolAddress,
      identity.tokenAddress,
      windowStart,
      windowEnd,
      windowEnd,
    ) as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    if (
      (row.raw_side !== 'buy' && row.raw_side !== 'sell') ||
      (row.target_side !== 'buy' && row.target_side !== 'sell') ||
      (row.dedup_status !== 'unique' && row.dedup_status !== 'duplicate') ||
      (row.ambiguity_status !== 'none' && row.ambiguity_status !== 'ambiguous') ||
      typeof row.token_amount !== 'string' ||
      typeof row.quote_amount !== 'string' ||
      typeof row.price_usd !== 'string' ||
      !Number.isSafeInteger(row.event_at) ||
      !Number.isSafeInteger(row.observed_at) ||
      !Number.isSafeInteger(row.item_index)
    )
      return [];
    const fingerprint = [
      row.chain,
      row.pool_address,
      row.raw_side,
      row.event_at,
      row.token_amount,
      row.quote_amount,
      row.item_index,
    ].join('|');
    return [
      {
        chain: row.chain as 'sol' | 'bsc',
        poolAddress: String(row.pool_address),
        tokenAddress: String(row.token_address),
        rawSide: row.raw_side,
        targetSide: row.target_side,
        tokenAmount: row.token_amount,
        quoteAmount: row.quote_amount,
        priceUsd: row.price_usd,
        eventAt: row.event_at,
        observedAt: row.observed_at,
        ...(typeof row.provider_trade_id === 'string'
          ? { providerTradeId: row.provider_trade_id }
          : {}),
        ...(typeof row.tx_hash === 'string' ? { txHash: row.tx_hash } : {}),
        ...(Number.isSafeInteger(row.log_index) ? { logIndex: row.log_index } : {}),
        ...(Number.isSafeInteger(row.leg_index) ? { legIndex: row.leg_index } : {}),
        itemIndex: row.item_index,
        ...(typeof row.identity_key === 'string' ? { identityKey: row.identity_key } : {}),
        dedupStatus: row.dedup_status,
        ambiguityStatus: row.ambiguity_status,
        fingerprint,
      } as NormalizedTrade,
    ];
  });
}

function dedupePools(
  rows: Array<{ chain: 'sol' | 'bsc'; token_address: string; pool_address: string }>,
): Array<{ chain: 'sol' | 'bsc'; token_address: string; pool_address: string }> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.chain}:${row.chain === 'bsc' ? row.pool_address.toLowerCase() : row.pool_address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findPoolAttributes(
  response: Record<string, unknown>,
  network: 'solana' | 'bsc',
  address: string,
): Record<string, unknown> {
  const item = (Array.isArray(response.data) ? response.data : [])
    .map((value) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {}))
    .find((value) => {
      const attributes = value.attributes;
      if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return false;
      const candidate = (attributes as Record<string, unknown>).address;
      return (
        typeof candidate === 'string' &&
        (network === 'bsc'
          ? candidate.toLowerCase() === address.toLowerCase()
          : candidate === address)
      );
    });
  const attributes = item?.attributes;
  return attributes && typeof attributes === 'object' && !Array.isArray(attributes)
    ? (attributes as Record<string, unknown>)
    : {};
}
