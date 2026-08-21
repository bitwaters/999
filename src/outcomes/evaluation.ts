import { Decimal } from 'decimal.js';
import type { SqliteDatabase } from '../persistence/db.js';
import { boundedWrite, type WriteBudget } from '../persistence/write-budget.js';
import type { NormalizedTrade } from '../market-data/g2.js';
import { parseDecimalString, parseInteger, parseTimestampMs } from '../providers/parsing.js';

export type Candle = {
  chain: 'sol' | 'bsc';
  poolAddress: string;
  tokenAddress: string;
  targetSide: 'base' | 'quote';
  intervalSeconds: 30;
  openTime: number;
  revision: number;
  observedAt: number;
  isClosed: boolean;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
};

export type CandleIngestResult = { action: 'inserted' | 'deduped' | 'revision'; candle: Candle };

export class CandleRevisionStore {
  private readonly records = new Map<string, Candle[]>();

  ingest(candle: Candle): CandleIngestResult {
    validateCandle(candle);
    const key = candleKey(candle);
    const revisions = this.records.get(key) ?? [];
    const latest = revisions[revisions.length - 1];
    if (latest && sameCandleValues(latest, candle)) return { action: 'deduped', candle: latest };
    const next = { ...candle, revision: revisions.length };
    revisions.push(next);
    this.records.set(key, revisions);
    return { action: revisions.length === 1 ? 'inserted' : 'revision', candle: next };
  }

  latestAtCutoff(candleIdentity: string, cutoff: number): Candle | undefined {
    const revisions = this.records.get(candleIdentity) ?? [];
    return revisions
      .filter((candle) => candle.isClosed && candle.observedAt <= cutoff)
      .sort((left, right) => left.observedAt - right.observedAt || left.revision - right.revision)
      .at(-1);
  }

  all(): Candle[] {
    return [...this.records.values()].flat().map((candle) => ({ ...candle }));
  }
}

export type EntrySelection =
  | {
      status: 'executable';
      trade: NormalizedTrade;
      deliveryToEntryLatencyMs: number;
      transportDelayMs: number;
    }
  | { status: 'not_found' }
  | { status: 'incomplete'; reason: string };

export function selectEntry(input: {
  trades: readonly NormalizedTrade[];
  chain: 'sol' | 'bsc';
  poolAddress: string;
  tokenAddress: string;
  anchorDeliveredAt: number;
  now: number;
  entryTimeoutSeconds: number;
  maxTransportDelaySeconds: number;
  maxFutureSkewSeconds: number;
  anchorToleranceSeconds: number;
}): EntrySelection {
  const relevantWindow = input.trades.filter(
    (trade) =>
      trade.chain === input.chain &&
      trade.poolAddress === input.poolAddress &&
      trade.tokenAddress === input.tokenAddress &&
      trade.observedAt >= input.anchorDeliveredAt &&
      trade.observedAt <= input.anchorDeliveredAt + input.entryTimeoutSeconds * 1000,
  );
  const relevant = relevantWindow.filter(
    (trade) => trade.dedupStatus === 'unique' && trade.ambiguityStatus === 'none',
  );
  const invalidTime = relevant.some(
    (trade) =>
      trade.observedAt - trade.eventAt > input.maxTransportDelaySeconds * 1000 ||
      trade.eventAt - trade.observedAt > input.maxFutureSkewSeconds * 1000 ||
      trade.eventAt < input.anchorDeliveredAt - input.anchorToleranceSeconds * 1000,
  );
  const candidates = relevant.filter(
    (trade) =>
      trade.observedAt - trade.eventAt <= input.maxTransportDelaySeconds * 1000 &&
      trade.eventAt - trade.observedAt <= input.maxFutureSkewSeconds * 1000 &&
      trade.eventAt >= input.anchorDeliveredAt - input.anchorToleranceSeconds * 1000,
  );
  if (candidates.length === 0) {
    if (input.now < input.anchorDeliveredAt + input.entryTimeoutSeconds * 1000)
      return { status: 'incomplete', reason: 'entry:timeout_not_reached' };
    if (relevantWindow.length > relevant.length)
      return { status: 'incomplete', reason: 'entry:ambiguous_duplicate' };
    return invalidTime
      ? { status: 'incomplete', reason: 'entry:time_integrity' }
      : { status: 'not_found' };
  }
  const trade = [...candidates].sort(
    (left, right) => left.observedAt - right.observedAt || left.eventAt - right.eventAt,
  )[0]!;
  return {
    status: 'executable',
    trade,
    deliveryToEntryLatencyMs: trade.observedAt - input.anchorDeliveredAt,
    transportDelayMs: trade.observedAt - trade.eventAt,
  };
}

export type HorizonResult = {
  horizonSeconds: number;
  evaluationCutoff: number;
  status: 'complete' | 'late_entry' | 'incomplete';
  reason?: string;
  forwardReturn?: string;
  mfe?: string;
  mae?: string;
};

