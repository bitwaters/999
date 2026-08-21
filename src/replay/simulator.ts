import { Decimal } from 'decimal.js';
import type { BotConfig } from '../config/schema.js';
import { evaluateBscSafety, evaluateSolSafety, type SafetyResult } from '../domain/safety.js';
import { aggregateG2Window, TradeDeduper, hashG2Message, normalizeG2Item, type NormalizedTrade } from '../market-data/g2.js';
import { parseLevel1Snapshot, type Level1Snapshot } from '../market-data/level1.js';
import { parsePool, selectPrimaryPool, type CanonicalPool } from '../market-data/pools.js';
import { evaluateDispatchGuard, type SignalSnapshot } from '../pipeline/ace.js';
import type { CandidateCycle, DiscoveryObservation } from '../pipeline/candidate.js';
import { orchestrateSignal } from '../pipeline/signal-orchestrator.js';
import {
  CandleRevisionStore,
  evaluateExecution,
  evaluateHorizon,
  selectEntry,
  type Candle,
} from '../outcomes/evaluation.js';
import {
  latestTradeAt,
  level1RawForPool,
  parseCoinGeckoOhlcv30s,
  poolAttributesForAddress,
  poolRawForAddress,
  poolRawsForToken,
  toCandle,
} from '../providers/coingecko-adapter.js';
import { evaluateCandidateAttention } from '../pipeline/candidate-attention.js';
import { rebuildCandidateCycles, type ReplayEvidence } from './timeline.js';

export type SimulatedReplayResult = {
  key: string;
  sourceLiveCandidateIds: number[];
  simulatedSignal: Record<string, unknown>;
  outcome: Record<string, unknown>;
  completenessStatus: 'full' | 'partial' | 'unavailable';
};

export function simulateReplay(input: {
  config: BotConfig;
  configVersionId: number;
  dataStartAt?: number;
  dataEndAt?: number;
  dataCutoffAt: number;
  deliveryDelayMs: number;
  discovery: readonly DiscoveryObservation[];
  evidence: readonly ReplayEvidence[];
}): SimulatedReplayResult[] {
  const dataStartAt = input.dataStartAt ?? 0;
  const dataEndAt = input.dataEndAt ?? input.dataCutoffAt;
  if (dataEndAt > input.dataCutoffAt) throw new Error('Replay data end is after cutoff');
  if (dataStartAt > dataEndAt) throw new Error('Replay data start is after data end');
  const cycles = (['sol', 'bsc'] as const)
    .flatMap((chain) =>
      rebuildCandidateCycles(
        input.discovery.filter((item) => item.chain === chain),
        input.config.chains[chain].discovery.candidate_ttl_seconds,
        input.dataCutoffAt,
      ),
    )
    .filter((cycle) => cycle.firstSeenAt <= dataEndAt)
    .sort(
      (left, right) =>
        left.cycleStartedAt - right.cycleStartedAt || left.key.localeCompare(right.key),
    );
  const cooldowns = new Map<string, number>();
  return cycles.flatMap((cycle) => {
    const result = simulateCycle({
      ...input,
      dataStartAt,
      dataEndAt,
      cycle,
      cooldowns,
    });
    return result ? [result] : [];
  });
}

