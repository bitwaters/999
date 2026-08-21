import type { BotConfig } from '../config/schema.js';
import type { SafetyResult } from '../domain/safety.js';
import type { SqliteDatabase } from '../persistence/db.js';
import type { WriteBudget } from '../persistence/write-budget.js';
import type { Level1Snapshot } from '../market-data/level1.js';
import type { CanonicalPool } from '../market-data/pools.js';
import type { G2Window } from '../market-data/g2.js';
import type { CandidateCycle } from '../pipeline/candidate.js';
import { insertSignalAndPolicies, type EntryDestinationPolicy } from '../delivery/outbox.js';
import { renderEntry } from '../delivery/render.js';
import { orchestrateSignal } from '../pipeline/signal-orchestrator.js';
import type { RuleDecision } from '../pipeline/ace.js';
import { parseDecimalString } from '../providers/parsing.js';

export type LiveSignalInput = {
  config: BotConfig;
  database: SqliteDatabase;
  writeBudget: WriteBudget;
  configVersionId: number;
  candidateId: number;
  cycle: CandidateCycle;
  safety: SafetyResult;
  pool: CanonicalPool;
  level1: Level1Snapshot;
  previousLevel1?: Level1Snapshot;
  g2: G2Window;
  attention: RuleDecision;
  confirmedAt: number;
  anchorCooldownUntil?: number;
};

export type LiveSignalResult =
  { status: 'created'; signalId: number } | { status: 'blocked'; reasons: string[] };

export function createLiveSignal(input: LiveSignalInput): LiveSignalResult {
  if (!input.previousLevel1)
    return { status: 'blocked', reasons: ['entry_quality:missing_price_baseline'] };
  const existing = input.database
    .prepare('SELECT id FROM signals WHERE candidate_id = ? LIMIT 1')
    .pluck()
    .get(input.candidateId);
  if (existing !== undefined) return { status: 'blocked', reasons: ['signal:already_created'] };
  let priceExtension: string;
  try {
    priceExtension = upwardExtension(input.level1.priceUsd, input.previousLevel1.priceUsd);
  } catch {
    return { status: 'blocked', reasons: ['entry_quality:invalid_price_baseline'] };
  }
  const result = orchestrateSignal(
    {
      candidateKey: input.cycle.key,
      chain: input.pool.chain,
      tokenAddress: input.pool.tokenAddress,
      poolAddress: input.pool.poolAddress,
      poolCreatedAt: input.pool.poolCreatedAt,
      cycleStartedAt: input.cycle.cycleStartedAt,
      confirmedAt: input.confirmedAt,
      configVersionId: String(input.configVersionId),
      safety: input.safety,
      level1: input.level1,
      g2: input.g2,
      candidateFresh:
        input.confirmedAt >= input.cycle.lastSeenAt &&
        input.confirmedAt - input.cycle.lastSeenAt <=
          input.config.chains[input.pool.chain].discovery.candidate_ttl_seconds * 1000,
      poolStable: input.level1.poolStatus === 'stable',
      priceExtension,
      preSendDrift: '0',
      attention: input.attention,
      ...(input.anchorCooldownUntil === undefined
        ? {}
        : { anchorCooldownUntil: input.anchorCooldownUntil }),
    },
    input.config,
  );
  if (result.status === 'blocked') return result;
  const destinations = buildDestinations(input.config, result.snapshot);
  const inserted = insertSignalAndPolicies(
    input.database,
    {
      candidateId: input.candidateId,
      configVersionId: input.configVersionId,
      confirmedAt: input.confirmedAt,
      snapshot: result.snapshot,
      entryTtlSeconds: input.config.delivery.entry_delivery_ttl_seconds,
      now: input.confirmedAt,
      destinations,
    },
    input.writeBudget,
  );
  if (inserted.status === 'blocked') return { status: 'blocked', reasons: [inserted.reason] };
  return { status: 'created', signalId: inserted.signalId };
}

function buildDestinations(
  config: BotConfig,
  snapshot: Parameters<typeof renderEntry>[0],
): EntryDestinationPolicy[] {
  return (['admin_private', 'channel', 'group'] as const).map((destination) => ({
    destination,
    enabled: config.delivery[destination].enabled,
    anchor: destination === config.delivery.outcome_anchor_destination,
    renderedPayload: renderEntry(snapshot, destination),
  }));
}

function upwardExtension(current: string, previous: string): string {
  const currentValue = parseDecimalString(current, { nonNegative: true });
  const previousValue = parseDecimalString(previous, { nonNegative: true });
  if (previousValue.isZero()) throw new Error('Invalid price baseline');
  const extension = currentValue.div(previousValue).minus(1);
  return (extension.isNegative() ? parseDecimalString('0') : extension).toString();
}
