import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Decimal } from 'decimal.js';
import type { BotConfig } from '../config/schema.js';
import { insertProviderEvent } from '../persistence/provider-events.js';
import type { SqliteDatabase } from '../persistence/db.js';
import { boundedWrite, type WriteBudget } from '../persistence/write-budget.js';
import {
  assertAnalystEndpoint,
  ProviderRequestError,
  requestJson,
  type HttpClientOptions,
} from '../providers/http.js';
import { gmgnTrendingRawSchema } from '../providers/raw-schemas.js';
import {
  gmgnHotSearchesRawSchema,
  gmgnSecurityRawSchema,
  coingeckoPoolBatchRawSchema,
  coingeckoTradesRawSchema,
  coingeckoG2RawSchema,
  coingeckoOhlcv30sRawSchema,
} from '../providers/raw-schemas.js';
import {
  CandidateCycleTracker,
  unresolvedRetryAt,
  type CandidateCycle,
  type DiscoveryObservation,
} from '../pipeline/candidate.js';
import { readDiskHealth } from '../runtime/health.js';
import {
  canReuseSafetyPass,
  evaluateBscSafety,
  evaluateSolSafety,
  type SafetyResult,
} from '../domain/safety.js';
import { parsePool, selectPrimaryPool, type CanonicalPool } from '../market-data/pools.js';
import { parseDecimalString } from '../providers/parsing.js';
import {
  latestTradeAt,
  level1RawForPool,
  level1ScreeningRawForPool,
  parseCoinGeckoOhlcv30s,
  poolRawForAddress,
  poolRawsForToken,
  toCandle,
} from '../providers/coingecko-adapter.js';
import { isLevel1Fresh, parseLevel1Snapshot, type Level1Snapshot } from '../market-data/level1.js';
import {
  parseLevel1ScreeningSnapshot,
  promoteLevel1ScreeningSnapshot,
  type Level1ScreeningSnapshot,
} from '../market-data/level1-screening.js';
import {
  CoinGeckoRestScheduler,
  FinalistReservationBook,
  FreshSingleFlightCache,
  chunkCoinGeckoPools,
  finalistKey,
  g2IdentityKey,
  type CoinGeckoWork,
} from '../providers/coingecko-scheduler.js';
import { CoinGeckoG2Client, type G2ClientStatus } from '../providers/coingecko-g2.js';
import { evaluateDispatchGuard, type SignalSnapshot } from '../pipeline/ace.js';
import { evaluateCandidateAttention } from '../pipeline/candidate-attention.js';
export { evaluateCandidateAttention } from '../pipeline/candidate-attention.js';
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
  g2QueueSize: number;
  g2QueueHighWater: boolean;
  scheduler: {
    queued: number;
    running: number;
    oldestWaitMs: number;
    byKind: Record<string, number>;
    effectiveRpm: number;
    persistedDue: number;
    batchConcurrency: number;
    tradeConcurrency: number;
    creditDeferred: boolean;
    remainingCredits?: number;
    burnCreditsPerHour?: number;
    projectedExhaustionAt?: number;
    persistedOldestWaitMs: number;
    completed: number;
    failed: number;
    rejected: number;
    lastQueueWaitMs: number;
    lastRunLatencyMs: number;
  };
  lastProbeAt?: number;
  lastError?: string;
};

export type SchedulerDecisionCandidateEvidence = {
  tokenAddress: string;
  poolAddress: string;
  cycleStartedAt: number;
  dueAt?: number;
  screeningStatus?: 'complete' | 'incomplete';
};

type SchedulerDecisionInput = {
  decision: string;
  reason: string;
  priority: string;
  eventAt?: number;
  chain?: 'sol' | 'bsc';
  tokenAddress?: string;
  poolAddress?: string;
  cycleStartedAt?: number;
  workKey?: string;
  candidates?: SchedulerDecisionCandidateEvidence[];
  dedupeKey?: string;
};

export function buildSchedulerDecisionPayload(
  input: SchedulerDecisionInput,
  eventAt: number,
  configVersionId: number,
): string {
  return JSON.stringify({
    decision: input.decision,
    reason: input.reason,
    priority: input.priority,
    eventTime: eventAt,
    evidenceCutoffAt: eventAt,
    configVersionId: String(configVersionId),
    ...(input.cycleStartedAt === undefined ? {} : { cycleStartedAt: input.cycleStartedAt }),
    ...(input.workKey === undefined ? {} : { workKey: input.workKey }),
    ...(input.candidates === undefined ? {} : { candidates: input.candidates }),
  });
}

export function latestLevel1ObservedAt(poolObservedAt: number, tradeObservedAt: number): number {
  if (
    !Number.isSafeInteger(poolObservedAt) ||
    poolObservedAt < 0 ||
    !Number.isSafeInteger(tradeObservedAt) ||
    tradeObservedAt < 0
  )
    throw new Error('Invalid Level 1 evidence timestamp');
  return Math.max(poolObservedAt, tradeObservedAt);
}

export function g2ProbeState(
  clientState: G2ClientStatus | undefined,
  queueIncomplete: boolean,
): ProbeState {
  if (queueIncomplete) return 'failed';
  return clientState ?? 'ok';
}

export function outcomeEntryCoverageIsComplete(
  startEpoch: number | undefined,
  currentEpoch: number,
  clientHealthy: boolean,
  subscriptionActive: boolean,
  queueHighWater: boolean,
): boolean {
  return (
    startEpoch !== undefined &&
    startEpoch >= 0 &&
    startEpoch === currentEpoch &&
    clientHealthy &&
    subscriptionActive &&
    !queueHighWater
  );
}

export function level1ProbeState(scheduledBatches: number, failedBatches: number): ProbeState {
  if (
    !Number.isSafeInteger(scheduledBatches) ||
    scheduledBatches < 0 ||
    !Number.isSafeInteger(failedBatches) ||
    failedBatches < 0 ||
    failedBatches > scheduledBatches
  )
    throw new Error('Invalid Level 1 batch counts');
  if (scheduledBatches === 0) return 'unknown';
  return failedBatches < scheduledBatches ? 'ok' : 'failed';
}

export function nextLevel1ProbeState(
  current: ProbeState,
  scheduledBatches: number,
  failedBatches: number,
): ProbeState {
  return scheduledBatches === 0 ? current : level1ProbeState(scheduledBatches, failedBatches);
}

export function level1WorkDueAt(
  row: Pick<Level1CandidateRow, 'chain' | 'updated_at'>,
  workKind: 'candidate_batch' | 'armed_batch' | 'recheck',
  refreshSeconds: { recheck: number; active: Record<'sol' | 'bsc', number> },
): number {
  const delaySeconds =
    workKind === 'candidate_batch'
      ? 0
      : workKind === 'armed_batch'
        ? refreshSeconds.active[row.chain]
        : refreshSeconds.recheck;
  return row.updated_at + delaySeconds * 1000;
}

export function level1FunnelAfterBatch(
  status: string,
  funnelStatus: string,
  screened: boolean,
): string {
  return screened && !['armed', 'confirmed-pending-anchor', 'delivered'].includes(status)
    ? 'level1_screened'
    : funnelStatus;
}