function simulateCycle(input: {
  config: BotConfig;
  configVersionId: number;
  dataStartAt: number;
  dataEndAt: number;
  dataCutoffAt: number;
  deliveryDelayMs: number;
  cycle: CandidateCycle;
  evidence: readonly ReplayEvidence[];
  cooldowns: Map<string, number>;
}): SimulatedReplayResult | undefined {
  const key = `${input.cycle.key}:${input.cycle.cycleStartedAt}`;
  const overlapsResultWindow =
    input.cycle.lastSeenAt + chainConfig(input).discovery.candidate_ttl_seconds * 1000 >=
    input.dataStartAt;
  const relevant = input.evidence.filter(
    (item) =>
      item.observedAt >= input.cycle.cycleStartedAt &&
      item.observedAt <= input.dataCutoffAt &&
      (item.chain === undefined || item.chain === input.cycle.chain) &&
      (item.tokenAddress === undefined || sameToken(input.cycle.chain, item.tokenAddress, input.cycle.tokenAddress)),
  );
  const resolvedPool = resolveFixedPool(input.cycle, relevant);
  if (!resolvedPool)
    return overlapsResultWindow
      ? unavailable(key, 'pool:unavailable', {
          cycleStartedAt: input.cycle.cycleStartedAt,
          cycleLastSeenAt: input.cycle.lastSeenAt,
        })
      : undefined;

  const { pool } = resolvedPool;
  const normalizedTrades = normalizeTrades(relevant, pool, input.dataCutoffAt);
  if (normalizedTrades.length === 0)
    return overlapsResultWindow
      ? unavailable(key, 'g2:unavailable', { poolAddress: pool.poolAddress })
      : undefined;

  let lastBlocked: Record<string, unknown> = { reasons: ['signal:not_evaluated'] };
  let evidenceIncomplete = false;
  for (const confirmationAt of [...new Set(normalizedTrades.map((trade) => trade.observedAt))].sort(
    (left, right) => left - right,
  )) {
    if (confirmationAt > input.dataEndAt) break;
    if (confirmationAt < resolvedPool.observedAt) continue;
    const inResultWindow = confirmationAt >= input.dataStartAt;
    if (confirmationAt > input.cycle.lastSeenAt + chainConfig(input).discovery.candidate_ttl_seconds * 1000)
      break;
    const safety = safetyAt(input, relevant, confirmationAt);
    const level1 = level1At(relevant, pool, confirmationAt);
    const previousLevel1 = previousLevel1At(relevant, pool, confirmationAt);
    if (!safety || !level1 || !previousLevel1) {
      if (inResultWindow) evidenceIncomplete = true;
      lastBlocked = {
        confirmedAt: confirmationAt,
        reasons: [
          ...(safety ? [] : ['safety:unavailable']),
          ...(level1 ? [] : ['level1:unavailable']),
          ...(previousLevel1 ? [] : ['entry_quality:missing_price_baseline']),
        ],
      };
      continue;
    }
    const windowEnd = Math.floor(confirmationAt / 30_000) * 30_000;
    let g2 = aggregateG2Window(
      normalizedTrades.filter((trade) => trade.observedAt <= confirmationAt),
      windowEnd - 30_000,
      windowEnd,
      confirmationAt,
    );
    if (!hasG2Coverage(input, relevant, pool, windowEnd - 30_000, windowEnd)) {
      g2 = { ...g2, status: 'partial' };
      if (inResultWindow) evidenceIncomplete = true;
    }
    const attention = evaluateCandidateAttention(
      input.cycle.evidence.filter((item) => item.observedAt <= confirmationAt),
      input.config.strategies.emerging_breakout.attention,
    );
    const cooldownUntil = input.cooldowns.get(input.cycle.key);
    let priceExtension: string;
    try {
      priceExtension = upwardExtension(level1.priceUsd, previousLevel1.priceUsd);
    } catch {
      if (inResultWindow) evidenceIncomplete = true;
      lastBlocked = {
        confirmedAt: confirmationAt,
        reasons: ['entry_quality:invalid_price_baseline'],
      };
      continue;
    }
    const decision = orchestrateSignal(
      {
        candidateKey: input.cycle.key,
        chain: pool.chain,
        tokenAddress: pool.tokenAddress,
        poolAddress: pool.poolAddress,
        poolCreatedAt: pool.poolCreatedAt,
        cycleStartedAt: input.cycle.cycleStartedAt,
        confirmedAt: confirmationAt,
        configVersionId: String(input.configVersionId),
        safety,
        level1,
        g2,
        candidateFresh: candidateFreshAt(input, confirmationAt),
        poolStable: level1.poolStatus === 'stable',
        priceExtension,
        preSendDrift: '0',
        attention,
        ...(cooldownUntil === undefined ? {} : { anchorCooldownUntil: cooldownUntil }),
      },
      input.config,
    );
    if (decision.status !== 'pass') {
      if (inResultWindow && decision.reasons.some(isIncompleteReason)) evidenceIncomplete = true;
      lastBlocked = { confirmedAt: confirmationAt, reasons: decision.reasons };
      continue;
    }
    const deliveredAt = confirmationAt + input.deliveryDelayMs;
    const delivered = dispatchAt(input, relevant, pool, normalizedTrades, decision.snapshot, deliveredAt);
    if (delivered.status !== 'send')
      return confirmationAt < input.dataStartAt
        ? undefined
        : {
            key,
            sourceLiveCandidateIds: [],
            simulatedSignal: {
              status: 'dispatch_cancelled',
              snapshot: decision.snapshot,
              simulatedDeliveredAt: deliveredAt,
              reason: delivered.reason,
            },
            outcome: { status: 'unavailable', reason: 'anchor:not_delivered' },
            completenessStatus: 'partial',
          };
    input.cooldowns.set(
      input.cycle.key,
      confirmationAt + input.config.strategies.emerging_breakout.cooldown_seconds * 1000,
    );
    if (confirmationAt < input.dataStartAt) return undefined;
    return deliveredOutcome(input, relevant, pool, normalizedTrades, decision.snapshot, deliveredAt, delivered.preSendDrift);
  }
  if (!overlapsResultWindow) return undefined;
  return {
    key,
    sourceLiveCandidateIds: [],
    simulatedSignal: { status: 'blocked', ...lastBlocked },
    outcome: { status: 'unavailable', reason: 'signal:not_confirmed' },
    completenessStatus:
      !evidenceIncomplete && hasCoreEvidence(input, relevant, pool) ? 'full' : 'partial',
  };
}

