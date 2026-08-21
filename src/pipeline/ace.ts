import { Decimal } from 'decimal.js';
import type { BotConfig } from '../config/schema.js';
import { canReuseSafetyPass, type SafetyResult } from '../domain/safety.js';
import { parseDecimalString } from '../providers/parsing.js';
import type { G2Window } from '../market-data/g2.js';
import { isLevel1Fresh, type Level1Snapshot } from '../market-data/level1.js';
import type { AgeEvaluation } from './age.js';

export type RuleDecision = {
  status: 'pass' | 'rejected' | 'incomplete';
  reasons: string[];
};

export function evaluateAttention(
  input: {
    rankBefore?: number;
    rankAfter?: number;
    visitingBefore?: number;
    visitingAfter?: number;
  },
  config: BotConfig['strategies']['emerging_breakout']['attention'],
): RuleDecision {
  const reasons: string[] = [];
  const criteria: boolean[] = [];
  if (input.rankBefore !== undefined || input.rankAfter !== undefined) {
    if (
      input.rankBefore === undefined ||
      input.rankAfter === undefined ||
      !Number.isSafeInteger(input.rankBefore) ||
      !Number.isSafeInteger(input.rankAfter)
    )
      reasons.push('incomplete:rank');
    else
      criteria.push(
        input.rankAfter <= config.max_rank &&
          input.rankBefore - input.rankAfter >= config.min_rank_improvement,
      );
  }
  if (input.visitingBefore !== undefined || input.visitingAfter !== undefined) {
    if (
      input.visitingBefore === undefined ||
      input.visitingAfter === undefined ||
      !Number.isSafeInteger(input.visitingBefore) ||
      !Number.isSafeInteger(input.visitingAfter)
    )
      reasons.push('incomplete:visiting_count');
    else criteria.push(input.visitingAfter - input.visitingBefore >= config.min_hot_search_growth);
  }
  if (criteria.length === 0 && reasons.length === 0)
    return { status: 'incomplete', reasons: ['missing:attention'] };
  if (criteria.includes(true) && reasons.length === 0) return { status: 'pass', reasons: [] };
  if (reasons.length > 0) return { status: 'incomplete', reasons };
  return { status: 'rejected', reasons: ['rejected:attention'] };
}

export function evaluateConviction(
  g2: G2Window,
  level1: Level1Snapshot,
  now: number,
  freshnessSeconds: number,
  config: BotConfig['strategies']['emerging_breakout']['conviction'],
): RuleDecision {
  if (g2.status !== 'complete') return { status: 'incomplete', reasons: [`g2:${g2.status}`] };
  if (!isLevel1Fresh(level1, now, freshnessSeconds))
    return { status: 'incomplete', reasons: ['level1:buyers_stale'] };
  if (g2.buyVolumeShare === undefined)
    return { status: 'incomplete', reasons: ['g2:missing_buy_share'] };
  try {
    const reasons: string[] = [];
    if (parseDecimalString(g2.netBuyUsd).lessThan(String(config.min_net_buy_usd)))
      reasons.push('net_buy:below_threshold');
    if (
      parseDecimalString(g2.buyVolumeShare, { nonNegative: true, max: '1' }).lessThan(
        String(config.min_buy_volume_share),
      )
    )
      reasons.push('buy_share:below_threshold');
    if (level1.buyers < config.min_buyers) reasons.push('buyers:below_threshold');
    return reasons.length > 0 ? { status: 'rejected', reasons } : { status: 'pass', reasons: [] };
  } catch {
    return { status: 'incomplete', reasons: ['invalid:conviction_numeric'] };
  }
}