export function evaluateHorizon(input: {
  anchorDeliveredAt: number;
  horizonSeconds: number;
  outcomeMaxLatenessSeconds: number;
  entry?: { observedAt: number; priceUsd: string };
  candles: readonly Candle[];
  entryPartial?: { highPrice: string; lowPrice: string; complete: boolean };
}): HorizonResult {
  const evaluationCutoff =
    input.anchorDeliveredAt + (input.horizonSeconds + input.outcomeMaxLatenessSeconds) * 1000;
  const horizonEnd = input.anchorDeliveredAt + input.horizonSeconds * 1000;
  if (!input.entry)
    return {
      horizonSeconds: input.horizonSeconds,
      evaluationCutoff,
      status: 'incomplete',
      reason: 'entry:missing',
    };
  if (input.entry.observedAt > horizonEnd)
    return {
      horizonSeconds: input.horizonSeconds,
      evaluationCutoff,
      status: 'late_entry',
      reason: 'entry:after_horizon',
    };
  let entryPrice: Decimal;
  try {
    entryPrice = parsePositive(input.entry.priceUsd);
    input.candles.forEach(validateCandle);
  } catch {
    return {
      horizonSeconds: input.horizonSeconds,
      evaluationCutoff,
      status: 'incomplete',
      reason: 'entry:invalid_price',
    };
  }
  const eligible = input.candles
    .filter(
      (candle) =>
        candle.isClosed &&
        candle.observedAt <= evaluationCutoff &&
        candle.openTime + candle.intervalSeconds * 1000 >= horizonEnd &&
        candle.openTime + candle.intervalSeconds * 1000 <=
          horizonEnd + input.outcomeMaxLatenessSeconds * 1000,
    )
    .sort((left, right) => left.openTime - right.openTime || left.observedAt - right.observedAt);
  const close = selectLatestRevisionForIdentity(eligible);
  if (!close)
    return {
      horizonSeconds: input.horizonSeconds,
      evaluationCutoff,
      status: 'incomplete',
      reason: 'candle:missing_evaluation_close',
    };
  const pathCandles = input.candles.filter(
    (candle) =>
      candle.isClosed &&
      candle.observedAt <= evaluationCutoff &&
      candle.openTime >= input.entry!.observedAt &&
      candle.openTime + candle.intervalSeconds * 1000 <= horizonEnd,
  );
  const partial = input.entryPartial;
  const candleIntervalMs = 30 * 1000;
  const entryOnBoundary = input.entry.observedAt % candleIntervalMs === 0;
  if (!entryOnBoundary && !partial)
    return {
      horizonSeconds: input.horizonSeconds,
      evaluationCutoff,
      status: 'incomplete',
      reason: 'entry_partial:missing',
    };
  if (partial && !partial.complete)
    return {
      horizonSeconds: input.horizonSeconds,
      evaluationCutoff,
      status: 'incomplete',
      reason: 'entry_partial:incomplete',
    };
  try {
    const latestPathCandles = selectLatestRevisions(pathCandles);
    const firstFullCandle = entryOnBoundary
      ? input.entry.observedAt
      : Math.ceil(input.entry.observedAt / candleIntervalMs) * candleIntervalMs;
    for (let openTime = firstFullCandle; openTime < horizonEnd; openTime += candleIntervalMs) {
      if (!latestPathCandles.some((candle) => candle.openTime === openTime))
        return {
          horizonSeconds: input.horizonSeconds,
          evaluationCutoff,
          status: 'incomplete',
          reason: 'path:missing_complete_coverage',
        };
    }
    const highs = latestPathCandles.map((candle) => parsePositive(candle.highPrice));
    const lows = latestPathCandles.map((candle) => parsePositive(candle.lowPrice));
    if (partial) {
      const partialHigh = parsePositive(partial.highPrice);
      const partialLow = parsePositive(partial.lowPrice);
      if (partialHigh.lessThan(partialLow)) throw new Error('Invalid entry partial range');
      highs.push(partialHigh);
      lows.push(partialLow);
    }
    if (highs.length === 0 || lows.length === 0)
      return {
        horizonSeconds: input.horizonSeconds,
        evaluationCutoff,
        status: 'incomplete',
        reason: 'path:missing_complete_coverage',
      };
    const high = highs.reduce((max, value) => (value.greaterThan(max) ? value : max));
    const low = lows.reduce((min, value) => (value.lessThan(min) ? value : min));
    return {
      horizonSeconds: input.horizonSeconds,
      evaluationCutoff,
      status: 'complete',
      forwardReturn: parsePositive(close.closePrice).div(entryPrice).minus(1).toString(),
      mfe: high.div(entryPrice).minus(1).toString(),
      mae: low.div(entryPrice).minus(1).toString(),
    };
  } catch {
    return {
      horizonSeconds: input.horizonSeconds,
      evaluationCutoff,
      status: 'incomplete',
      reason: 'candle:invalid_price',
    };
  }
}