function chainConfig(input: { config: BotConfig; cycle: CandidateCycle }) {
  return input.config.chains[input.cycle.chain];
}

function candidateFreshAt(
  input: { config: BotConfig; cycle: CandidateCycle },
  at: number,
): boolean {
  const lastSeenAt = input.cycle.evidence
    .filter((item) => item.observedAt <= at)
    .reduce((latest, item) => Math.max(latest, item.observedAt), input.cycle.firstSeenAt);
  return at >= lastSeenAt && at - lastSeenAt <= chainConfig(input).discovery.candidate_ttl_seconds * 1000;
}

function hasG2Coverage(
  input: { config: BotConfig; cycle: CandidateCycle },
  evidence: readonly ReplayEvidence[],
  pool: CanonicalPool,
  windowStart: number,
  windowEnd: number,
): boolean {
  const level1 = level1At(evidence, pool, windowStart);
  if (
    !level1 ||
    level1.observedAt +
      input.config.chains[pool.chain].level1.buyers_freshness_seconds * 1000 <
      windowEnd
  )
    return false;
  const attention = evaluateCandidateAttention(
    input.cycle.evidence.filter((item) => item.observedAt <= windowStart),
    input.config.strategies.emerging_breakout.attention,
  );
  return attention.status === 'pass' && candidateFreshAt(input, windowEnd);
}

function resolveFixedPool(
  cycle: CandidateCycle,
  evidence: readonly ReplayEvidence[],
): { pool: CanonicalPool; observedAt: number } | undefined {
  const network = cycle.chain === 'sol' ? 'solana' : 'bsc';
  for (const item of evidence.filter((event) => event.kind === 'pool').sort(byObservedAt)) {
    const pools = poolRawsForToken(asRecord(item.payload), network, cycle.tokenAddress)
      .map((raw) => parsePool(raw, cycle.chain, cycle.tokenAddress))
      .flatMap((result) => (result.status === 'complete' ? [result.pool] : []));
    const selected = selectPrimaryPool(pools);
    if (selected.status === 'resolved') return { pool: selected.pool, observedAt: item.observedAt };
  }
  return undefined;
}

function safetyAt(
  input: { config: BotConfig; configVersionId: number; cycle: CandidateCycle },
  evidence: readonly ReplayEvidence[],
  at: number,
): SafetyResult | undefined {
  const event = evidence
    .filter((item) => item.kind === 'safety' && item.observedAt <= at)
    .sort(byObservedAt)
    .at(-1);
  if (!event) return undefined;
  const context = {
    checkedAt: event.observedAt,
    providerEventId: `replay:${event.observedAt}`,
    configVersionId: String(input.configVersionId),
  };
  return input.cycle.chain === 'sol'
    ? evaluateSolSafety(asRecord(event.payload), input.config.chains.sol.safety, context)
    : evaluateBscSafety(asRecord(event.payload), input.config.chains.bsc.safety, context);
}