export function evaluateOrganic(
  g2: G2Window,
  safety: SafetyResult,
  config: BotConfig['strategies']['emerging_breakout']['organic_growth'],
): RuleDecision {
  if (safety.status !== 'pass')
    return { status: 'incomplete', reasons: [`safety:${safety.status}`] };
  if (g2.status !== 'complete') return { status: 'incomplete', reasons: [`g2:${g2.status}`] };
  if (g2.top1BuyShare === undefined || g2.top3BuyShare === undefined)
    return { status: 'incomplete', reasons: ['g2:missing_concentration'] };
  try {
    const reasons: string[] = [];
    if (
      parseDecimalString(g2.top1BuyShare, { nonNegative: true, max: '1' }).greaterThan(
        String(config.max_top1_share),
      )
    )
      reasons.push('top1:concentrated');
    if (
      parseDecimalString(g2.top3BuyShare, { nonNegative: true, max: '1' }).greaterThan(
        String(config.max_top3_share),
      )
    )
      reasons.push('top3:concentrated');
    return reasons.length > 0 ? { status: 'rejected', reasons } : { status: 'pass', reasons: [] };
  } catch {
    return { status: 'incomplete', reasons: ['invalid:organic_numeric'] };
  }
}

export function evaluateEntryQuality(
  input: { reserveUsd: string; priceExtension: string; preSendDrift: string },
  config: BotConfig['strategies']['emerging_breakout']['entry_quality'],
): RuleDecision {
  try {
    const reserve = parseDecimalString(input.reserveUsd, { nonNegative: true });
    const extension = parseDecimalString(input.priceExtension, { nonNegative: true });
    const drift = parseDecimalString(input.preSendDrift);
    const reasons: string[] = [];
    if (reserve.lessThan(String(config.min_reserve_usd))) reasons.push('reserve:below_threshold');
    if (extension.greaterThan(String(config.max_price_extension)))
      reasons.push('price_extension:overextended');
    if (drift.greaterThan(String(config.max_pre_send_drift)))
      reasons.push('pre_send_drift:overextended');
    return reasons.length > 0 ? { status: 'rejected', reasons } : { status: 'pass', reasons: [] };
  } catch {
    return { status: 'incomplete', reasons: ['invalid:entry_quality_numeric'] };
  }
}

export type SignalSnapshot = {
  signalType: 'Emerging Breakout';
  candidateKey: string;
  chain: 'sol' | 'bsc';
  tokenAddress: string;
  poolAddress: string;
  cycleStartedAt: number;
  confirmedAt: number;
  expiresAt: number;
  configVersionId: string;
  confirmationPriceUsd: string;
  attention: RuleDecision;
  conviction: RuleDecision;
  organic: RuleDecision;
  entryQuality: RuleDecision;
  age: Extract<AgeEvaluation, { status: 'pass' }>;
};

export type SignalSolidificationInput = {
  candidateKey: string;
  chain: 'sol' | 'bsc';
  tokenAddress: string;
  poolAddress: string;
  cycleStartedAt: number;
  confirmedAt: number;
  entryTtlSeconds: number;
  configVersionId: string;
  confirmationPriceUsd: string;
  safety: SafetyResult;
  candidateFresh: boolean;
  poolStable: boolean;
  level1Fresh: boolean;
  g2State:
    | 'complete'
    | 'partial'
    | 'zero'
    | 'missing'
    | 'stale'
    | 'invalid'
    | 'conflict'
    | 'unresolved'
    | 'incomplete';
  evidenceComplete: boolean;
  attention: RuleDecision;
  conviction: RuleDecision;
  organic: RuleDecision;
  entryQuality: RuleDecision;
  age: AgeEvaluation;
  anchorCooldownUntil?: number;
};