export function sameChainAddress(chain: 'sol' | 'bsc', left: string, right: string): boolean {
  return chain === 'bsc' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function isConfirmationWindowUsable(now: number, windowEnd: number): boolean {
  return (
    Number.isSafeInteger(now) &&
    Number.isSafeInteger(windowEnd) &&
    windowEnd <= now &&
    now - windowEnd <= 30_000
  );
}

export function shouldRefreshConfirmationEvidence(reasons: readonly string[]): boolean {
  const unique = [...new Set(reasons)];
  const refreshable = new Set([
    'safety:not_fresh_or_config_mismatch',
    'level1:stale',
    'pool:unstable',
  ]);
  const hasRefreshableGap = unique.some((reason) => refreshable.has(reason));
  if (!hasRefreshableGap) return false;
  return unique.every((reason) => refreshable.has(reason) || reason === 'conviction:incomplete');
}

export async function refreshConfirmationEvidence(input: {
  now: () => number;
  configVersionId: string;
  refreshSafety: () => Promise<SafetyResult>;
  refreshLevel1: () => Promise<Level1Snapshot | undefined>;
}): Promise<
  | { status: 'complete'; safety: SafetyResult; level1: Level1Snapshot }
  | { status: 'blocked'; reason: string; safety: SafetyResult }
> {
  const safety = await input.refreshSafety();
  if (!canReuseSafetyPass(safety, input.now(), input.configVersionId))
    return { status: 'blocked', reason: `safety:${safety.status}`, safety };
  const level1 = await input.refreshLevel1();
  if (!level1) return { status: 'blocked', reason: 'level1:incomplete', safety };
  return { status: 'complete', safety, level1 };
}

export function shouldRearmG2Candidate(status: string, funnelStatus: string): boolean {
  return (
    status !== 'expired' &&
    (status === 'armed' ||
      status === 'confirmed-pending-anchor' ||
      funnelStatus === 'level1_screened' ||
      funnelStatus === 'level1_checked')
  );
}

export function canArmG2Candidate(
  status: string,
  funnelStatus: string,
  attentionStatus: 'pass' | 'rejected' | 'incomplete',
): boolean {
  if (!shouldRearmG2Candidate(status, funnelStatus)) return false;
  return attentionStatus === 'pass' || status === 'armed' || funnelStatus === 'armed';
}

export function armedSubscriptionsToRelease(
  active: ReadonlyMap<string, 'armed' | 'confirmed-pending-anchor'>,
  desiredArmed: ReadonlySet<string>,
): string[] {
  return [...active]
    .filter(([identityKey, state]) => state === 'armed' && !desiredArmed.has(identityKey))
    .map(([identityKey]) => identityKey)
    .sort();
}

export function g2OccupiedIdentities(
  active: ReadonlyMap<string, 'armed' | 'confirmed-pending-anchor'>,
  desiredArmed: ReadonlySet<string>,
): Set<string> {
  const occupied = new Set(desiredArmed);
  for (const [identityKey, state] of active)
    if (state === 'confirmed-pending-anchor') occupied.add(identityKey);
  return occupied;
}

export function candidateRediscoveryState(input: {
  status: string;
  funnelStatus: string;
  previousConfigVersionId: number;
  currentConfigVersionId: number;
}): { preserveHistorical: boolean; status: string; funnelStatus: string } {
  if (['confirmed-pending-anchor', 'delivered', 'completed'].includes(input.status))
    return {
      preserveHistorical: true,
      status: input.status,
      funnelStatus: input.funnelStatus,
    };
  if (input.previousConfigVersionId !== input.currentConfigVersionId)
    return { preserveHistorical: false, status: 'scouting', funnelStatus: 'safety_checked' };
  return {
    preserveHistorical: false,
    status: input.status,
    funnelStatus: input.funnelStatus === 'armed' ? 'armed' : 'safety_checked',
  };
}

export function planExistingG2Capacity<T extends { row: { status: string; chain: 'sol' | 'bsc' } }>(
  rows: T[],
  capacity: number,
): { retained: T[]; demoted: T[]; overflowed: boolean } {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error('Invalid G2 capacity');
  const retained = rows
    .filter(({ row }) => row.status === 'confirmed-pending-anchor')
    .slice(0, capacity);
  const chainLimit = Math.max(1, Math.floor(capacity / 2));
  const chainCounts = { sol: 0, bsc: 0 };
  for (const { row } of retained) chainCounts[row.chain] += 1;
  for (const item of rows) {
    if (retained.length >= capacity) break;
    if (item.row.status !== 'armed' || chainCounts[item.row.chain] >= chainLimit) continue;
    retained.push(item);
    chainCounts[item.row.chain] += 1;
  }
  const retainedSet = new Set(retained);
  const demoted = rows.filter((item) => item.row.status === 'armed' && !retainedSet.has(item));
  return {
    retained,
    demoted,
    overflowed: rows.length > retained.length,
  };
}

type Level1CandidateRow = {
  id: number;
  chain: 'sol' | 'bsc';
  token_address: string;
  pool_address: string;
  cycle_started_at: number;
  status: string;
  funnel_status: string;
  updated_at: number;
};

export function selectLevel1CandidateRows(
  database: SqliteDatabase,
  limitPerChain: number,
  configVersionId: number,
  now: number,
  ttlSeconds: Record<'sol' | 'bsc', number>,
  refreshSeconds: {
    recheck: number;
    active: Record<'sol' | 'bsc', number>;
  },
): Level1CandidateRow[] {
  if (
    !Number.isSafeInteger(limitPerChain) ||
    limitPerChain <= 0 ||
    !Number.isSafeInteger(configVersionId) ||
    configVersionId <= 0 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(ttlSeconds.sol) ||
    ttlSeconds.sol <= 0 ||
    !Number.isSafeInteger(ttlSeconds.bsc) ||
    ttlSeconds.bsc <= 0 ||
    !Number.isSafeInteger(refreshSeconds.recheck) ||
    refreshSeconds.recheck <= 0 ||
    !Number.isSafeInteger(refreshSeconds.active.sol) ||
    refreshSeconds.active.sol <= 0 ||
    !Number.isSafeInteger(refreshSeconds.active.bsc) ||
    refreshSeconds.active.bsc <= 0
  )
    throw new Error('Invalid Level 1 candidate limit');
  return database
    .prepare(
      `WITH current_cycles AS (
         SELECT id, chain, token_address, pool_address, cycle_started_at, status, funnel_status, updated_at,
                ROW_NUMBER() OVER (
                  PARTITION BY chain, token_address
                  ORDER BY cycle_started_at DESC, id DESC
                ) AS cycle_rank
         FROM candidates
         WHERE config_version_id = ? AND safety_status = 'pass'
           AND status NOT IN ('expired', 'delivered', 'completed')
           AND pool_address IS NOT NULL
           AND (status IN ('armed', 'confirmed-pending-anchor')
                OR CAST(json_extract(safety_json, '$.expiresAt') AS INTEGER) > ?)
           AND (status IN ('armed', 'confirmed-pending-anchor')
                OR last_seen_at >= CASE chain WHEN 'sol' THEN ? ELSE ? END)
           AND (
             (status IN ('armed', 'confirmed-pending-anchor')
              AND updated_at <= CASE chain WHEN 'sol' THEN ? ELSE ? END)
             OR
             (status NOT IN ('armed', 'confirmed-pending-anchor')
              AND (
                funnel_status NOT IN ('level1_screened', 'level1_checked')
                OR updated_at <= ?
              ))
           )
       ), ranked AS (
         SELECT id, chain, token_address, pool_address, cycle_started_at, status, funnel_status, updated_at,
                ROW_NUMBER() OVER (
                  PARTITION BY chain
                  ORDER BY
                    CASE WHEN status IN ('armed', 'confirmed-pending-anchor')
                         THEN 0
                         WHEN funnel_status NOT IN ('level1_screened', 'level1_checked')
                         THEN 1 ELSE 2 END ASC,
                    updated_at ASC, pool_address ASC, token_address ASC
                ) AS chain_rank
         FROM current_cycles WHERE cycle_rank = 1
       )
       SELECT id, chain, token_address, pool_address, cycle_started_at, status, funnel_status, updated_at
       FROM ranked WHERE chain_rank <= ?
       ORDER BY chain ASC, chain_rank ASC`,
    )
    .all(
      configVersionId,
      now,
      now - ttlSeconds.sol * 1000,
      now - ttlSeconds.bsc * 1000,
      now - refreshSeconds.active.sol * 1000,
      now - refreshSeconds.active.bsc * 1000,
      now - refreshSeconds.recheck * 1000,
      limitPerChain,
    ) as Level1CandidateRow[];
}

export function readLevel1Backlog(
  database: SqliteDatabase,
  configVersionId: number,
  now: number,
  ttlSeconds: Record<'sol' | 'bsc', number>,
  refreshSeconds: { recheck: number; active: Record<'sol' | 'bsc', number> },
): { count: number; oldestAt: number | null } {
  const row = database
    .prepare(
      `WITH eligible AS (
         SELECT CASE
                  WHEN status IN ('armed', 'confirmed-pending-anchor')
                    THEN updated_at + CASE chain WHEN 'sol' THEN ? ELSE ? END
                  WHEN funnel_status NOT IN ('level1_screened', 'level1_checked')
                    THEN updated_at
                  ELSE updated_at + ?
                END AS due_at
         FROM candidates
         WHERE config_version_id = ? AND safety_status = 'pass'
           AND status NOT IN ('expired', 'delivered', 'completed')
           AND pool_address IS NOT NULL
           AND (status IN ('armed', 'confirmed-pending-anchor')
                OR CAST(json_extract(safety_json, '$.expiresAt') AS INTEGER) > ?)
           AND (status IN ('armed', 'confirmed-pending-anchor')
                OR last_seen_at >= CASE chain WHEN 'sol' THEN ? ELSE ? END)
       )
       SELECT COUNT(*) AS count, MIN(due_at) AS oldest_at FROM eligible WHERE due_at <= ?`,
    )
    .get(
      refreshSeconds.active.sol * 1000,
      refreshSeconds.active.bsc * 1000,
      refreshSeconds.recheck * 1000,
      configVersionId,
      now,
      now - ttlSeconds.sol * 1000,
      now - ttlSeconds.bsc * 1000,
      now,
    ) as { count: number; oldest_at: number | null };
  return { count: Number(row.count), oldestAt: row.oldest_at };
}

type ArmCandidateRow = {
  id: number;
  chain: 'sol' | 'bsc';
  token_address: string;
  pool_address: string;
  status: string;
  funnel_status: string;
  cycle_started_at: number;
  updated_at: number;
};

type PoolResolutionCandidateRow = {
  id: number;
  chain: 'sol' | 'bsc';
  token_address: string;
  pool_retry_attempt: number;
};

export function selectPoolResolutionRows(
  database: SqliteDatabase,
  chain: 'sol' | 'bsc',
  now: number,
  ttlSeconds: number,
  limit: number,
  configVersionId: number,
): PoolResolutionCandidateRow[] {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    !Number.isSafeInteger(configVersionId) ||
    configVersionId <= 0
  )
    throw new Error('Invalid pool resolution selection input');
  return database
    .prepare(
      `WITH current_cycles AS (
         SELECT id, chain, token_address, pool_retry_attempt, pool_retry_at, updated_at,
                ROW_NUMBER() OVER (
                  PARTITION BY chain, token_address
                  ORDER BY cycle_started_at DESC, id DESC
                ) AS cycle_rank
         FROM candidates
         WHERE chain = ? AND config_version_id = ?
           AND safety_status = 'pass' AND status != 'expired'
           AND CAST(json_extract(safety_json, '$.expiresAt') AS INTEGER) > ?
           AND last_seen_at >= ? AND pool_address IS NULL
           AND (pool_retry_at IS NULL OR pool_retry_at <= ?)
       )
       SELECT id, chain, token_address, pool_retry_attempt
       FROM current_cycles WHERE cycle_rank = 1
       ORDER BY updated_at ASC, id ASC LIMIT ?`,
    )
    .all(
      chain,
      configVersionId,
      now,
      now - ttlSeconds * 1000,
      now,
      limit,
    ) as PoolResolutionCandidateRow[];
}

export function selectArmCandidateRows(
  database: SqliteDatabase,
  limit: number,
  configVersionId: number,
  now: number,
  ttlSeconds: Record<'sol' | 'bsc', number>,
): ArmCandidateRow[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    !Number.isSafeInteger(configVersionId) ||
    configVersionId <= 0 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error('Invalid G2 candidate limit');
  return database
    .prepare(
      `WITH current_cycles AS (
         SELECT id, chain, token_address, pool_address, cycle_started_at, status, funnel_status, updated_at,
                ROW_NUMBER() OVER (
                  PARTITION BY chain, token_address
                  ORDER BY cycle_started_at DESC, id DESC
                ) AS cycle_rank
         FROM candidates
         WHERE config_version_id = ? AND safety_status = 'pass'
           AND status NOT IN ('expired', 'delivered', 'completed')
           AND pool_address IS NOT NULL
           AND (status IN ('armed', 'confirmed-pending-anchor')
                OR CAST(json_extract(safety_json, '$.expiresAt') AS INTEGER) > ?)
           AND (status IN ('armed', 'confirmed-pending-anchor')
                OR last_seen_at >= CASE chain WHEN 'sol' THEN ? ELSE ? END)
           AND (funnel_status IN ('level1_screened', 'level1_checked', 'armed', 'confirmed-pending-anchor')
                OR status IN ('armed', 'confirmed-pending-anchor'))
       ), ranked AS (
         SELECT id, chain, token_address, pool_address, cycle_started_at, status, funnel_status, updated_at,
                ROW_NUMBER() OVER (
                  PARTITION BY chain
                  ORDER BY CASE WHEN status IN ('armed', 'confirmed-pending-anchor')
                                THEN 1 ELSE 0 END DESC,
                           updated_at DESC, pool_address ASC, token_address ASC
                ) AS chain_rank
         FROM current_cycles WHERE cycle_rank = 1
       )
       SELECT id, chain, token_address, pool_address, status, funnel_status, cycle_started_at, updated_at
       FROM ranked
       ORDER BY chain_rank ASC, chain ASC
       LIMIT ?`,
    )
    .all(
      configVersionId,
      now,
      now - ttlSeconds.sol * 1000,
      now - ttlSeconds.bsc * 1000,
      limit,
    ) as ArmCandidateRow[];
}

type ExpiredCandidateIdentity = {
  chain: 'sol' | 'bsc';
  tokenAddress: string;
  poolAddress?: string;
};