function level1Snapshots(
  evidence: readonly ReplayEvidence[],
  pool: CanonicalPool,
  at: number,
): Level1Snapshot[] {
  const network = pool.chain === 'sol' ? 'solana' : 'bsc';
  const tradeEvents = evidence
    .filter(
      (item) =>
        item.kind === 'trades' &&
        item.observedAt <= at &&
        item.poolAddress !== undefined &&
        sameToken(pool.chain, item.poolAddress, pool.poolAddress),
    )
    .sort(byObservedAt);
  const poolEvents = evidence
    .filter((item) => item.kind === 'level1' && item.observedAt <= at)
    .sort(byObservedAt);
  return poolEvents.flatMap((poolEvent, index) => {
      const nextPoolObservedAt = poolEvents[index + 1]?.observedAt ?? Number.POSITIVE_INFINITY;
      const tradeEvent = tradeEvents.find(
        (item) =>
          item.observedAt >= poolEvent.observedAt && item.observedAt < nextPoolObservedAt,
      );
      if (!tradeEvent) return [];
      const raw = poolRawForAddress(
        asRecord(poolEvent.payload),
        network,
        pool.poolAddress,
        pool.tokenAddress,
      );
      if (!raw) return [];
      const observedAt = Math.max(poolEvent.observedAt, tradeEvent.observedAt);
      const parsed = parseLevel1Snapshot(
        level1RawForPool(
          raw,
          pool,
          poolAttributesForAddress(asRecord(poolEvent.payload), network, pool.poolAddress),
          observedAt,
          latestTradeAt(asRecord(tradeEvent.payload)),
        ),
        pool,
        observedAt,
      );
      return parsed.status === 'complete' ? [parsed.snapshot] : [];
    });
}

function level1At(evidence: readonly ReplayEvidence[], pool: CanonicalPool, at: number) {
  return level1Snapshots(evidence, pool, at).at(-1);
}

function previousLevel1At(evidence: readonly ReplayEvidence[], pool: CanonicalPool, at: number) {
  return level1Snapshots(evidence, pool, at).at(-2);
}

function normalizeTrades(
  evidence: readonly ReplayEvidence[],
  pool: CanonicalPool,
  at: number,
): NormalizedTrade[] {
  const deduper = new TradeDeduper();
  const trades: NormalizedTrade[] = [];
  for (const item of evidence.filter((event) => event.kind === 'g2' && event.observedAt <= at).sort(byObservedAt)) {
    const raw = asRecord(item.payload);
    if (typeof raw.pa !== 'string' || !sameToken(pool.chain, raw.pa, pool.poolAddress)) continue;
    const parsed = normalizeG2Item(raw, pool, item.observedAt);
    if (parsed.status !== 'complete') continue;
    trades.push(...deduper.ingest(hashG2Message(raw), [parsed.trade]).trades);
  }
  return trades;
}

function dispatchAt(
  input: { config: BotConfig; configVersionId: number; cycle: CandidateCycle },
  evidence: readonly ReplayEvidence[],
  pool: CanonicalPool,
  trades: readonly NormalizedTrade[],
  signal: SignalSnapshot,
  deliveredAt: number,
) {
  const safety = safetyAt(input, evidence, deliveredAt);
  const level1 = level1At(evidence, pool, deliveredAt);
  if (!safety || !level1) return { status: 'cancel' as const, reason: 'dispatch:evidence_unavailable' };
  const windowEnd = Math.floor(signal.confirmedAt / 30_000) * 30_000;
  const g2 = aggregateG2Window(
    trades.filter((trade) => trade.observedAt <= deliveredAt),
    windowEnd - 30_000,
    windowEnd,
    deliveredAt,
  );
  const coveredG2 = hasG2Coverage(
    input,
    evidence,
    pool,
    windowEnd - 30_000,
    windowEnd,
  );
  return evaluateDispatchGuard({
    signal,
    now: deliveredAt,
    safety,
    latestPoolStable: level1.poolStatus === 'stable',
    latestPoolFresh:
      deliveredAt - level1.observedAt <=
      input.config.chains[pool.chain].level1.buyers_freshness_seconds * 1000,
    latestG2State: coveredG2 ? g2.status : 'partial',
    latestPriceUsd: level1.priceUsd,
    maxPreSendDrift: String(
      input.config.strategies.emerging_breakout.entry_quality.max_pre_send_drift,
    ),
  });
}