export function solidifyEmergingSignal(
  input: SignalSolidificationInput,
): { status: 'pass'; snapshot: SignalSnapshot } | { status: 'blocked'; reasons: string[] } {
  const reasons: string[] = [];
  if (input.anchorCooldownUntil !== undefined && input.anchorCooldownUntil > input.confirmedAt)
    reasons.push('cooldown:anchor');
  if (input.safety.status !== 'pass') reasons.push(`safety:${input.safety.status}`);
  else if (!canReuseSafetyPass(input.safety, input.confirmedAt, input.configVersionId))
    reasons.push('safety:not_fresh_or_config_mismatch');
  if (!input.candidateFresh) reasons.push('candidate:stale');
  if (!input.poolStable) reasons.push('pool:unstable');
  if (!input.level1Fresh) reasons.push('level1:stale');
  if (input.g2State !== 'complete') reasons.push(`g2:${input.g2State}`);
  if (!input.evidenceComplete) reasons.push('evidence:incomplete');
  if (input.age.status !== 'pass') reasons.push(`age:${input.age.status}:${input.age.reason}`);
  for (const [name, decision] of Object.entries({
    attention: input.attention,
    conviction: input.conviction,
    organic: input.organic,
    entryQuality: input.entryQuality,
  }))
    if (decision.status !== 'pass') reasons.push(`${name}:${decision.status}`);
  if (reasons.length > 0) return { status: 'blocked', reasons };
  if (
    !Number.isSafeInteger(input.confirmedAt) ||
    !Number.isSafeInteger(input.entryTtlSeconds) ||
    input.entryTtlSeconds <= 0
  )
    return { status: 'blocked', reasons: ['invalid:signal_timing'] };
  try {
    const price = parsePositiveDecimal(input.confirmationPriceUsd);
    return {
      status: 'pass',
      snapshot: {
        signalType: 'Emerging Breakout',
        candidateKey: input.candidateKey,
        chain: input.chain,
        tokenAddress: input.tokenAddress,
        poolAddress: input.poolAddress,
        cycleStartedAt: input.cycleStartedAt,
        confirmedAt: input.confirmedAt,
        expiresAt: input.confirmedAt + input.entryTtlSeconds * 1000,
        configVersionId: input.configVersionId,
        confirmationPriceUsd: price.toString(),
        attention: input.attention,
        conviction: input.conviction,
        organic: input.organic,
        entryQuality: input.entryQuality,
        age: input.age as Extract<AgeEvaluation, { status: 'pass' }>,
      },
    };
  } catch {
    return { status: 'blocked', reasons: ['invalid:confirmation_price'] };
  }
}

export function evaluateDispatchGuard(input: {
  signal: SignalSnapshot;
  now: number;
  safety: SafetyResult;
  latestPoolStable: boolean;
  latestPoolFresh: boolean;
  latestG2State: G2Window['status'];
  latestPriceUsd: string;
  maxPreSendDrift: string;
}): { status: 'send'; preSendDrift: string } | { status: 'cancel'; reason: string } {
  if (input.now >= input.signal.expiresAt) return { status: 'cancel', reason: 'expired:entry_ttl' };
  if (!canReuseSafetyPass(input.safety, input.now, input.signal.configVersionId))
    return { status: 'cancel', reason: 'safety:not_fresh_or_config_mismatch' };
  if (!input.latestPoolStable || !input.latestPoolFresh)
    return { status: 'cancel', reason: 'pool:not_fresh_or_stable' };
  if (input.latestG2State !== 'complete')
    return { status: 'cancel', reason: `g2:${input.latestG2State}` };
  try {
    const latest = parsePositiveDecimal(input.latestPriceUsd);
    const confirmation = parsePositiveDecimal(input.signal.confirmationPriceUsd);
    const drift = latest.div(confirmation).minus(1);
    if (drift.greaterThan(parseNonNegativeDecimal(input.maxPreSendDrift)))
      return { status: 'cancel', reason: 'pre_send_drift:overextended' };
    return { status: 'send', preSendDrift: drift.toString() };
  } catch {
    return { status: 'cancel', reason: 'invalid:pre_send_price' };
  }
}

function parseNonNegativeDecimal(value: string): Decimal {
  return parseDecimalString(value, { nonNegative: true });
}

function parsePositiveDecimal(value: string): Decimal {
  const parsed = parseNonNegativeDecimal(value);
  if (parsed.isZero()) throw new Error('Invalid positive decimal');
  return parsed;
}
