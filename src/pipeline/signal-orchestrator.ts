import type { BotConfig } from '../config/schema.js';
import type { SafetyResult } from '../domain/safety.js';
import type { G2Window } from '../market-data/g2.js';
import { isLevel1Fresh, type Level1Snapshot } from '../market-data/level1.js';
import {
  evaluateConviction,
  evaluateEntryQuality,
  evaluateOrganic,
  solidifyEmergingSignal,
  type RuleDecision,
  type SignalSnapshot,
} from './ace.js';
import { evaluateAge } from './age.js';

export type SignalOrchestrationInput = {
  candidateKey: string;
  chain: 'sol' | 'bsc';
  tokenAddress: string;
  poolAddress: string;
  poolCreatedAt: number;
  cycleStartedAt: number;
  confirmedAt: number;
  configVersionId: string;
  safety: SafetyResult;
  level1: Level1Snapshot;
  g2: G2Window;
  candidateFresh: boolean;
  poolStable: boolean;
  priceExtension: string;
  preSendDrift: string;
  attention: RuleDecision;
  anchorCooldownUntil?: number;
};

export type SignalOrchestrationResult =
  | { status: 'pass'; snapshot: SignalSnapshot }
  | {
      status: 'blocked';
      reasons: string[];
      conviction: RuleDecision;
      organic: RuleDecision;
      entryQuality: RuleDecision;
    };

export function orchestrateSignal(
  input: SignalOrchestrationInput,
  config: BotConfig,
): SignalOrchestrationResult {
  const chain = config.chains[input.chain];
  const strategy = config.strategies.emerging_breakout;
  const conviction = evaluateConviction(
    input.g2,
    input.level1,
    input.confirmedAt,
    chain.level1.buyers_freshness_seconds,
    strategy.conviction,
  );
  const organic = evaluateOrganic(input.g2, input.safety, strategy.organic_growth);
  const entryQuality = evaluateEntryQuality(
    {
      reserveUsd: input.level1.reserveUsd,
      priceExtension: input.priceExtension,
      preSendDrift: input.preSendDrift,
    },
    strategy.entry_quality,
  );
  const age = evaluateAge(
    input.poolCreatedAt,
    input.confirmedAt,
    chain,
    config.global.max_clock_skew_seconds,
    input.level1.windows,
    input.g2.coverageSeconds,
  );
  const result = solidifyEmergingSignal({
    candidateKey: input.candidateKey,
    chain: input.chain,
    tokenAddress: input.tokenAddress,
    poolAddress: input.poolAddress,
    cycleStartedAt: input.cycleStartedAt,
    confirmedAt: input.confirmedAt,
    entryTtlSeconds: config.delivery.entry_delivery_ttl_seconds,
    configVersionId: input.configVersionId,
    confirmationPriceUsd: input.level1.priceUsd,
    safety: input.safety,
    candidateFresh: input.candidateFresh,
    poolStable: input.poolStable,
    level1Fresh: isLevel1Fresh(
      input.level1,
      input.confirmedAt,
      chain.level1.buyers_freshness_seconds,
    ),
    g2State: input.g2.status,
    evidenceComplete: input.g2.status === 'complete',
    attention: input.attention,
    conviction,
    organic,
    entryQuality,
    age,
    ...(input.anchorCooldownUntil === undefined
      ? {}
      : { anchorCooldownUntil: input.anchorCooldownUntil }),
  });
  return result.status === 'pass'
    ? result
    : { status: 'blocked', reasons: result.reasons, conviction, organic, entryQuality };
}