function deliveredOutcome(
  input: {
    config: BotConfig;
    dataCutoffAt: number;
    cycle: CandidateCycle;
  },
  evidence: readonly ReplayEvidence[],
  pool: CanonicalPool,
  trades: readonly NormalizedTrade[],
  signal: SignalSnapshot,
  deliveredAt: number,
  preSendDrift: string,
): SimulatedReplayResult {
  const entry = selectEntry({
    trades,
    chain: pool.chain,
    poolAddress: pool.poolAddress,
    tokenAddress: pool.tokenAddress,
    anchorDeliveredAt: deliveredAt,
    now: input.dataCutoffAt,
    entryTimeoutSeconds: input.config.outcomes.entry_timeout_seconds,
    maxTransportDelaySeconds: input.config.outcomes.entry_max_event_delay_seconds,
    maxFutureSkewSeconds: input.config.outcomes.max_future_event_skew_seconds,
    anchorToleranceSeconds: input.config.outcomes.entry_max_event_delay_seconds,
  });
  const candles = replayCandles(evidence, pool, input.dataCutoffAt);
  const selected = entry.status === 'executable' ? entry.trade : undefined;
  const maxHorizon = Math.max(...input.config.outcomes.horizons_seconds);
  const finalCutoff =
    deliveredAt +
    (maxHorizon + input.config.outcomes.outcome_max_lateness_seconds) * 1000;
  const restComplete = hasCandleCoverage(candles, deliveredAt, deliveredAt + maxHorizon * 1000);
  const execution = evaluateExecution({
    entry,
    // Raw trade messages prove a found entry, but silence alone cannot prove uninterrupted
    // WebSocket coverage. Missing-entry replay therefore remains incomplete conservatively.
    g2CoverageComplete: selected !== undefined,
    restCoverageComplete: restComplete,
    restConflict: selected ? !candleContainsTrade(candles, selected, deliveredAt) : false,
  });
  const entryPartial = selected ? partialFromTrades(selected, trades) : undefined;
  const horizons = input.config.outcomes.horizons_seconds.map((horizonSeconds) =>
    evaluateHorizon({
      anchorDeliveredAt: deliveredAt,
      horizonSeconds,
      outcomeMaxLatenessSeconds: input.config.outcomes.outcome_max_lateness_seconds,
      ...(selected ? { entry: { observedAt: selected.observedAt, priceUsd: selected.priceUsd } } : {}),
      candles,
      ...(entryPartial ? { entryPartial } : {}),
    }),
  );
  const evaluationComplete =
    execution.status === 'not_executable' ||
    (execution.status === 'executable' && !horizons.some((item) => item.status === 'incomplete'));
  const completenessStatus =
    input.dataCutoffAt >= finalCutoff && evaluationComplete ? 'full' : 'partial';
  return {
    key: `${input.cycle.key}:${input.cycle.cycleStartedAt}`,
    sourceLiveCandidateIds: [],
    simulatedSignal: {
      status: 'delivered',
      snapshot: signal,
      simulatedDeliveredAt: deliveredAt,
      preSendDrift,
    },
    outcome: {
      status: completenessStatus,
      execution,
      ...(selected
        ? {
            entry: {
              observedAt: selected.observedAt,
              priceUsd: selected.priceUsd,
              deliveryToEntryLatencyMs: selected.observedAt - deliveredAt,
            },
          }
        : {}),
      horizons,
    },
    completenessStatus,
  };
}