export type ExecutionStatus = 'executable' | 'not_executable' | 'incomplete';

export function evaluateExecution(input: {
  entry: EntrySelection;
  g2CoverageComplete: boolean;
  restCoverageComplete: boolean;
  restConflict: boolean;
}): { status: ExecutionStatus; reason: string } {
  if (!input.g2CoverageComplete)
    return {
      status: 'incomplete',
      reason: 'evidence:g2_coverage',
    };
  if (input.entry.status === 'executable') {
    if (input.restConflict) return { status: 'incomplete', reason: 'evidence:rest_g2_conflict' };
    return { status: 'executable', reason: 'entry:found' };
  }
  if (!input.restCoverageComplete || input.restConflict)
    return {
      status: 'incomplete',
      reason: input.restConflict ? 'evidence:rest_g2_conflict' : 'evidence:coverage',
    };
  if (input.entry.status === 'incomplete')
    return { status: 'incomplete', reason: input.entry.reason };
  return { status: 'not_executable', reason: 'entry:not_found_before_timeout' };
}

export function insertOutcome(
  database: SqliteDatabase,
  input: {
    signalId: number;
    configVersionId: number;
    anchorDestination: 'admin_private' | 'channel' | 'group';
    anchorDeliveredAt: number;
    executionStatus: ExecutionStatus;
    executionReason: string;
    entryEventId?: number;
    entryObservedAt?: number;
    deliveryToEntryLatencyMs?: number;
    entryPrice?: string;
    deliveryDrift?: string;
    preSendDrift?: string;
    horizonResults: readonly HorizonResult[];
    createdAt: number;
    budget: WriteBudget;
  },
): number {
  return boundedWrite(database, input.budget, (context) => {
    const result = database
      .prepare(
        `INSERT INTO outcomes
         (signal_id, config_version_id, anchor_destination, anchor_delivered_at, execution_status, execution_reason,
          entry_event_id, entry_observed_at, delivery_to_entry_latency_ms, entry_price, delivery_drift,
          pre_send_drift, horizon_results_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.signalId,
        input.configVersionId,
        input.anchorDestination,
        input.anchorDeliveredAt,
        input.executionStatus,
        input.executionReason,
        input.entryEventId ?? null,
        input.entryObservedAt ?? null,
        input.deliveryToEntryLatencyMs ?? null,
        input.entryPrice ?? null,
        input.deliveryDrift ?? null,
        input.preSendDrift ?? null,
        JSON.stringify(input.horizonResults),
        input.createdAt,
        input.createdAt,
      );
    context.addRows(1);
    return Number(result.lastInsertRowid);
  }).value;
}

function candleKey(candle: Candle): string {
  return [
    candle.chain,
    candle.poolAddress,
    candle.tokenAddress,
    candle.targetSide,
    candle.intervalSeconds,
    candle.openTime,
  ].join(':');
}

function sameCandleValues(left: Candle, right: Candle): boolean {
  return (
    left.isClosed === right.isClosed &&
    left.openPrice === right.openPrice &&
    left.highPrice === right.highPrice &&
    left.lowPrice === right.lowPrice &&
    left.closePrice === right.closePrice &&
    left.volume === right.volume
  );
}

function validateCandle(candle: Candle): void {
  if (candle.intervalSeconds !== 30) throw new Error('Invalid candle interval');
  parseTimestampMs(candle.openTime);
  parseTimestampMs(candle.observedAt);
  parseInteger(candle.revision, { min: 0 });
  const open = parsePositive(candle.openPrice);
  const high = parsePositive(candle.highPrice);
  const low = parsePositive(candle.lowPrice);
  const close = parsePositive(candle.closePrice);
  if (
    high.lessThan(open) ||
    high.lessThan(close) ||
    low.greaterThan(open) ||
    low.greaterThan(close)
  )
    throw new Error('Invalid OHLC relationship');
  parseDecimalString(candle.volume, { nonNegative: true });
}

function selectLatestRevisions(candles: readonly Candle[]): Candle[] {
  const groups = new Map<string, Candle>();
  for (const candle of candles) {
    const key = candleKey(candle);
    const current = groups.get(key);
    if (
      !current ||
      candle.observedAt > current.observedAt ||
      (candle.observedAt === current.observedAt && candle.revision > current.revision)
    )
      groups.set(key, candle);
  }
  return [...groups.values()];
}

function selectLatestRevisionForIdentity(candles: readonly Candle[]): Candle | undefined {
  return selectLatestRevisions(candles).sort(
    (left, right) => left.openTime - right.openTime || left.observedAt - right.observedAt,
  )[0];
}

function parsePositive(value: string): Decimal {
  const parsed = parseDecimalString(value, { nonNegative: true });
  if (parsed.isZero()) throw new Error('Price must be positive');
  return parsed;
}
