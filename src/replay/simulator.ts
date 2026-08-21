import { Decimal } from 'decimal.js';
import type { BotConfig } from '../config/schema.js';
import { evaluateBscSafety, evaluateSolSafety, type SafetyResult } from '../domain/safety.js';
import {
  aggregateG2Window,
  TradeDeduper,
  hashG2Message,
  normalizeG2Item,
  type NormalizedTrade,
} from '../market-data/g2.js';
import type { Level1Snapshot } from '../market-data/level1.js';
import {
  parseLevel1ScreeningSnapshot,
  promoteLevel1ScreeningSnapshot,
  type LastTradeEvidence,
} from '../market-data/level1-screening.js';
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
  level1ScreeningRawForPool,
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

type ReplayAdmission = { status: 'armed'; armedAt: number } | { status: 'blocked'; reason: string };

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
  const admissions = buildReplayAdmissions(
    {
      ...input,
      dataEndAt,
    },
    cycles,
  );
  return cycles.flatMap((cycle) => {
    const result = simulateCycle({
      ...input,
      dataStartAt,
      dataEndAt,
      cycle,
      cooldowns,
      admission: admissions.get(`${cycle.key}:${cycle.cycleStartedAt}`) ?? {
        status: 'blocked',
        reason: 'adaptive:admission_unavailable',
      },
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
  admission: ReplayAdmission;
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
      (item.tokenAddress === undefined ||
        sameToken(input.cycle.chain, item.tokenAddress, input.cycle.tokenAddress)),
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
  if (input.admission.status === 'blocked')
    return overlapsResultWindow
      ? unavailable(key, input.admission.reason, { poolAddress: pool.poolAddress })
      : undefined;
  const normalizedTrades = normalizeTrades(relevant, pool, input.dataCutoffAt);
  if (normalizedTrades.length === 0)
    return overlapsResultWindow
      ? unavailable(key, 'g2:unavailable', { poolAddress: pool.poolAddress })
      : undefined;

  let lastBlocked: Record<string, unknown> = { reasons: ['signal:not_evaluated'] };
  let evidenceIncomplete = false;
  let evaluatedInResultWindow = false;
  for (const confirmationAt of [...new Set(normalizedTrades.map((trade) => trade.observedAt))].sort(
    (left, right) => left - right,
  )) {
    if (confirmationAt > input.dataEndAt) break;
    if (confirmationAt < input.admission.armedAt) continue;
    if (confirmationAt < resolvedPool.observedAt) continue;
    const inResultWindow = confirmationAt >= input.dataStartAt;
    if (inResultWindow) evaluatedInResultWindow = true;
    if (
      confirmationAt >
      input.cycle.lastSeenAt + chainConfig(input).discovery.candidate_ttl_seconds * 1000
    )
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
    const delivered = dispatchAt(
      input,
      relevant,
      pool,
      normalizedTrades,
      decision.snapshot,
      deliveredAt,
    );
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
    return deliveredOutcome(
      input,
      relevant,
      pool,
      normalizedTrades,
      decision.snapshot,
      deliveredAt,
      delivered.preSendDrift,
    );
  }
  if (!overlapsResultWindow) return undefined;
  return {
    key,
    sourceLiveCandidateIds: [],
    simulatedSignal: { status: 'blocked', ...lastBlocked },
    outcome: { status: 'unavailable', reason: 'signal:not_confirmed' },
    completenessStatus:
      evaluatedInResultWindow && !evidenceIncomplete && hasCoreEvidence(input, relevant, pool)
        ? 'full'
        : 'partial',
  };
}

function buildReplayAdmissions(
  input: {
    config: BotConfig;
    configVersionId: number;
    dataEndAt: number;
    dataCutoffAt: number;
    evidence: readonly ReplayEvidence[];
  },
  cycles: readonly CandidateCycle[],
): Map<string, ReplayAdmission> {
  const result = new Map<string, ReplayAdmission>();
  const eligible: Array<{
    key: string;
    cycle: CandidateCycle;
    pool: CanonicalPool;
    screening: ReturnType<typeof parseLevel1ScreeningSnapshot> & { status: 'complete' };
    eligibleAt: number;
    expiresAt: number;
  }> = [];
  for (const cycle of cycles) {
    const key = `${cycle.key}:${cycle.cycleStartedAt}`;
    const expiresAt =
      cycle.lastSeenAt + input.config.chains[cycle.chain].discovery.candidate_ttl_seconds * 1000;
    const relevant = input.evidence.filter(
      (item) =>
        item.observedAt >= cycle.cycleStartedAt &&
        item.observedAt <= Math.min(input.dataEndAt, input.dataCutoffAt, expiresAt) &&
        (item.chain === undefined || item.chain === cycle.chain) &&
        (item.tokenAddress === undefined ||
          sameToken(cycle.chain, item.tokenAddress, cycle.tokenAddress)),
    );
    const resolved = resolveFixedPool(cycle, relevant);
    if (!resolved) {
      result.set(key, { status: 'blocked', reason: 'adaptive:pool_unavailable' });
      continue;
    }
    const network = cycle.chain === 'sol' ? 'solana' : 'bsc';
    let selected:
      | {
          screening: ReturnType<typeof parseLevel1ScreeningSnapshot> & { status: 'complete' };
          eligibleAt: number;
        }
      | undefined;
    for (const event of relevant.filter((item) => item.kind === 'level1').sort(byObservedAt)) {
      const safety = safetyAt({ ...input, cycle }, relevant, event.observedAt);
      if (safety?.status !== 'pass') continue;
      const attention = evaluateCandidateAttention(
        cycle.evidence.filter((item) => item.observedAt <= event.observedAt),
        input.config.strategies.emerging_breakout.attention,
      );
      if (attention.status !== 'pass') continue;
      const raw = poolRawForAddress(
        asRecord(event.payload),
        network,
        resolved.pool.poolAddress,
        resolved.pool.tokenAddress,
      );
      if (!raw) continue;
      const screening = parseLevel1ScreeningSnapshot(
        level1ScreeningRawForPool(
          raw,
          resolved.pool,
          poolAttributesForAddress(asRecord(event.payload), network, resolved.pool.poolAddress),
        ),
        resolved.pool,
        event.observedAt,
      );
      if (screening.status !== 'complete') continue;
      selected = { screening, eligibleAt: event.observedAt };
      break;
    }
    if (!selected) {
      result.set(key, { status: 'blocked', reason: 'adaptive:structural_or_attention' });
      continue;
    }
    eligible.push({ key, cycle, pool: resolved.pool, ...selected, expiresAt });
  }

  eligible.sort((left, right) => {
    if (left.eligibleAt !== right.eligibleAt) return left.eligibleAt - right.eligibleAt;
    const leftWindow = left.screening.snapshot.windows.m5;
    const rightWindow = right.screening.snapshot.windows.m5;
    if ((rightWindow?.buyers ?? 0) !== (leftWindow?.buyers ?? 0))
      return (rightWindow?.buyers ?? 0) - (leftWindow?.buyers ?? 0);
    const netBuy = new Decimal(rightWindow?.netBuyUsd ?? '0').comparedTo(
      leftWindow?.netBuyUsd ?? '0',
    );
    if (netBuy !== 0) return netBuy;
    return left.key.localeCompare(right.key);
  });

  const occupiedUntil: number[] = [];
  const capacity = input.config.providers.coingecko.g2.max_subscriptions_per_socket;
  for (const item of eligible) {
    for (let index = occupiedUntil.length - 1; index >= 0; index -= 1)
      if (occupiedUntil[index]! <= item.eligibleAt) occupiedUntil.splice(index, 1);
    if (occupiedUntil.length >= capacity) {
      result.set(item.key, { status: 'blocked', reason: 'adaptive:finalist_capacity' });
      continue;
    }
    const trade = input.evidence
      .filter(
        (event) =>
          event.kind === 'trades' &&
          event.observedAt >= item.eligibleAt &&
          event.observedAt <= Math.min(item.expiresAt, input.dataEndAt, input.dataCutoffAt) &&
          event.poolAddress !== undefined &&
          event.tokenAddress !== undefined &&
          sameToken(item.pool.chain, event.poolAddress, item.pool.poolAddress) &&
          sameToken(item.pool.chain, event.tokenAddress, item.pool.tokenAddress),
      )
      .sort(byObservedAt)[0];
    const eventAt = trade ? latestTradeAt(asRecord(trade.payload)) : undefined;
    if (!trade || eventAt === undefined) {
      result.set(item.key, { status: 'blocked', reason: 'adaptive:finalist_trade_unavailable' });
      continue;
    }
    const promoted = promoteLevel1ScreeningSnapshot(item.screening.snapshot, {
      source: 'rest',
      chain: item.pool.chain,
      poolAddress: item.pool.poolAddress,
      tokenAddress: item.pool.tokenAddress,
      eventAt,
      observedAt: trade.observedAt,
    });
    if (promoted.status !== 'complete') {
      result.set(item.key, { status: 'blocked', reason: 'adaptive:finalist_trade_invalid' });
      continue;
    }
    occupiedUntil.push(item.expiresAt);
    result.set(item.key, { status: 'armed', armedAt: trade.observedAt });
  }
  return result;
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
  return (
    at >= lastSeenAt && at - lastSeenAt <= chainConfig(input).discovery.candidate_ttl_seconds * 1000
  );
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
    level1.observedAt + input.config.chains[pool.chain].level1.buyers_freshness_seconds * 1000 <
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
  const poolEvents = evidence
    .filter((item) => item.kind === 'level1' && item.observedAt <= at)
    .sort(byObservedAt);
  return poolEvents.flatMap((poolEvent, index) => {
    const nextPoolObservedAt = poolEvents[index + 1]?.observedAt ?? Number.POSITIVE_INFINITY;
    const raw = poolRawForAddress(
      asRecord(poolEvent.payload),
      network,
      pool.poolAddress,
      pool.tokenAddress,
    );
    if (!raw) return [];
    const screening = parseLevel1ScreeningSnapshot(
      level1ScreeningRawForPool(
        raw,
        pool,
        poolAttributesForAddress(asRecord(poolEvent.payload), network, pool.poolAddress),
      ),
      pool,
      poolEvent.observedAt,
    );
    if (screening.status !== 'complete') return [];
    const event = replayLastTradeEvidence(
      evidence,
      pool,
      poolEvent.observedAt,
      Math.min(at + 1, nextPoolObservedAt),
    );
    if (!event) return [];
    const promoted = promoteLevel1ScreeningSnapshot(screening.snapshot, event);
    return promoted.status === 'complete' ? [promoted.snapshot] : [];
  });
}

function replayLastTradeEvidence(
  evidence: readonly ReplayEvidence[],
  pool: CanonicalPool,
  poolObservedAt: number,
  upperObservedAt: number,
): LastTradeEvidence | undefined {
  const matches = evidence
    .filter(
      (item) =>
        item.observedAt < upperObservedAt &&
        item.poolAddress !== undefined &&
        sameToken(pool.chain, item.poolAddress, pool.poolAddress) &&
        (item.kind === 'trades' || item.kind === 'g2'),
    )
    .sort(byObservedAt);
  const selected =
    matches.filter((item) => item.observedAt >= poolObservedAt).at(-1) ??
    matches.filter((item) => item.observedAt < poolObservedAt).at(-1);
  if (!selected) return undefined;
  if (selected.kind === 'trades') {
    const eventAt = latestTradeAt(asRecord(selected.payload));
    return eventAt === undefined
      ? undefined
      : {
          source: 'rest',
          chain: pool.chain,
          poolAddress: pool.poolAddress,
          tokenAddress: pool.tokenAddress,
          eventAt,
          observedAt: selected.observedAt,
        };
  }
  const parsed = normalizeG2Item(asRecord(selected.payload), pool, selected.observedAt);
  return parsed.status !== 'complete'
    ? undefined
    : {
        source: 'g2',
        chain: pool.chain,
        poolAddress: pool.poolAddress,
        tokenAddress: pool.tokenAddress,
        eventAt: parsed.trade.eventAt,
        observedAt: parsed.trade.observedAt,
      };
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
  for (const item of evidence
    .filter((event) => event.kind === 'g2' && event.observedAt <= at)
    .sort(byObservedAt)) {
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
  if (!safety || !level1)
    return { status: 'cancel' as const, reason: 'dispatch:evidence_unavailable' };
  const windowEnd = Math.floor(signal.confirmedAt / 30_000) * 30_000;
  const g2 = aggregateG2Window(
    trades.filter((trade) => trade.observedAt <= deliveredAt),
    windowEnd - 30_000,
    windowEnd,
    deliveredAt,
  );
  const coveredG2 = hasG2Coverage(input, evidence, pool, windowEnd - 30_000, windowEnd);
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
    deliveredAt + (maxHorizon + input.config.outcomes.outcome_max_lateness_seconds) * 1000;
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
      ...(selected
        ? { entry: { observedAt: selected.observedAt, priceUsd: selected.priceUsd } }
        : {}),
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
  if (!value.isPositive() || !baseline.isPositive())
    throw new Error('Invalid replay price baseline');
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