export function expireStaleCandidateRows(
  database: SqliteDatabase,
  chain: 'sol' | 'bsc',
  now: number,
  ttlSeconds: number,
  budget: WriteBudget,
): ExpiredCandidateIdentity[] {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0)
    throw new Error('Invalid candidate expiration input');
  const cutoff = now - ttlSeconds * 1000;
  const rows = database
    .prepare(
      `SELECT id, token_address, pool_address
       FROM candidates
       WHERE chain = ? AND last_seen_at < ?
         AND status IN ('scouting', 'safety_pending', 'qualified', 'armed', 'rejected', 'incomplete')
       ORDER BY last_seen_at ASC, id ASC LIMIT ?`,
    )
    .all(chain, cutoff, budget.maxRows) as Array<{
    id: number;
    token_address: string;
    pool_address: string | null;
  }>;
  if (rows.length === 0) return [];
  boundedWrite(database, budget, (context) => {
    const update = database.prepare(
      `UPDATE candidates SET status = 'expired', close_reason = 'discovery_ttl',
       updated_at = ? WHERE id = ?`,
    );
    for (const row of rows) context.addRows(update.run(now, row.id).changes);
  });
  return rows.map((row) => ({
    chain,
    tokenAddress: row.token_address,
    ...(row.pool_address === null ? {} : { poolAddress: row.pool_address }),
  }));
}

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
  private readonly level1ScreeningSnapshots = new Map<string, Level1ScreeningSnapshot>();
  private readonly level1Pools = new Map<string, CanonicalPool>();
  private readonly coinGeckoScheduler: CoinGeckoRestScheduler;
  private readonly level1BatchCache = new FreshSingleFlightCache<{
    parsed: Record<string, unknown>;
    observedAt: number;
  }>();
  private readonly finalistReservations: FinalistReservationBook;
  private readonly finalistWaitingSince = new Map<string, number>();
  private readonly g2Queue: G2IngestQueue<PendingG2>;
  private readonly g2Deduper = new TradeDeduper();
  private g2Client: CoinGeckoG2Client | undefined;
  private g2DrainScheduled = false;
  private g2DrainInFlight: Promise<void> | undefined;
  private g2QueueIncomplete = false;
  private g2IntegrityEpoch = 0;
  private readonly outcomeG2StartEpoch = new Map<number, number>();
  private readonly signalCheckTimers = new Map<string, NodeJS.Timeout>();
  private readonly signalBlockLogKeys = new Set<string>();
  private readonly confirmationRefreshAttempted = new Set<string>();
  private readonly schedulerDecisionKeys = new Set<string>();
  private readonly confirmationRefreshes = new Set<Promise<void>>();
  private readonly outcomePollAt = new Map<string, number>();
  private gmgnRequestTail: Promise<void> = Promise.resolve();
  private lastGmgnRequestAt = 0;
  private telegram: ProbeState = 'unknown';
  private lastProbeAt: number | undefined;
  private lastError: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private coinGeckoTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private coinGeckoInFlight: Promise<void> | undefined;
  private lastCoinGeckoKeyAt: number | undefined;
  private lastCoinGeckoKeyAttemptAt: number | undefined;
  private stopping = false;
  private statusChangeListener: (() => void) | undefined;
  private readonly trackers: Record<'sol' | 'bsc', CandidateCycleTracker>;

  public constructor(private readonly options: ProviderProbeOptions) {
    this.coinGeckoScheduler = new CoinGeckoRestScheduler(options.config.providers.coingecko);
    this.finalistReservations = new FinalistReservationBook(
      options.config.providers.coingecko.g2.max_subscriptions_per_socket,
    );
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
          this.g2IntegrityEpoch += 1;
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
    this.coinGeckoTimer = setInterval(
      () => this.startCoinGeckoProbe(),
      this.options.config.providers.coingecko.scheduler.scan_interval_seconds * 1000,
    );
    void this.runOnce();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.coinGeckoTimer) clearInterval(this.coinGeckoTimer);
    this.coinGeckoTimer = undefined;
    for (const timer of this.signalCheckTimers.values()) clearTimeout(timer);
    this.signalCheckTimers.clear();
    this.outcomePollAt.clear();
    this.outcomeG2StartEpoch.clear();
    await this.inFlight;
    await this.coinGeckoScheduler.stop();
    await this.coinGeckoInFlight;
    await this.g2DrainInFlight;
    this.finalistReservations.clearReservations();
    this.finalistWaitingSince.clear();
    await this.g2Client?.stop();
    await Promise.allSettled([...this.confirmationRefreshes]);
  }

  public status(): ProviderProbeStatus {
    const providerStates = [this.gmgn, this.coingecko];
    const scheduler = this.coinGeckoScheduler.stats();
    const now = Date.now();
    const persisted = readLevel1Backlog(
      this.options.database,
      this.options.configVersionId,
      now,
      {
        sol: this.options.config.chains.sol.discovery.candidate_ttl_seconds,
        bsc: this.options.config.chains.bsc.discovery.candidate_ttl_seconds,
      },
      {
        recheck: this.options.config.providers.coingecko.scheduler.dynamic_recheck_seconds,
        active: {
          sol: this.options.config.chains.sol.level1.refresh_interval_seconds,
          bsc: this.options.config.chains.bsc.level1.refresh_interval_seconds,
        },
      },
    );
    const persistedDue = persisted.count;
    return {
      provider: providerStates.every((state) => state === 'ok')
        ? 'ok'
        : providerStates.includes('failed')
          ? 'failed'
          : 'unknown',
      safety: this.safety,
      level1: this.level1,
      g2: g2ProbeState(this.g2Client?.status(), this.g2QueueIncomplete),
      telegram: this.telegram,
      g2QueueSize: this.g2Queue.size(),
      g2QueueHighWater: this.g2Queue.atHighWatermark(),
      scheduler: {
        queued: scheduler.queued,
        running: scheduler.running,
        oldestWaitMs: scheduler.oldestWaitMs,
        byKind: scheduler.byKind,
        effectiveRpm: scheduler.effectiveRpm,
        persistedDue,
        persistedOldestWaitMs:
          persisted.oldestAt === null ? 0 : Math.max(0, now - persisted.oldestAt),
        batchConcurrency: scheduler.batchConcurrency,
        tradeConcurrency: scheduler.tradeConcurrency,
        creditDeferred: scheduler.creditDeferred,
        ...(scheduler.remainingCredits === undefined
          ? {}
          : { remainingCredits: scheduler.remainingCredits }),
        ...(scheduler.burnCreditsPerHour === undefined
          ? {}
          : { burnCreditsPerHour: scheduler.burnCreditsPerHour }),
        ...(scheduler.projectedExhaustionAt === undefined
          ? {}
          : { projectedExhaustionAt: scheduler.projectedExhaustionAt }),
        completed: scheduler.completed,
        failed: scheduler.failed,
        rejected: scheduler.rejected,
        lastQueueWaitMs: scheduler.lastQueueWaitMs,
        lastRunLatencyMs: scheduler.lastRunLatencyMs,
      },
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
      .then((results) => {
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => this.safeError(result.reason));
        this.startCoinGeckoProbe();
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

  private startCoinGeckoProbe(): void {
    if (this.stopping || this.coinGeckoInFlight) return;
    this.coinGeckoInFlight = this.probeCoinGecko()
      .catch((error: unknown) => {
        this.lastError = this.safeError(error);
        this.options.logger('warn', 'coingecko_probe_failed', { error: this.lastError });
      })
      .finally(() => {
        this.lastProbeAt = Date.now();
        this.statusChangeListener?.();
        this.coinGeckoInFlight = undefined;
      });
  }

  private async probeGmgn(): Promise<void> {
    try {
      const disk = readDiskHealth(
        path.dirname(path.resolve(this.options.config.storage.database_path)),
        this.options.config.storage.disk_high_water_percent,
      );
      if (disk.highWater) throw new Error('disk:high_water');
      for (const chain of ['sol', 'bsc'] as const) {
        const intervals = this.options.config.chains[chain].discovery.trending_intervals;
        for (const interval of intervals) {
          const raw = await this.requestGmgn([
            'market',
            'trending',
            '--chain',
            chain,
            '--interval',
            interval,
            '--limit',
            String(this.options.config.chains[chain].discovery.max_candidates),
          ]);
          const observedAt = Date.now();
          const parsed = gmgnTrendingRawSchema.parse(JSON.parse(raw));
          const event = this.recordGmgnEvent(raw, `market.trending.${interval}`, chain, observedAt);
          this.ingestTrending(chain, interval, parsed.data.rank, observedAt, event.id);
          await delay(this.options.config.providers.gmgn.rate_limit.minimum_interval_ms);
        }

        const raw = await this.requestGmgn([
          'market',
          'hot-searches',
          '--chain',
          chain,
          '--interval',
          this.options.config.chains[chain].discovery.hot_search_interval,
          '--limit',
          String(this.options.config.chains[chain].discovery.max_candidates),
        ]);
        const observedAt = Date.now();
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

  private requestGmgn(args: string[]): Promise<string> {
    const execute = async () => {
      const key = this.options.secrets[this.options.config.providers.gmgn.api_key_env];
      if (!key) throw new Error('GMGN secret is not configured');
      const minimumInterval = this.options.config.providers.gmgn.rate_limit.minimum_interval_ms;
      const remaining = minimumInterval - (Date.now() - this.lastGmgnRequestAt);
      if (remaining > 0) await delay(remaining);
      try {
        return await runGmgn(args, key, this.options.config.providers.gmgn.request_timeout_ms);
      } finally {
        this.lastGmgnRequestAt = Date.now();
      }
    };
    const request = this.gmgnRequestTail.then(execute, execute);
    this.gmgnRequestTail = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
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
      const persisted = this.options.database
        .prepare(
          `SELECT cycle_started_at, first_seen_at, last_seen_at, status
           FROM candidates
           WHERE chain = ? AND token_address = ? AND status != 'expired'
             AND last_seen_at >= ?
           ORDER BY cycle_started_at DESC LIMIT 1`,
        )
        .get(
          observation.chain,
          observation.tokenAddress,
          observation.observedAt -
            this.options.config.chains[observation.chain].discovery.candidate_ttl_seconds * 1000,
        ) as
        | {
            cycle_started_at: number;
            first_seen_at: number;
            last_seen_at: number;
            status: CandidateCycle['status'];
          }
        | undefined;
      if (persisted)
        this.trackers[observation.chain].restore({
          chain: observation.chain,
          tokenAddress: observation.tokenAddress,
          cycleStartedAt: persisted.cycle_started_at,
          firstSeenAt: persisted.first_seen_at,
          lastSeenAt: persisted.last_seen_at,
          status: persisted.status,
        });
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
          `SELECT id, status, funnel_status, config_version_id FROM candidates
           WHERE chain = ? AND token_address = ? AND cycle_started_at = ?`,
        )
        .get(cycle.chain, cycle.tokenAddress, cycle.cycleStartedAt) as
        | { id: number; status: string; funnel_status: string; config_version_id: number }
        | undefined;
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
          const rediscovery = candidateRediscoveryState({
            status: existing.status,
            funnelStatus: existing.funnel_status,
            previousConfigVersionId: existing.config_version_id,
            currentConfigVersionId: this.options.configVersionId,
          });
          if (rediscovery.preserveHistorical) {
            const info = this.options.database
              .prepare('UPDATE candidates SET last_seen_at = ? WHERE id = ?')
              .run(cycle.lastSeenAt, existing.id);
            context.addRows(info.changes);
          } else {
            const info = this.options.database
              .prepare(
                `UPDATE candidates SET last_seen_at = ?,
                 status = ?,
                 safety_status = ?, safety_json = ?, config_version_id = ?,
                 funnel_status = ?,
                 updated_at = ? WHERE id = ?`,
              )
              .run(
                cycle.lastSeenAt,
                rediscovery.status,
                safety.status,
                JSON.stringify(safety),
                this.options.configVersionId,
                rediscovery.funnelStatus,
                Date.now(),
                existing.id,
              );
            context.addRows(info.changes);
          }
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
    const expired = expireStaleCandidateRows(
      this.options.database,
      chain,
      now,
      this.options.config.chains[chain].discovery.candidate_ttl_seconds,
      this.options.writeBudget,
    );
    for (const identity of expired) this.releaseG2IfUnused(identity);
  }

  private closeCandidate(cycle: {
    chain: 'sol' | 'bsc';
    tokenAddress: string;
    cycleStartedAt: number;
  }): void {
    const row = this.options.database
      .prepare(
        `SELECT pool_address FROM candidates
         WHERE chain = ? AND token_address = ? AND cycle_started_at = ?`,
      )
      .get(cycle.chain, cycle.tokenAddress, cycle.cycleStartedAt) as
      { pool_address: string | null } | undefined;
    boundedWrite(this.options.database, this.options.writeBudget, (context) => {
      const info = this.options.database
        .prepare(
          `UPDATE candidates SET status = 'expired', close_reason = 'discovery_ttl', updated_at = ?
           WHERE chain = ? AND token_address = ? AND cycle_started_at = ?
             AND status IN ('scouting', 'safety_pending', 'qualified', 'armed', 'rejected', 'incomplete')`,
        )
        .run(Date.now(), cycle.chain, cycle.tokenAddress, cycle.cycleStartedAt);
      context.addRows(info.changes);
    });
    if (row?.pool_address)
      this.releaseG2IfUnused({
        chain: cycle.chain,
        tokenAddress: cycle.tokenAddress,
        poolAddress: row.pool_address,
      });
  }

  private releaseG2IfUnused(identity: ExpiredCandidateIdentity): void {
    if (!identity.poolAddress) return;
    const remaining = this.options.database
      .prepare(
        `SELECT 1 FROM candidates
         WHERE chain = ? AND token_address = ? AND pool_address = ? AND status != 'expired'
         LIMIT 1`,
      )
      .get(identity.chain, identity.tokenAddress, identity.poolAddress);
    if (remaining) return;
    this.g2Client?.unset(`${identity.chain}:${identity.poolAddress}:${identity.tokenAddress}`);
  }

  private async scheduleCoinGeckoRequest<T>(work: CoinGeckoWork<T>): Promise<T> {
    return this.coinGeckoScheduler.enqueue({
      ...work,
      run: async (signal) => {
        try {
          return await work.run(signal);
        } catch (error) {
          if (error instanceof ProviderRequestError && error.diagnostic.status === 429) {
            this.coinGeckoScheduler.recordRateLimit(error.diagnostic.retryAfterMs);
            try {
              this.recordSchedulerDecision({
                decision: 'rate_limited',
                reason: 'provider_429',
                priority: work.kind,
                ...(work.chain === undefined ? {} : { chain: work.chain }),
                workKey: work.key,
              });
            } catch (recordError) {
              this.options.logger('warn', 'scheduler_decision_persist_failed', {
                decision: 'rate_limited',
                error: this.safeError(recordError),
              });
            }
          }
          throw error;
        }
      },
    });
  }

  private recordSchedulerDecision(input: SchedulerDecisionInput): void {
    if (input.dedupeKey) {
      if (this.schedulerDecisionKeys.has(input.dedupeKey)) return;
      if (this.schedulerDecisionKeys.size >= 20_000) this.schedulerDecisionKeys.clear();
      this.schedulerDecisionKeys.add(input.dedupeKey);
    }
    const observedAt = Date.now();
    const eventAt = input.eventAt ?? observedAt;
    const payload = buildSchedulerDecisionPayload(input, eventAt, this.options.configVersionId);
    insertProviderEvent(
      this.options.database,
      {
        provider: 'runtime',
        capability: 'scheduler.decision',
        ...(input.chain === undefined ? {} : { chain: input.chain }),
        ...(input.tokenAddress === undefined ? {} : { tokenAddress: input.tokenAddress }),
        ...(input.poolAddress === undefined ? {} : { poolAddress: input.poolAddress }),
        eventAt,
        observedAt,
        schemaVersion: 'runtime.scheduler.decision.v1',
        payload,
      },
      this.options.writeBudget,
    );
  }

  private async probeCoinGecko(): Promise<void> {
    const key = this.options.secrets[this.options.config.providers.coingecko.api_key_env];
    if (!key) throw new Error('CoinGecko secret is not configured');
    const options = httpOptions(this.options.config, 'coingecko', 'key');
    try {
      const now = Date.now();
      if (
        this.lastCoinGeckoKeyAttemptAt === undefined ||
        now - this.lastCoinGeckoKeyAttemptAt >=
          this.options.config.providers.coingecko.scheduler.key_refresh_seconds * 1000
      ) {
        this.lastCoinGeckoKeyAttemptAt = now;
        try {
          const result = await this.scheduleCoinGeckoRequest({
            key: 'key.account',
            kind: 'confirmation',
            requestType: 'batch',
            createdAt: now,
            run: (signal) =>
              requestJson<Record<string, unknown>>(
                `${this.options.config.providers.coingecko.rest_base_url}/key`,
                { headers: { 'x-cg-pro-api-key': key }, signal },
                options,
              ),
          });
          const observedAt = Date.now();
          const payload = JSON.stringify(result.data);
          const providerRpm = result.data.api_key_rate_limit_request_per_minute;
          if (
            typeof providerRpm === 'number' &&
            Number.isSafeInteger(providerRpm) &&
            providerRpm > 0
          )
            this.coinGeckoScheduler.setProviderRpm(providerRpm);
          const providerMonthlyCredits = result.data.api_key_monthly_call_credit;
          const providerCreditsUsed = result.data.api_key_current_total_monthly_calls;
          if (
            typeof providerMonthlyCredits === 'number' &&
            typeof providerCreditsUsed === 'number' &&
            Number.isSafeInteger(providerMonthlyCredits) &&
            Number.isSafeInteger(providerCreditsUsed)
          )
            this.coinGeckoScheduler.setProviderCreditState(
              providerMonthlyCredits,
              providerCreditsUsed,
              observedAt,
            );
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
          this.lastCoinGeckoKeyAt = observedAt;
        } catch (error) {
          this.options.logger('warn', 'coingecko_key_refresh_failed', {
            error: this.safeError(error),
            last_success_at: this.lastCoinGeckoKeyAt,
          });
        }
      }
      await delay(this.options.config.providers.coingecko.scheduler.merge_delay_ms);
      const resolutionErrors = await this.resolveCoinGeckoPools(key);
      const outcomes = this.processOutcomes(key).then(
        () => ({ status: 'fulfilled' as const }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      let pipelineError: unknown;
      try {
        await this.refreshLevel1(key);
        await this.armEligibleCandidates(key);
      } catch (error) {
        pipelineError = error;
      }
      const outcomeResult = await outcomes;
      if (pipelineError) throw pipelineError;
      if (outcomeResult.status === 'rejected') throw outcomeResult.reason;
      const hardResolutionError = resolutionErrors.find(
        (error) => !this.safeError(error).startsWith('scheduler:'),
      );
      if (hardResolutionError) throw hardResolutionError;
      this.coingecko = 'ok';
    } catch (error) {
      this.coingecko = 'failed';
      throw error;
    }
  }

  private async refreshLevel1(key: string): Promise<void> {
    const rows = selectLevel1CandidateRows(
      this.options.database,
      this.options.config.providers.coingecko.scheduler.max_due_pools_per_chain,
      this.options.configVersionId,
      Date.now(),
      {
        sol: this.options.config.chains.sol.discovery.candidate_ttl_seconds,
        bsc: this.options.config.chains.bsc.discovery.candidate_ttl_seconds,
      },
      {
        recheck: this.options.config.providers.coingecko.scheduler.dynamic_recheck_seconds,
        active: {
          sol: this.options.config.chains.sol.level1.refresh_interval_seconds,
          bsc: this.options.config.chains.bsc.level1.refresh_interval_seconds,
        },
      },
    );
    const batchJobs: Array<{
      expected: number;
      promise: Promise<{ attempted: number; complete: number }>;
    }> = [];
    for (const chain of ['sol', 'bsc'] as const) {
      const chainRows = rows.filter((row) => row.chain === chain);
      const groups = groupLevel1RowsByWorkKind(chainRows, chain);
      for (const workKind of ['candidate_batch', 'armed_batch', 'recheck'] as const) {
        for (const candidateRows of createCandidatePoolBatches(
          groups[workKind],
          chain,
          this.options.config.providers.coingecko.max_pools_per_batch,
        )) {
          batchJobs.push({
            expected: candidateRows.length,
            promise: this.refreshLevel1Batch(key, chain, candidateRows, workKind),
          });
        }
      }
    }
    const results = await Promise.allSettled(batchJobs.map((job) => job.promise));
    const summary = summarizeLevel1BatchResults(
      batchJobs.map((job) => job.expected),
      results,
    );
    const { attempted, complete, failures, deferred } = summary;
    this.level1 = nextLevel1ProbeState(
      this.level1,
      batchJobs.length,
      Math.max(0, failures - deferred),
    );
    this.options.logger(
      this.level1 === 'ok' && failures === 0 ? 'info' : 'warn',
      'level1_probe_summary',
      {
        attempted,
        complete,
        incomplete: attempted - complete,
        batch_failures: failures,
        batch_deferred: deferred,
        scheduler: this.coinGeckoScheduler.stats(),
        status: this.level1,
      },
    );
  }

  private async refreshLevel1Batch(
    key: string,
    chain: 'sol' | 'bsc',
    poolRows: Level1CandidateRow[],
    workKind: 'candidate_batch' | 'armed_batch' | 'recheck',
  ): Promise<{ attempted: number; complete: number }> {
    const network = chain === 'sol' ? 'solana' : 'bsc';
    const addresses = [
      ...new Map(
        poolRows.map((row) => [
          chain === 'bsc' ? row.pool_address.toLowerCase() : row.pool_address,
          row.pool_address,
        ]),
      ).values(),
    ];
    const cacheKey = `${chain}:${[...addresses]
      .map((address) => (chain === 'bsc' ? address.toLowerCase() : address))
      .sort()
      .join(',')}`;
    const requestedAt = Date.now();
    const decisionCandidates = poolRows.map((row) => ({
      tokenAddress: row.token_address,
      poolAddress: row.pool_address,
      cycleStartedAt: row.cycle_started_at,
      dueAt: level1WorkDueAt(row, workKind, {
        recheck: this.options.config.providers.coingecko.scheduler.dynamic_recheck_seconds,
        active: {
          sol: this.options.config.chains.sol.level1.refresh_interval_seconds,
          bsc: this.options.config.chains.bsc.level1.refresh_interval_seconds,
        },
      }),
    }));
    let supplierRequestStarted = false;
    const { parsed, observedAt } = await this.level1BatchCache
      .getOrLoad(
        cacheKey,
        requestedAt,
        this.options.config.providers.coingecko.scheduler.cache_ttl_seconds * 1000,
        () => {
          supplierRequestStarted = true;
          return this.scheduleCoinGeckoRequest({
            key: `pools.multi:${cacheKey}`,
            kind: workKind,
            requestType: 'batch',
            chain,
            createdAt: Math.min(...poolRows.map((row) => row.updated_at)),
            run: async (signal) => {
              const url = `${this.options.config.providers.coingecko.rest_base_url}/onchain/networks/${network}/pools/multi/${addresses.map(encodeURIComponent).join(',')}?include=base_token,quote_token&include_volume_breakdown=true&include_composition=true`;
              assertAnalystEndpoint(url, this.options.config.providers.coingecko.rest_base_url);
              const result = await requestJson<Record<string, unknown>>(
                url,
                { headers: { 'x-cg-pro-api-key': key }, signal },
                httpOptions(this.options.config, 'coingecko', 'pools.multi.level1'),
              );
              const batch = coingeckoPoolBatchRawSchema.parse(result.data) as Record<
                string,
                unknown
              >;
              const at = Date.now();
              const payload = JSON.stringify(batch);
              insertProviderEvent(
                this.options.database,
                {
                  provider: 'coingecko',
                  capability: 'pools.multi.level1',
                  chain,
                  observedAt: at,
                  schemaVersion: 'coingecko.pools.multi.v1',
                  payload,
                  billingBucket: 'pool_screening',
                  requestMeta: {
                    endpoint_name: 'onchain.pools.multi',
                    method: 'GET',
                    status: result.diagnostic.status,
                    response_bytes: Buffer.byteLength(payload),
                  },
                },
                this.options.writeBudget,
              );
              return { parsed: batch, observedAt: at };
            },
          });
        },
      )
      .catch((error: unknown) => {
        this.touchLevel1CandidateRows(poolRows, Date.now());
        if (supplierRequestStarted)
          this.recordSchedulerDecision({
            decision: 'defer',
            reason: this.safeError(error),
            priority: workKind,
            chain,
            workKey: `pools.multi:${cacheKey}`,
            candidates: decisionCandidates,
          });
        throw error;
      });

    this.touchLevel1CandidateRows(poolRows, observedAt, true);
    const screeningResults: SchedulerDecisionCandidateEvidence[] = decisionCandidates.map(
      (candidate) => ({ ...candidate, screeningStatus: 'incomplete' }),
    );
    let complete = 0;
    for (const [rowIndex, row] of poolRows.entries()) {
      const raw = poolRawForAddress(parsed, network, row.pool_address, row.token_address);
      if (!raw) continue;
      const parsedPool = parsePool(raw, chain, row.token_address);
      if (parsedPool.status !== 'complete') continue;
      const screening = parseLevel1ScreeningSnapshot(
        level1ScreeningRawForPool(
          raw,
          parsedPool.pool,
          findPoolAttributes(parsed, network, row.pool_address),
        ),
        parsedPool.pool,
        observedAt,
      );
      if (screening.status !== 'complete') continue;
      complete += 1;
      screeningResults[rowIndex]!.screeningStatus = 'complete';
      const waitingKey = finalistKey({
        chain,
        tokenAddress: row.token_address,
        poolAddress: row.pool_address,
        cycleStartedAt: row.cycle_started_at,
      });
      if (this.finalistWaitingSince.size >= 20_000) this.finalistWaitingSince.clear();
      if (!this.finalistWaitingSince.has(waitingKey))
        this.finalistWaitingSince.set(waitingKey, row.updated_at);
      this.level1ScreeningSnapshots.set(parsedPool.pool.identityKey, screening.snapshot);
      this.level1Pools.set(`${chain}:${row.pool_address}:${row.token_address}`, parsedPool.pool);
      const lastTrade = this.latestStoredTradeEvidence(row);
      if (lastTrade) {
        const promoted = promoteLevel1ScreeningSnapshot(screening.snapshot, lastTrade);
        if (promoted.status === 'complete') {
          const previous = this.level1Snapshots.get(parsedPool.pool.identityKey);
          if (previous) this.previousLevel1Snapshots.set(parsedPool.pool.identityKey, previous);
          this.level1Snapshots.set(parsedPool.pool.identityKey, promoted.snapshot);
        }
      }
    }
    if (supplierRequestStarted)
      this.recordSchedulerDecision({
        decision: 'complete',
        reason: 'supplier_response_persisted_and_screened',
        priority: workKind,
        chain,
        workKey: `pools.multi:${cacheKey}`,
        candidates: screeningResults,
      });
    return { attempted: poolRows.length, complete };
  }

  private touchLevel1CandidateRows(rows: Level1CandidateRow[], at: number, screened = false): void {
    boundedWrite(this.options.database, this.options.writeBudget, (context) => {
      const update = this.options.database.prepare(
        `UPDATE candidates
         SET updated_at = ?, funnel_status = ?
         WHERE id = ? AND cycle_started_at = ? AND config_version_id = ?
           AND safety_status = 'pass' AND status != 'expired'`,
      );
      for (const row of rows)
        context.addRows(
          update.run(
            at,
            level1FunnelAfterBatch(row.status, row.funnel_status, screened),
            row.id,
            row.cycle_started_at,
            this.options.configVersionId,
          ).changes,
        );
    });
  }

  private latestStoredTradeEvidence(row: Level1CandidateRow) {
    const trade = this.options.database
      .prepare(
        `SELECT event_at, observed_at FROM trades
         WHERE chain = ? AND pool_address = ? AND token_address = ?
           AND dedup_status = 'unique' AND ambiguity_status = 'none'
         ORDER BY event_at DESC, observed_at DESC LIMIT 1`,
      )
      .get(row.chain, row.pool_address, row.token_address) as
      { event_at: number; observed_at: number } | undefined;
    return trade
      ? {
          source: 'g2' as const,
          chain: row.chain,
          poolAddress: row.pool_address,
          tokenAddress: row.token_address,
          eventAt: trade.event_at,
          observedAt: trade.observed_at,
        }
      : undefined;
  }

  private async armEligibleCandidates(key: string): Promise<void> {
    const rows = selectArmCandidateRows(
      this.options.database,
      this.options.config.providers.coingecko.scheduler.max_due_pools_per_chain * 2,
      this.options.configVersionId,
      Date.now(),
      {
        sol: this.options.config.chains.sol.discovery.candidate_ttl_seconds,
        bsc: this.options.config.chains.bsc.discovery.candidate_ttl_seconds,
      },
    );
    const existingArmed: Array<{ row: ArmCandidateRow; pool: CanonicalPool }> = [];
    const eligible: Array<{
      row: ArmCandidateRow;
      pool: CanonicalPool;
      screening: Level1ScreeningSnapshot;
    }> = [];
    for (const row of rows) {
      if (!shouldRearmG2Candidate(row.status, row.funnel_status)) continue;
      const pool = this.level1Pools.get(`${row.chain}:${row.pool_address}:${row.token_address}`);
      const cycle = this.trackers[row.chain].get(row.chain, row.token_address);
      if (!pool) continue;
      if (
        ['armed', 'confirmed-pending-anchor'].includes(row.status) ||
        ['armed', 'confirmed-pending-anchor'].includes(row.funnel_status)
      ) {
        existingArmed.push({ row, pool });
        continue;
      }
      const screening = this.level1ScreeningSnapshots.get(pool.identityKey);
      if (!cycle || !screening) continue;
      const attention = evaluateCandidateAttention(
        cycle.evidence,
        this.options.config.strategies.emerging_breakout.attention,
      );
      if (!canArmG2Candidate(row.status, row.funnel_status, attention.status)) continue;
      eligible.push({ row, pool, screening });
    }
    if (eligible.length === 0 && existingArmed.length === 0) {
      if (this.g2Client) {
        const active = this.g2Client.active();
        for (const identityKey of armedSubscriptionsToRelease(active, new Set()))
          this.g2Client.unset(identityKey);
        this.finalistReservations.reconcileOccupied(g2OccupiedIdentities(active, new Set()));
      }
      return;
    }
    const g2Client = await this.ensureG2Client(key);
    const capacityPlan = planExistingG2Capacity(
      existingArmed,
      this.options.config.providers.coingecko.g2.max_subscriptions_per_socket,
    );
    if (capacityPlan.demoted.length > 0) this.demoteArmedForG2Capacity(capacityPlan.demoted);
    const desired = new Set(capacityPlan.retained.map(({ pool }) => pool.identityKey));
    const active = g2Client.active();
    for (const identityKey of armedSubscriptionsToRelease(active, desired))
      g2Client.unset(identityKey);
    this.finalistReservations.reconcileOccupied(g2OccupiedIdentities(active, desired));
    for (const { row, pool } of capacityPlan.retained) {
      const state = row.status === 'armed' ? 'armed' : 'confirmed-pending-anchor';
      if (state === 'confirmed-pending-anchor' && !g2Client.active().has(pool.identityKey))
        g2Client.request(pool, 'armed');
      g2Client.request(pool, state);
    }
    if (capacityPlan.overflowed) return;

    const finalistSortAt = Date.now();
    const finalistMaxWaitMs =
      this.options.config.providers.coingecko.scheduler.max_dynamic_wait_seconds * 1000;
    eligible.sort((left, right) => {
      const leftWaitingSince =
        this.finalistWaitingSince.get(
          finalistKey({
            chain: left.row.chain,
            tokenAddress: left.row.token_address,
            poolAddress: left.row.pool_address,
            cycleStartedAt: left.row.cycle_started_at,
          }),
        ) ?? left.row.updated_at;
      const rightWaitingSince =
        this.finalistWaitingSince.get(
          finalistKey({
            chain: right.row.chain,
            tokenAddress: right.row.token_address,
            poolAddress: right.row.pool_address,
            cycleStartedAt: right.row.cycle_started_at,
          }),
        ) ?? right.row.updated_at;
      const leftAged = finalistSortAt - leftWaitingSince >= finalistMaxWaitMs;
      const rightAged = finalistSortAt - rightWaitingSince >= finalistMaxWaitMs;
      if (leftAged !== rightAged) return leftAged ? -1 : 1;
      const leftWindow = left.screening.windows.m5;
      const rightWindow = right.screening.windows.m5;
      if ((rightWindow?.buyers ?? 0) !== (leftWindow?.buyers ?? 0))
        return (rightWindow?.buyers ?? 0) - (leftWindow?.buyers ?? 0);
      const netBuy = new Decimal(rightWindow?.netBuyUsd ?? '0').comparedTo(
        leftWindow?.netBuyUsd ?? '0',
      );
      if (netBuy !== 0) return netBuy;
      const volume = new Decimal(rightWindow?.volumeUsd ?? '0').comparedTo(
        leftWindow?.volumeUsd ?? '0',
      );
      if (volume !== 0) return volume;
      const reserve = new Decimal(right.screening.reserveUsd).comparedTo(left.screening.reserveUsd);
      if (reserve !== 0) return reserve;
      if (right.screening.poolAgeSeconds !== left.screening.poolAgeSeconds)
        return right.screening.poolAgeSeconds - left.screening.poolAgeSeconds;
      if (leftWaitingSince !== rightWaitingSince) return leftWaitingSince - rightWaitingSince;
      return left.pool.identityKey.localeCompare(right.pool.identityKey);
    });
    const chainCapacity = Math.max(
      1,
      Math.floor(this.options.config.providers.coingecko.g2.max_subscriptions_per_socket / 2),
    );
    const occupiedByChain = { sol: 0, bsc: 0 };
    for (const { row } of capacityPlan.retained) occupiedByChain[row.chain] += 1;
    const initializationJobs: Array<Promise<void>> = [];
    for (const [index, item] of eligible.entries()) {
      const identity = {
        chain: item.row.chain,
        tokenAddress: item.row.token_address,
        poolAddress: item.row.pool_address,
        cycleStartedAt: item.row.cycle_started_at,
      };
      if (occupiedByChain[item.row.chain] >= chainCapacity) {
        this.recordSchedulerDecision({
          decision: 'defer',
          reason: 'finalist_chain_capacity',
          priority: 'candidate_batch',
          chain: item.row.chain,
          tokenAddress: item.row.token_address,
          poolAddress: item.row.pool_address,
          cycleStartedAt: item.row.cycle_started_at,
          dedupeKey: `chain-capacity:${finalistKey(identity)}`,
        });
        continue;
      }
      const reservation = this.finalistReservations.acquire(
        identity,
        Date.now(),
        this.options.config.providers.coingecko.scheduler.reservation_ttl_seconds * 1000,
        eligible.length - index,
      );
      if (reservation.status === 'rejected_capacity') {
        this.recordSchedulerDecision({
          decision: 'defer',
          reason: 'finalist_capacity',
          priority: 'candidate_batch',
          chain: item.row.chain,
          tokenAddress: item.row.token_address,
          poolAddress: item.row.pool_address,
          cycleStartedAt: item.row.cycle_started_at,
          dedupeKey: `capacity:${finalistKey(identity)}`,
        });
        continue;
      }
      if (reservation.status === 'acquired') {
        occupiedByChain[item.row.chain] += 1;
        this.schedulerDecisionKeys.delete(`capacity:${finalistKey(identity)}`);
        this.schedulerDecisionKeys.delete(`chain-capacity:${finalistKey(identity)}`);
        this.recordSchedulerDecision({
          decision: 'reservation_acquired',
          reason: 'attention_structure_capacity_pass',
          priority: 'candidate_batch',
          chain: item.row.chain,
          tokenAddress: item.row.token_address,
          poolAddress: item.row.pool_address,
          cycleStartedAt: item.row.cycle_started_at,
        });
      }
      if (reservation.status === 'acquired' && reservation.preempted)
        this.recordSchedulerDecision({
          decision: 'reservation_preempted',
          reason: `higher_priority:${finalistKey(identity)}`,
          priority: 'candidate_batch',
          chain: reservation.preempted.chain,
          tokenAddress: reservation.preempted.tokenAddress,
          poolAddress: reservation.preempted.poolAddress,
          cycleStartedAt: reservation.preempted.cycleStartedAt,
        });
      initializationJobs.push(
        this.initializeFinalist(key, item, finalistKey(identity)).catch((error) => {
          this.finalistReservations.release(finalistKey(identity));
          this.recordSchedulerDecision({
            decision: 'reservation_released',
            reason: this.safeError(error),
            priority: 'candidate_batch',
            chain: item.row.chain,
            tokenAddress: item.row.token_address,
            poolAddress: item.row.pool_address,
            cycleStartedAt: item.row.cycle_started_at,
          });
          this.options.logger('warn', 'finalist_initialization_failed', {
            chain: item.row.chain,
            pool_address: item.row.pool_address,
            error: this.safeError(error),
          });
        }),
      );
    }
    await Promise.allSettled(initializationJobs);
  }

  private async ensureG2Client(key: string): Promise<CoinGeckoG2Client> {
    this.g2Client ??= new CoinGeckoG2Client({
      websocketUrl: this.options.config.providers.coingecko.websocket_url,
      apiKey: key,
      maxSubscriptions: this.options.config.providers.coingecko.g2.max_subscriptions_per_socket,
      maxResponseBytes: this.options.config.providers.coingecko.max_response_bytes,
      connectTimeoutMs: this.options.config.providers.coingecko.request_timeout_ms,
      reconnectDelayMs: 1_000,
      logger: this.options.logger,
      onMessage: (message, observedAt) => this.recordG2Message(message, observedAt),
      onIntegrityLoss: () => {
        this.g2IntegrityEpoch += 1;
      },
    });
    await this.g2Client.start();
    return this.g2Client;
  }

  private async initializeFinalist(
    key: string,
    item: { row: ArmCandidateRow; pool: CanonicalPool; screening: Level1ScreeningSnapshot },
    reservationKey: string,
  ): Promise<void> {
    const { row, pool, screening } = item;
    const network = row.chain === 'sol' ? 'solana' : 'bsc';
    const retry = this.options.config.providers.coingecko.scheduler.initialization_retry;
    let tradePayload: { payload: Record<string, unknown>; observedAt: number } | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= retry.max_attempts; attempt += 1) {
      try {
        tradePayload = await this.scheduleCoinGeckoRequest({
          key: `trades.initialize:${reservationKey}:${attempt}`,
          kind: 'candidate_batch',
          requestType: 'trade',
          chain: row.chain,
          createdAt: Date.now(),
          run: async (signal) => {
            const tradeUrl = `${this.options.config.providers.coingecko.rest_base_url}/onchain/networks/${network}/pools/${encodeURIComponent(row.pool_address)}/trades`;
            assertAnalystEndpoint(tradeUrl, this.options.config.providers.coingecko.rest_base_url);
            const tradeResult = await requestJson<Record<string, unknown>>(
              tradeUrl,
              { headers: { 'x-cg-pro-api-key': key }, signal },
              httpOptions(this.options.config, 'coingecko', 'trades.level1.initialize'),
            );
            const payload = coingeckoTradesRawSchema.parse(tradeResult.data);
            const observedAt = Date.now();
            const rawPayload = JSON.stringify(payload);
            insertProviderEvent(
              this.options.database,
              {
                provider: 'coingecko',
                capability: 'trades.level1',
                chain: row.chain,
                tokenAddress: row.token_address,
                poolAddress: row.pool_address,
                observedAt,
                schemaVersion: 'coingecko.trades.v1',
                payload: rawPayload,
                billingBucket: 'g2_confirmation',
                requestMeta: {
                  endpoint_name: 'onchain.pools.trades.initialize',
                  method: 'GET',
                  status: tradeResult.diagnostic.status,
                  response_bytes: Buffer.byteLength(rawPayload),
                },
              },
              this.options.writeBudget,
            );
            return { payload, observedAt };
          },
        });
        break;
      } catch (error) {
        lastError = error;
        if (!isTransientProviderError(error) || attempt === retry.max_attempts) throw error;
        await delay(Math.min(retry.max_delay_ms, retry.base_delay_ms * 2 ** (attempt - 1)));
      }
    }
    if (!tradePayload) throw lastError ?? new Error('finalist:initialization_failed');
    const eventAt = latestTradeAt(tradePayload.payload);
    if (eventAt === undefined) {
      this.finalistReservations.release(reservationKey);
      this.recordSchedulerDecision({
        decision: 'reservation_released',
        reason: 'initialization:no_trade_event',
        priority: 'candidate_batch',
        chain: row.chain,
        tokenAddress: row.token_address,
        poolAddress: row.pool_address,
        cycleStartedAt: row.cycle_started_at,
      });
      return;
    }
    const promoted = promoteLevel1ScreeningSnapshot(screening, {
      source: 'rest',
      chain: row.chain,
      poolAddress: row.pool_address,
      tokenAddress: row.token_address,
      eventAt,
      observedAt: tradePayload.observedAt,
    });
    if (promoted.status !== 'complete') {
      this.finalistReservations.release(reservationKey);
      this.recordSchedulerDecision({
        decision: 'reservation_released',
        reason: `initialization:${promoted.reasons.join('|')}`,
        priority: 'candidate_batch',
        chain: row.chain,
        tokenAddress: row.token_address,
        poolAddress: row.pool_address,
        cycleStartedAt: row.cycle_started_at,
      });
      return;
    }
    const previous = this.level1Snapshots.get(pool.identityKey);
    if (previous) this.previousLevel1Snapshots.set(pool.identityKey, previous);
    this.level1Snapshots.set(pool.identityKey, promoted.snapshot);
    const changed = boundedWrite(this.options.database, this.options.writeBudget, (context) => {
      const info = this.options.database
        .prepare(
          `UPDATE candidates SET status = 'armed', funnel_status = 'armed', updated_at = ?
           WHERE id = ? AND chain = ? AND token_address = ? AND pool_address = ?
             AND cycle_started_at = ? AND config_version_id = ?
             AND safety_status = 'pass' AND status != 'expired'`,
        )
        .run(
          Date.now(),
          row.id,
          pool.chain,
          pool.tokenAddress,
          pool.poolAddress,
          row.cycle_started_at,
          this.options.configVersionId,
        );
      context.addRows(info.changes);
      return info.changes;
    }).value;
    if (changed !== 1) {
      this.finalistReservations.release(reservationKey);
      this.recordSchedulerDecision({
        decision: 'reservation_released',
        reason: 'candidate:no_longer_eligible',
        priority: 'candidate_batch',
        chain: row.chain,
        tokenAddress: row.token_address,
        poolAddress: row.pool_address,
        cycleStartedAt: row.cycle_started_at,
      });
      return;
    }
    if (!this.finalistReservations.convertToArmed(reservationKey, Date.now())) {
      boundedWrite(this.options.database, this.options.writeBudget, (context) => {
        const info = this.options.database
          .prepare(
            `UPDATE candidates SET status = 'scouting', funnel_status = 'level1_screened', updated_at = ?
             WHERE id = ? AND cycle_started_at = ? AND status = 'armed'`,
          )
          .run(Date.now(), row.id, row.cycle_started_at);
        context.addRows(info.changes);
      });
      this.recordSchedulerDecision({
        decision: 'reservation_released',
        reason: 'reservation:expired_before_armed',
        priority: 'candidate_batch',
        chain: row.chain,
        tokenAddress: row.token_address,
        poolAddress: row.pool_address,
        cycleStartedAt: row.cycle_started_at,
      });
      return;
    }
    const result = this.g2Client!.request(pool, 'armed');
    if (result === 'rejected_capacity') {
      this.finalistReservations.releaseOccupied(
        g2IdentityKey({
          chain: row.chain,
          tokenAddress: row.token_address,
          poolAddress: row.pool_address,
        }),
      );
      boundedWrite(this.options.database, this.options.writeBudget, (context) => {
        const info = this.options.database
          .prepare(
            `UPDATE candidates SET status = 'scouting', funnel_status = 'level1_screened', updated_at = ?
             WHERE id = ? AND cycle_started_at = ? AND status = 'armed'`,
          )
          .run(Date.now(), row.id, row.cycle_started_at);
        context.addRows(info.changes);
      });
      this.recordSchedulerDecision({
        decision: 'armed_reverted',
        reason: 'g2:rejected_capacity',
        priority: 'candidate_batch',
        chain: row.chain,
        tokenAddress: row.token_address,
        poolAddress: row.pool_address,
        cycleStartedAt: row.cycle_started_at,
      });
      return;
    }
    this.recordSchedulerDecision({
      decision: 'armed',
      reason: 'rest_trade_promoted_then_g2_requested',
      priority: 'candidate_batch',
      chain: row.chain,
      tokenAddress: row.token_address,
      poolAddress: row.pool_address,
      cycleStartedAt: row.cycle_started_at,
    });
    this.finalistWaitingSince.delete(reservationKey);
    this.options.logger('info', 'finalist_armed', {
      chain: row.chain,
      pool_address: row.pool_address,
      cycle_started_at: row.cycle_started_at,
    });
  }

  private demoteArmedForG2Capacity(
    items: Array<{ row: ArmCandidateRow; pool: CanonicalPool }>,
  ): void {
    const at = Date.now();
    boundedWrite(this.options.database, this.options.writeBudget, (context) => {
      const update = this.options.database.prepare(
        `UPDATE candidates
         SET status = 'scouting', funnel_status = 'level1_screened', updated_at = ?
         WHERE id = ? AND cycle_started_at = ? AND config_version_id = ? AND status = 'armed'`,
      );
      for (const { row } of items)
        context.addRows(
          update.run(at, row.id, row.cycle_started_at, this.options.configVersionId).changes,
        );
    });
    for (const { row, pool } of items) {
      this.g2Client?.unset(pool.identityKey);
      this.finalistReservations.releaseOccupied(pool.identityKey);
      this.recordSchedulerDecision({
        decision: 'armed_reverted',
        reason: 'g2:capacity_rebalance',
        priority: 'candidate_batch',
        chain: row.chain,
        tokenAddress: row.token_address,
        poolAddress: row.pool_address,
        cycleStartedAt: row.cycle_started_at,
      });
    }
  }

  private restorePreviousLevel1Snapshot(
    chain: 'sol' | 'bsc',
    row: { token_address: string; pool_address: string },
    pool: CanonicalPool,
    before: number,
  ): Level1Snapshot | undefined {
    const poolEvents = this.options.database
      .prepare(
        `SELECT observed_at, payload_encoding, payload
         FROM provider_events
         WHERE provider = 'coingecko' AND capability = 'pools.multi.level1'
           AND chain = ? AND observed_at < ?
         ORDER BY observed_at DESC LIMIT 30`,
      )
      .all(chain, before) as Array<{
      observed_at: number;
      payload_encoding: 'identity' | 'gzip';
      payload: Buffer;
    }>;
    const tradeEvent = this.options.database
      .prepare(
        `SELECT observed_at, payload_encoding, payload
         FROM provider_events
         WHERE provider = 'coingecko' AND capability = 'trades.level1'
           AND chain = ? AND lower(pool_address) = lower(?) AND observed_at < ?
         ORDER BY observed_at DESC LIMIT 1`,
      )
      .get(chain, row.pool_address, before) as
      | {
          observed_at: number;
          payload_encoding: 'identity' | 'gzip';
          payload: Buffer;
        }
      | undefined;
    if (!tradeEvent) return undefined;
    let tradePayload: Record<string, unknown>;
    try {
      tradePayload = coingeckoTradesRawSchema.parse(
        JSON.parse(decodeProviderPayload(tradeEvent.payload, tradeEvent.payload_encoding)),
      );
    } catch {
      return undefined;
    }
    for (const event of poolEvents) {
      try {
        const payload = coingeckoPoolBatchRawSchema.parse(
          JSON.parse(decodeProviderPayload(event.payload, event.payload_encoding)),
        );
        const raw = poolRawForAddress(
          payload,
          chain === 'sol' ? 'solana' : 'bsc',
          row.pool_address,
          row.token_address,
        );
        if (!raw) continue;
        const parsedPool = parsePool(raw, chain, row.token_address);
        if (parsedPool.status !== 'complete') continue;
        const observedAt = Math.max(event.observed_at, tradeEvent.observed_at);
        const level1 = parseLevel1Snapshot(
          level1RawForPool(
            raw,
            parsedPool.pool,
            findPoolAttributes(payload, chain === 'sol' ? 'solana' : 'bsc', row.pool_address),
            observedAt,
            latestTradeAt(tradePayload),
          ),
          parsedPool.pool,
          observedAt,
        );
        if (level1.status === 'complete') return level1.snapshot;
      } catch {
        continue;
      }
    }
    return undefined;
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
    const jobs: Array<Promise<void>> = [];
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
      if (!signal) continue;
      const pool = row.pool_address
        ? ([...this.level1Pools.values()].find(
            (candidate) =>
              candidate.chain === row.chain &&
              candidate.poolAddress === row.pool_address &&
              candidate.tokenAddress === row.token_address,
          ) ??
          readPersistedOutcomePool(
            this.options.database,
            row.chain,
            row.token_address,
            row.pool_address,
            signal.cycleStartedAt,
            signal.confirmedAt,
          ))
        : undefined;
      if (!pool || row.target_side === null) continue;
      this.level1Pools.set(pool.identityKey, pool);
      const now = Date.now();
      const entryCoverageUntil =
        row.sent_at + this.options.config.outcomes.entry_timeout_seconds * 1000;
      let entryCoverageComplete = readOutcomeEntryCoverage(
        this.options.database,
        row.signal_id,
        pool,
      );
      if (entryCoverageComplete === undefined && now < entryCoverageUntil) {
        const startedWithContinuousCoverage =
          this.g2Client?.status() === 'ok' &&
          this.g2Client.active().get(pool.identityKey) === 'confirmed-pending-anchor';
        if (!this.outcomeG2StartEpoch.has(row.signal_id))
          this.outcomeG2StartEpoch.set(
            row.signal_id,
            startedWithContinuousCoverage ? this.g2IntegrityEpoch : -1,
          );
        try {
          const client = await this.ensureG2Client(key);
          if (!client.active().has(pool.identityKey)) client.request(pool, 'armed');
          client.request(pool, 'confirmed-pending-anchor');
        } catch (error) {
          this.options.logger('warn', 'outcome_g2_recovery_failed', {
            signal_id: row.signal_id,
            error: this.safeError(error),
          });
        }
      } else if (entryCoverageComplete === undefined) {
        const startEpoch = this.outcomeG2StartEpoch.get(row.signal_id);
        entryCoverageComplete = outcomeEntryCoverageIsComplete(
          startEpoch,
          this.g2IntegrityEpoch,
          this.g2Client?.status() === 'ok',
          this.g2Client?.active().get(pool.identityKey) === 'confirmed-pending-anchor',
          this.g2Queue.atHighWatermark(),
        );
        recordOutcomeEntryCoverage(
          this.options.database,
          this.options.writeBudget,
          row.signal_id,
          pool,
          entryCoverageComplete,
          now,
        );
        this.outcomeG2StartEpoch.delete(row.signal_id);
        this.unsetSignalG2(row.signal_id);
      }
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
      jobs.push(
        this.processOutcomeRow(
          key,
          { ...row, sent_at: row.sent_at },
          signal,
          pool,
          anchorDestination,
          now,
          maxHorizon,
          finalCutoff,
          entryCoverageComplete ?? false,
        ).catch((error: unknown) => {
          this.options.logger('warn', 'outcome_runtime_incomplete', {
            signal_id: row.signal_id,
            error: this.safeError(error),
          });
        }),
      );
    }
    await Promise.allSettled(jobs);
  }

  private async processOutcomeRow(
    key: string,
    row: {
      signal_id: number;
      config_version_id: number;
      pre_send_drift: string | null;
      chain: 'sol' | 'bsc';
      sent_at: number;
    },
    signal: SignalSnapshot,
    pool: CanonicalPool,
    anchorDestination: 'admin_private' | 'channel' | 'group',
    now: number,
    maxHorizon: number,
    finalCutoff: number,
    entryCoverageComplete: boolean,
  ): Promise<void> {
    const candles = await this.fetchOutcomeCandles(key, pool, row.sent_at, now, finalCutoff);
    if (now < finalCutoff) return;
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
      g2CoverageComplete: entryCoverageComplete,
      restCoverageComplete: hasCandleCoverage(
        candles,
        row.sent_at,
        row.sent_at + maxHorizon * 1000,
      ),
      restConflict:
        selectedEntry !== undefined && !candleContainsTrade(candles, selectedEntry, row.sent_at),
    });
    const entryPartial = selectedEntry ? partialFromTrades(selectedEntry, trades) : undefined;
    const horizonResults = this.options.config.outcomes.horizons_seconds.map((horizonSeconds) =>
      evaluateHorizon({
        anchorDeliveredAt: row.sent_at,
        horizonSeconds,
        outcomeMaxLatenessSeconds: this.options.config.outcomes.outcome_max_lateness_seconds,
        ...(selectedEntry
          ? { entry: { observedAt: selectedEntry.observedAt, priceUsd: selectedEntry.priceUsd } }
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
  }

  private async fetchOutcomeCandles(
    key: string,
    pool: CanonicalPool,
    anchorDeliveredAt: number,
    now: number,
    finalCutoff: number,
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
    const result = await this.scheduleCoinGeckoRequest({
      key: `ohlcv.30s:${pool.identityKey}:${now}`,
      kind: 'outcome',
      requestType: 'batch',
      chain: pool.chain,
      createdAt: now,
      deadlineAt: finalCutoff,
      run: (signal) =>
        requestJson<Record<string, unknown>>(
          url,
          { headers: { 'x-cg-pro-api-key': key }, signal },
          httpOptions(this.options.config, 'coingecko', 'ohlcv.30s'),
        ),
    });
    const observedAt = Date.now();
    const payload = JSON.stringify(result.data);
    const providerEvent = insertProviderEvent(
      this.options.database,
      {
        provider: 'coingecko',
        capability: 'ohlcv.30s',
        chain: pool.chain,
        tokenAddress: pool.tokenAddress,
        poolAddress: pool.poolAddress,
        observedAt,
        schemaVersion: 'coingecko.ohlcv.30s.v2',
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
    const parsed = coingeckoOhlcv30sRawSchema.parse(result.data);
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
             VALUES (?, ?, ?, ?, ?, 30, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'coingecko.ohlcv.30s.v2')`,
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
          `UPDATE candidates SET status = 'expired', close_reason = ?, updated_at = ?
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
    if (signal?.pool_address) {
      const identityKey = `${signal.chain}:${signal.pool_address}:${signal.token_address}`;
      this.g2Client?.unset(identityKey);
      this.finalistReservations.releaseOccupied(identityKey);
    }
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

  private tryCreateLiveSignal(
    trade: NormalizedTrade,
    allowRefresh = true,
    confirmationWindowEnd?: number,
  ): void {
    const cycle = this.trackers[trade.chain].get(trade.chain, trade.tokenAddress);
    if (!cycle) {
      this.logSignalBlocked(trade, ['cycle:missing']);
      return;
    }
    const candidate = this.options.database
      .prepare(
        `SELECT id, cycle_started_at, safety_json FROM candidates
         WHERE chain = ? AND token_address = ? AND pool_address = ?
           AND cycle_started_at = ? AND status = 'armed' AND safety_status = 'pass'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(trade.chain, trade.tokenAddress, trade.poolAddress, cycle.cycleStartedAt) as
      { id: number; cycle_started_at: number; safety_json: string | null } | undefined;
    if (!candidate) {
      this.logSignalBlocked(trade, ['candidate:not_armed']);
      return;
    }
    if (!candidate.safety_json) {
      this.logSignalBlocked(trade, ['candidate:missing_safety']);
      return;
    }
    const pool = [...this.level1Pools.values()].find(
      (item) =>
        item.chain === trade.chain &&
        item.tokenAddress === trade.tokenAddress &&
        item.poolAddress === trade.poolAddress,
    );
    if (!pool) {
      this.logSignalBlocked(trade, ['pool:missing']);
      return;
    }
    const level1 = this.level1Snapshots.get(pool.identityKey);
    if (!level1) {
      this.logSignalBlocked(trade, ['level1:missing']);
      return;
    }
    const now = Date.now();
    const windowEnd = confirmationWindowEnd ?? Math.floor(now / 30_000) * 30_000;
    if (
      confirmationWindowEnd !== undefined &&
      !isConfirmationWindowUsable(now, confirmationWindowEnd)
    ) {
      this.logSignalBlocked(trade, ['g2:stale']);
      return;
    }
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
    if (!safety) {
      this.logSignalBlocked(trade, ['safety:invalid']);
      return;
    }
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
        attention: evaluateCandidateAttention(
          cycle.evidence,
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
    if (result.status !== 'created') {
      this.logSignalBlocked(trade, result.reasons);
      if (allowRefresh && shouldRefreshConfirmationEvidence(result.reasons))
        this.scheduleConfirmationRefresh(trade, candidate.id, pool, windowEnd, result.reasons);
      return;
    }
    this.g2Client?.request(pool, 'confirmed-pending-anchor');
    this.options.logger('info', 'signal_created', {
      signal_id: result.signalId,
      candidate_id: candidate.id,
      chain: trade.chain,
      pool_address: trade.poolAddress,
    });
  }

  private scheduleConfirmationRefresh(
    trade: NormalizedTrade,
    candidateId: number,
    pool: CanonicalPool,
    windowEnd: number,
    reasons: readonly string[],
  ): void {
    const key = `${trade.chain}:${trade.poolAddress}:${trade.tokenAddress}:${windowEnd}`;
    if (this.stopping || this.confirmationRefreshAttempted.has(key)) return;
    if (this.confirmationRefreshAttempted.size >= 10_000) this.confirmationRefreshAttempted.clear();
    this.confirmationRefreshAttempted.add(key);
    this.options.logger('info', 'confirmation_evidence_refresh_started', {
      chain: trade.chain,
      pool_address: trade.poolAddress,
      window_end: windowEnd,
      reasons: [...new Set(reasons)].sort(),
    });
    const refresh = refreshConfirmationEvidence({
      now: Date.now,
      configVersionId: String(this.options.configVersionId),
      refreshSafety: () => this.refreshCandidateSafety(candidateId, trade),
      refreshLevel1: () => this.refreshConfirmationLevel1(candidateId, pool, windowEnd + 30_000),
    })
      .then((result) => {
        if (result.status === 'blocked') {
          if (result.reason.startsWith('safety:')) this.g2Client?.unset(pool.identityKey);
          this.options.logger('info', 'confirmation_evidence_refresh_blocked', {
            chain: trade.chain,
            pool_address: trade.poolAddress,
            window_end: windowEnd,
            reason: result.reason,
          });
          return;
        }
        this.options.logger('info', 'confirmation_evidence_refresh_completed', {
          chain: trade.chain,
          pool_address: trade.poolAddress,
          window_end: windowEnd,
        });
        if (!this.stopping) this.tryCreateLiveSignal(trade, false, windowEnd);
      })
      .catch((error: unknown) => {
        this.options.logger('warn', 'confirmation_evidence_refresh_failed', {
          chain: trade.chain,
          pool_address: trade.poolAddress,
          window_end: windowEnd,
          error: this.safeError(error),
        });
      });
    this.confirmationRefreshes.add(refresh);
    void refresh.then(
      () => this.confirmationRefreshes.delete(refresh),
      () => this.confirmationRefreshes.delete(refresh),
    );
  }

  private async refreshCandidateSafety(
    candidateId: number,
    trade: NormalizedTrade,
  ): Promise<SafetyResult> {
    const raw = await this.requestGmgn([
      'token',
      'security',
      '--chain',
      trade.chain,
      '--address',
      trade.tokenAddress,
    ]);
    const parsed = gmgnSecurityRawSchema.parse(JSON.parse(raw));
    const observedAt = Date.now();
    const event = insertProviderEvent(
      this.options.database,
      {
        provider: 'gmgn',
        capability: 'token.security',
        chain: trade.chain,
        tokenAddress: parsed.address,
        observedAt,
        schemaVersion: 'gmgn.security.v1',
        payload: raw,
        requestMeta: {
          endpoint_name: 'token.security',
          method: 'cli',
          response_bytes: Buffer.byteLength(raw),
        },
      },
      this.options.writeBudget,
    );
    if (!sameChainAddress(trade.chain, parsed.address, trade.tokenAddress))
      throw new Error('identity:token_address');
    const safety = this.evaluateSafety(trade.chain, parsed, event.id, observedAt);
    let candidateActive = false;
    boundedWrite(this.options.database, this.options.writeBudget, (context) => {
      const info = this.options.database
        .prepare(
          `UPDATE candidates SET safety_status = ?, safety_json = ?, updated_at = ?
           WHERE id = ? AND chain = ? AND token_address = ? AND config_version_id = ?
             AND status != 'expired'`,
        )
        .run(
          safety.status,
          JSON.stringify(safety),
          observedAt,
          candidateId,
          trade.chain,
          trade.tokenAddress,
          this.options.configVersionId,
        );
      context.addRows(info.changes);
      candidateActive = info.changes === 1;
    });
    if (!candidateActive) throw new Error('candidate:no_longer_active');
    return safety;
  }

  private async refreshConfirmationLevel1(
    candidateId: number,
    pool: CanonicalPool,
    deadlineAt: number,
  ): Promise<Level1Snapshot | undefined> {
    const key = this.options.secrets[this.options.config.providers.coingecko.api_key_env];
    if (!key) throw new Error('CoinGecko secret is not configured');
    const network = pool.chain === 'sol' ? 'solana' : 'bsc';
    const poolUrl = `${this.options.config.providers.coingecko.rest_base_url}/onchain/networks/${network}/pools/multi/${encodeURIComponent(pool.poolAddress)}?include=base_token,quote_token&include_volume_breakdown=true&include_composition=true`;
    assertAnalystEndpoint(poolUrl, this.options.config.providers.coingecko.rest_base_url);
    const poolResult = await this.scheduleCoinGeckoRequest({
      key: `pools.multi.confirmation:${pool.identityKey}:${deadlineAt}`,
      kind: 'confirmation',
      requestType: 'batch',
      chain: pool.chain,
      createdAt: Date.now(),
      deadlineAt,
      run: (signal) =>
        requestJson<Record<string, unknown>>(
          poolUrl,
          { headers: { 'x-cg-pro-api-key': key }, signal },
          httpOptions(this.options.config, 'coingecko', 'pools.multi.level1.confirmation'),
        ),
    });
    const batch = coingeckoPoolBatchRawSchema.parse(poolResult.data);
    const poolObservedAt = Date.now();
    const poolPayload = JSON.stringify(batch);
    insertProviderEvent(
      this.options.database,
      {
        provider: 'coingecko',
        capability: 'pools.multi.level1',
        chain: pool.chain,
        tokenAddress: pool.tokenAddress,
        poolAddress: pool.poolAddress,
        observedAt: poolObservedAt,
        schemaVersion: 'coingecko.pools.multi.v1',
        payload: poolPayload,
        billingBucket: 'pool_screening',
        requestMeta: {
          endpoint_name: 'onchain.pools.multi.confirmation',
          method: 'GET',
          status: poolResult.diagnostic.status,
          response_bytes: Buffer.byteLength(poolPayload),
        },
      },
      this.options.writeBudget,
    );
    const poolRaw = poolRawForAddress(batch, network, pool.poolAddress, pool.tokenAddress);
    if (!poolRaw) return undefined;
    const parsedPool = parsePool(poolRaw, pool.chain, pool.tokenAddress);
    if (parsedPool.status !== 'complete' || parsedPool.pool.identityKey !== pool.identityKey)
      return undefined;

    const tradeUrl = `${this.options.config.providers.coingecko.rest_base_url}/onchain/networks/${network}/pools/${encodeURIComponent(pool.poolAddress)}/trades`;
    assertAnalystEndpoint(tradeUrl, this.options.config.providers.coingecko.rest_base_url);
    const tradeResult = await this.scheduleCoinGeckoRequest({
      key: `trades.confirmation:${pool.identityKey}:${deadlineAt}`,
      kind: 'confirmation',
      requestType: 'trade',
      chain: pool.chain,
      createdAt: Date.now(),
      deadlineAt,
      run: (signal) =>
        requestJson<Record<string, unknown>>(
          tradeUrl,
          { headers: { 'x-cg-pro-api-key': key }, signal },
          httpOptions(this.options.config, 'coingecko', 'trades.level1.confirmation'),
        ),
    });
    const trades = coingeckoTradesRawSchema.parse(tradeResult.data);
    const tradeObservedAt = Date.now();
    const tradePayload = JSON.stringify(trades);
    insertProviderEvent(
      this.options.database,
      {
        provider: 'coingecko',
        capability: 'trades.level1',
        chain: pool.chain,
        tokenAddress: pool.tokenAddress,
        poolAddress: pool.poolAddress,
        observedAt: tradeObservedAt,
        schemaVersion: 'coingecko.trades.v1',
        payload: tradePayload,
        billingBucket: 'pool_screening',
        requestMeta: {
          endpoint_name: 'onchain.pools.trades.confirmation',
          method: 'GET',
          status: tradeResult.diagnostic.status,
          response_bytes: Buffer.byteLength(tradePayload),
        },
      },
      this.options.writeBudget,
    );
    const observedAt = latestLevel1ObservedAt(poolObservedAt, tradeObservedAt);
    const parsed = parseLevel1Snapshot(
      level1RawForPool(
        poolRaw,
        parsedPool.pool,
        findPoolAttributes(batch, network, pool.poolAddress),
        observedAt,
        latestTradeAt(trades),
      ),
      parsedPool.pool,
      observedAt,
    );
    if (parsed.status !== 'complete') return undefined;
    const previous =
      this.level1Snapshots.get(pool.identityKey) ??
      this.restorePreviousLevel1Snapshot(
        pool.chain,
        { token_address: pool.tokenAddress, pool_address: pool.poolAddress },
        parsedPool.pool,
        poolObservedAt,
      );
    let candidateActive = false;
    boundedWrite(this.options.database, this.options.writeBudget, (context) => {
      const info = this.options.database
        .prepare(
          `UPDATE candidates SET updated_at = ?
           WHERE id = ? AND chain = ? AND token_address = ? AND pool_address = ?
             AND safety_status = 'pass' AND status != 'expired'`,
        )
        .run(observedAt, candidateId, pool.chain, pool.tokenAddress, pool.poolAddress);
      context.addRows(info.changes);
      candidateActive = info.changes === 1;
    });
    if (!candidateActive) return undefined;
    if (previous) this.previousLevel1Snapshots.set(pool.identityKey, previous);
    this.level1Snapshots.set(pool.identityKey, parsed.snapshot);
    this.level1Pools.set(`${pool.chain}:${pool.poolAddress}:${pool.tokenAddress}`, parsedPool.pool);
    return parsed.snapshot;
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

  private logSignalBlocked(trade: NormalizedTrade, reasons: readonly string[]): void {
    const windowEnd = Math.floor(Date.now() / 30_000) * 30_000;
    const normalizedReasons = [...new Set(reasons)].sort();
    const key = `${trade.chain}:${trade.poolAddress}:${trade.tokenAddress}:${windowEnd}:${normalizedReasons.join('|')}`;
    if (this.signalBlockLogKeys.has(key)) return;
    if (this.signalBlockLogKeys.size >= 10_000) this.signalBlockLogKeys.clear();
    this.signalBlockLogKeys.add(key);
    this.options.logger('info', 'signal_blocked', {
      chain: trade.chain,
      pool_address: trade.poolAddress,
      window_end: windowEnd,
      reasons: normalizedReasons,
    });
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
    this.g2IntegrityEpoch += 1;
    this.g2Queue.markIncomplete(reason);
    this.options.logger('warn', 'g2_evidence_incomplete', { reason });
  }

  private async resolveCoinGeckoPools(key: string): Promise<unknown[]> {
    const disk = readDiskHealth(
      path.dirname(path.resolve(this.options.config.storage.database_path)),
      this.options.config.storage.disk_high_water_percent,
    );
    if (disk.highWater) throw new Error('disk:high_water');
    const results = await Promise.allSettled(
      (['sol', 'bsc'] as const).map((chain) => this.resolveCoinGeckoPoolsForChain(key, chain)),
    );
    const chains = ['sol', 'bsc'] as const;
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected' ? [{ chain: chains[index]!, reason: result.reason }] : [],
    );
    for (const failure of failures)
      this.options.logger('warn', 'pool_resolution_chain_failed', {
        chain: failure.chain,
        error: this.safeError(failure.reason),
      });
    return failures.map((failure) => failure.reason);
  }

  private async resolveCoinGeckoPoolsForChain(key: string, chain: 'sol' | 'bsc'): Promise<void> {
    const now = Date.now();
    const chainRows = selectPoolResolutionRows(
      this.options.database,
      chain,
      now,
      this.options.config.chains[chain].discovery.candidate_ttl_seconds,
      this.options.config.providers.coingecko.max_pools_per_batch,
      this.options.configVersionId,
    );
    const tokens = [...new Set(chainRows.map((row) => row.token_address))].slice(
      0,
      this.options.config.providers.coingecko.max_pools_per_batch,
    );
    if (tokens.length === 0) return;
    const network = chain === 'sol' ? 'solana' : 'bsc';
    const url = `${this.options.config.providers.coingecko.rest_base_url}/onchain/networks/${network}/tokens/multi/${tokens.map(encodeURIComponent).join(',')}?include=top_pools&include_composition=true`;
    assertAnalystEndpoint(url, this.options.config.providers.coingecko.rest_base_url);
    const identityKey = tokens
      .map((token) => (chain === 'bsc' ? token.toLowerCase() : token))
      .sort()
      .join(',');
    const result = await this.scheduleCoinGeckoRequest({
      key: `tokens.multi:${chain}:${identityKey}`,
      kind: 'candidate_batch',
      requestType: 'batch',
      chain,
      createdAt: now,
      run: (signal) =>
        requestJson<Record<string, unknown>>(
          url,
          { headers: { 'x-cg-pro-api-key': key }, signal },
          httpOptions(this.options.config, 'coingecko', 'tokens.multi'),
        ),
    });
    const parsed = coingeckoPoolBatchRawSchema.parse(result.data);
    const observedAt = Date.now();
    const payload = JSON.stringify(parsed);
    insertProviderEvent(
      this.options.database,
      {
        provider: 'coingecko',
        capability: 'tokens.multi',
        chain,
        observedAt,
        schemaVersion: 'coingecko.tokens.multi.v1',
        payload,
        billingBucket: 'pool_screening',
        requestMeta: {
          endpoint_name: 'onchain.tokens.multi',
          method: 'GET',
          status: result.diagnostic.status,
          response_bytes: Buffer.byteLength(payload),
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
  }

  private applyPoolSelections(
    rows: Array<{
      id: number;
      chain: 'sol' | 'bsc';
      token_address: string;
      pool_retry_attempt: number;
    }>,
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
          const update = this.options.database.prepare(
            `UPDATE candidates SET pool_address = ?, target_side = ?, funnel_status = 'pool_resolved',
             updated_at = ?, pool_retry_attempt = 0, pool_retry_at = NULL
             WHERE id = ? AND safety_status = 'pass' AND status != 'expired'
               AND pool_address IS NULL`,
          );
          for (const row of tokenRows)
            context.addRows(
              update.run(pool.poolAddress, pool.targetSide, observedAt, row.id).changes,
            );
        } else {
          const retryAttempt = Math.max(...tokenRows.map((row) => row.pool_retry_attempt), 0);
          const retryChain = tokenRows[0]?.chain ?? (network === 'solana' ? 'sol' : 'bsc');
          const retryAt = unresolvedRetryAt(
            observedAt,
            retryAttempt,
            this.options.config.chains[retryChain].discovery.unresolved_retry_initial_seconds,
            this.options.config.chains[retryChain].discovery.unresolved_retry_max_seconds,
          );
          const update = this.options.database.prepare(
            `UPDATE candidates SET funnel_status = 'pool_unresolved', updated_at = ?,
             pool_retry_attempt = ?, pool_retry_at = ?
             WHERE id = ? AND safety_status = 'pass' AND status != 'expired'
               AND pool_address IS NULL`,
          );
          for (const row of tokenRows)
            context.addRows(update.run(observedAt, retryAttempt + 1, retryAt, row.id).changes);
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

export function summarizeLevel1BatchResults(
  expectedCounts: number[],
  results: PromiseSettledResult<{ attempted: number; complete: number }>[],
): { attempted: number; complete: number; failures: number; deferred: number } {
  if (expectedCounts.length !== results.length)
    throw new Error('Level 1 batch result count does not match scheduled work');
  let attempted = 0;
  let complete = 0;
  let failures = 0;
  let deferred = 0;
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      attempted += result.value.attempted;
      complete += result.value.complete;
    } else {
      attempted += expectedCounts[index] ?? 0;
      failures += 1;
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      if (message.startsWith('scheduler:credit_deferred')) deferred += 1;
    }
  }
  if (complete > attempted) throw new Error('Invalid Level 1 batch summary');
  return { attempted, complete, failures, deferred };
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

function isTransientProviderError(error: unknown): boolean {
  if (!(error instanceof ProviderRequestError)) return false;
  const status = error.diagnostic.status;
  return (
    status === null ||
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
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

export function readPersistedOutcomePool(
  database: SqliteDatabase,
  chain: 'sol' | 'bsc',
  tokenAddress: string,
  poolAddress: string,
  cycleStartedAt = 0,
  confirmedAt = Number.MAX_SAFE_INTEGER,
): CanonicalPool | undefined {
  const addressClause =
    chain === 'bsc'
      ? 'lower(pool_address) = lower(?) AND lower(token_address) = lower(?)'
      : 'pool_address = ? AND token_address = ?';
  const exactEvents = database
    .prepare(
      `SELECT payload_encoding, payload
       FROM provider_events
       WHERE provider = 'coingecko' AND capability = 'pools.multi.level1'
         AND chain = ? AND ${addressClause}
       ORDER BY observed_at DESC LIMIT 10`,
    )
    .all(chain, poolAddress, tokenAddress) as Array<{
    payload_encoding: 'identity' | 'gzip';
    payload: Buffer;
  }>;
  const fallbackEvents = database
    .prepare(
      `SELECT payload_encoding, payload
       FROM provider_events
       WHERE provider = 'coingecko' AND capability = 'pools.multi.level1'
         AND chain = ? AND observed_at BETWEEN ? AND ?
       ORDER BY observed_at DESC LIMIT 100`,
    )
    .all(chain, cycleStartedAt, confirmedAt) as Array<{
    payload_encoding: 'identity' | 'gzip';
    payload: Buffer;
  }>;
  const network = chain === 'sol' ? 'solana' : 'bsc';
  for (const event of [...exactEvents, ...fallbackEvents]) {
    try {
      const payload = coingeckoPoolBatchRawSchema.parse(
        JSON.parse(decodeProviderPayload(event.payload, event.payload_encoding)),
      );
      const raw = poolRawForAddress(payload, network, poolAddress, tokenAddress);
      if (!raw) continue;
      const parsed = parsePool(raw, chain, tokenAddress);
      if (
        parsed.status === 'complete' &&
        sameChainAddress(chain, parsed.pool.poolAddress, poolAddress) &&
        sameChainAddress(chain, parsed.pool.tokenAddress, tokenAddress)
      )
        return parsed.pool;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function readOutcomeEntryCoverage(
  database: SqliteDatabase,
  signalId: number,
  pool: CanonicalPool,
): boolean | undefined {
  const addressClause =
    pool.chain === 'bsc' ? 'lower(pool_address) = lower(?)' : 'pool_address = ?';
  const events = database
    .prepare(
      `SELECT payload_encoding, payload
       FROM provider_events
       WHERE provider = 'runtime' AND capability = 'outcome.entry.coverage'
         AND chain = ? AND ${addressClause}
       ORDER BY observed_at DESC LIMIT 20`,
    )
    .all(pool.chain, pool.poolAddress) as Array<{
    payload_encoding: 'identity' | 'gzip';
    payload: Buffer;
  }>;
  for (const event of events) {
    try {
      const parsed = JSON.parse(
        decodeProviderPayload(event.payload, event.payload_encoding),
      ) as Record<string, unknown>;
      if (parsed.signalId === signalId && typeof parsed.complete === 'boolean')
        return parsed.complete;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function recordOutcomeEntryCoverage(
  database: SqliteDatabase,
  budget: WriteBudget,
  signalId: number,
  pool: CanonicalPool,
  complete: boolean,
  observedAt: number,
): void {
  insertProviderEvent(
    database,
    {
      provider: 'runtime',
      capability: 'outcome.entry.coverage',
      chain: pool.chain,
      tokenAddress: pool.tokenAddress,
      poolAddress: pool.poolAddress,
      observedAt,
      schemaVersion: 'runtime.outcome.entry.coverage.v1',
      payload: JSON.stringify({ signalId, complete, observedAt }),
    },
    budget,
  );
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

function decodeProviderPayload(payload: Buffer, encoding: 'identity' | 'gzip'): string {
  return (encoding === 'gzip' ? gunzipSync(payload) : payload).toString('utf8');
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
    try {
      parseDecimalString(row.token_amount, { nonNegative: true });
      parseDecimalString(row.quote_amount, { nonNegative: true });
      parseDecimalString(row.price_usd, { nonNegative: true });
    } catch {
      return [];
    }
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

function dedupePools<
  T extends { chain: 'sol' | 'bsc'; token_address: string; pool_address: string },
>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.chain}:${row.chain === 'bsc' ? row.pool_address.toLowerCase() : row.pool_address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createCandidatePoolBatches<
  T extends { chain: 'sol' | 'bsc'; token_address: string; pool_address: string },
>(rows: T[], chain: 'sol' | 'bsc', maxPoolsPerBatch = 50): T[][] {
  const uniquePools = dedupePools(rows.filter((row) => row.chain === chain));
  return chunkCoinGeckoPools(uniquePools, maxPoolsPerBatch).map((poolBatch) => {
    const addresses = new Set(
      poolBatch.map((row) => (chain === 'bsc' ? row.pool_address.toLowerCase() : row.pool_address)),
    );
    return rows.filter(
      (row) =>
        row.chain === chain &&
        addresses.has(chain === 'bsc' ? row.pool_address.toLowerCase() : row.pool_address),
    );
  });
}

export function groupLevel1RowsByWorkKind<
  T extends {
    chain: 'sol' | 'bsc';
    pool_address: string;
    status: string;
    funnel_status: string;
  },
>(rows: T[], chain: 'sol' | 'bsc'): Record<'candidate_batch' | 'armed_batch' | 'recheck', T[]> {
  const priority = { armed_batch: 0, candidate_batch: 1, recheck: 2 } as const;
  const poolKinds = new Map<string, keyof typeof priority>();
  for (const row of rows) {
    if (row.chain !== chain) continue;
    const poolKey = chain === 'bsc' ? row.pool_address.toLowerCase() : row.pool_address;
    const kind = ['armed', 'confirmed-pending-anchor'].includes(row.status)
      ? 'armed_batch'
      : ['level1_screened', 'level1_checked'].includes(row.funnel_status)
        ? 'recheck'
        : 'candidate_batch';
    const current = poolKinds.get(poolKey);
    if (current === undefined || priority[kind] < priority[current]) poolKinds.set(poolKey, kind);
  }
  const groups: Record<keyof typeof priority, T[]> = {
    candidate_batch: [],
    armed_batch: [],
    recheck: [],
  };
  for (const row of rows) {
    if (row.chain !== chain) continue;
    const poolKey = chain === 'bsc' ? row.pool_address.toLowerCase() : row.pool_address;
    const kind = poolKinds.get(poolKey);
    if (kind) groups[kind].push(row);
  }
  return groups;
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