function replayCandles(
  evidence: readonly ReplayEvidence[],
  pool: CanonicalPool,
  cutoff: number,
): Candle[] {
  const store = new CandleRevisionStore();
  for (const item of evidence
    .filter(
      (event) =>
        event.kind === 'ohlcv' &&
        event.observedAt <= cutoff &&
        event.poolAddress !== undefined &&
        sameToken(pool.chain, event.poolAddress, pool.poolAddress),
    )
    .sort(byObservedAt)) {
    for (const row of parseCoinGeckoOhlcv30s(asRecord(item.payload), pool, item.observedAt))
      store.ingest(toCandle(pool, row, item.observedAt, 0));
  }
  return store.all();
}

function hasCoreEvidence(
  input: {
    config: BotConfig;
    configVersionId: number;
    cycle: CandidateCycle;
    dataCutoffAt: number;
  },
  evidence: readonly ReplayEvidence[],
  pool: CanonicalPool,
): boolean {
  return Boolean(
    safetyAt(input, evidence, input.dataCutoffAt) &&
      level1At(evidence, pool, input.dataCutoffAt) &&
      evidence.some((item) => item.kind === 'g2'),
  );
}

function unavailable(
  key: string,
  reason: string,
  fields: Record<string, unknown>,
): SimulatedReplayResult {
  return {
    key,
    sourceLiveCandidateIds: [],
    simulatedSignal: { status: 'unavailable', reason, ...fields },
    outcome: { status: 'unavailable', reason },
    completenessStatus: 'unavailable',
  };
}

function upwardExtension(current: string, previous: string): string {
  const value = new Decimal(current);
  const baseline = new Decimal(previous);
  if (!value.isPositive() || !baseline.isPositive()) throw new Error('Invalid replay price baseline');
  const extension = value.div(baseline).minus(1);
  return extension.isNegative() ? '0' : extension.toString();
}

function partialFromTrades(entry: NormalizedTrade, trades: readonly NormalizedTrade[]) {
  if (entry.observedAt % 30_000 === 0) return undefined;
  const next = Math.ceil(entry.observedAt / 30_000) * 30_000;
  const prices = trades
    .filter(
      (trade) =>
        trade.observedAt >= entry.observedAt &&
        trade.observedAt < next &&
        trade.dedupStatus === 'unique' &&
        trade.ambiguityStatus === 'none',
    )
    .map((trade) => new Decimal(trade.priceUsd));
  if (prices.length === 0)
    return { highPrice: entry.priceUsd, lowPrice: entry.priceUsd, complete: false };
  return {
    highPrice: prices.reduce((max, value) => (value.greaterThan(max) ? value : max)).toString(),
    lowPrice: prices.reduce((min, value) => (value.lessThan(min) ? value : min)).toString(),
    complete: true,
  };
}

function hasCandleCoverage(candles: readonly Candle[], start: number, end: number): boolean {
  const available = new Set(candles.filter((item) => item.isClosed).map((item) => item.openTime));
  for (let at = Math.ceil(start / 30_000) * 30_000; at < end; at += 30_000)
    if (!available.has(at)) return false;
  return true;
}

function candleContainsTrade(
  candles: readonly Candle[],
  trade: NormalizedTrade,
  deliveredAt: number,
): boolean {
  const openTime = Math.floor(trade.eventAt / 30_000) * 30_000;
  if (openTime < Math.ceil(deliveredAt / 30_000) * 30_000) return true;
  const candle = candles
    .filter((item) => item.isClosed && item.openTime === openTime)
    .sort((left, right) => right.revision - left.revision)
    .at(0);
  if (!candle) return false;
  const price = new Decimal(trade.priceUsd);
  return price.greaterThanOrEqualTo(candle.lowPrice) && price.lessThanOrEqualTo(candle.highPrice);
}

function sameToken(chain: 'sol' | 'bsc', left: string, right: string): boolean {
  return chain === 'bsc' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function byObservedAt(left: ReplayEvidence, right: ReplayEvidence): number {
  return left.observedAt - right.observedAt;
}

function isIncompleteReason(reason: string): boolean {
  return /incomplete|missing|stale|not_fresh|invalid/u.test(reason);
}
