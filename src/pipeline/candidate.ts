import { parseDecimalString, parseAddress } from '../providers/parsing.js';
import type { DataState } from '../providers/types.js';
import type { SafetyResult } from '../domain/safety.js';

export type DiscoverySource = 'trending_1m' | 'trending_5m' | 'hot_searches';
export type CandidateLifecycle =
  | 'scouting'
  | 'safety_pending'
  | 'qualified'
  | 'armed'
  | 'confirmed-pending-anchor'
  | 'delivered'
  | 'completed'
  | 'rejected'
  | 'incomplete'
  | 'expired';

export type DiscoveryObservation = {
  chain: 'sol' | 'bsc';
  tokenAddress: string;
  source: DiscoverySource;
  observedAt: number;
  rank?: number;
  visitingCount?: number;
};

export type CandidateCycle = {
  key: string;
  chain: DiscoveryObservation['chain'];
  tokenAddress: string;
  cycleStartedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  status: CandidateLifecycle;
  closeReason?: 'discovery_ttl';
  evidence: DiscoveryObservation[];
};

export type CandidateIngestResult = {
  cycle: CandidateCycle;
  triggered: boolean;
  startedNewCycle: boolean;
  closedCycle?: CandidateCycle;
};

type SourceState = { rank: number | undefined; visitingCount: number | undefined };

export class CandidateCycleTracker {
  private readonly cycles = new Map<string, CandidateCycle>();
  private readonly sourceStates = new Map<string, Map<DiscoverySource, SourceState>>();

  constructor(private readonly ttlSeconds: number) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0)
      throw new Error('Candidate TTL must be a positive integer');
  }

  restore(
    cycle: Pick<
      CandidateCycle,
      'chain' | 'tokenAddress' | 'cycleStartedAt' | 'firstSeenAt' | 'lastSeenAt' | 'status'
    >,
  ): void {
    if (
      !Number.isSafeInteger(cycle.cycleStartedAt) ||
      !Number.isSafeInteger(cycle.firstSeenAt) ||
      !Number.isSafeInteger(cycle.lastSeenAt) ||
      cycle.cycleStartedAt < 0 ||
      cycle.firstSeenAt < 0 ||
      cycle.lastSeenAt < 0 ||
      cycle.firstSeenAt < cycle.cycleStartedAt ||
      cycle.lastSeenAt < cycle.firstSeenAt
    )
      throw new Error('Invalid persisted candidate cycle');
    const key = `${cycle.chain}:${cycle.tokenAddress}`;
    if (this.cycles.has(key)) return;
    this.cycles.set(key, { ...cycle, key, evidence: [] });
    this.sourceStates.set(key, new Map());
  }

  ingest(observation: DiscoveryObservation): CandidateIngestResult {
    validateObservation(observation);
    const key = `${observation.chain}:${observation.tokenAddress}`;
    const existing = this.cycles.get(key);
    let closedCycle: CandidateCycle | undefined;
    let cycle = existing;
    let startedNewCycle = false;
    if (cycle && observation.observedAt - cycle.lastSeenAt > this.ttlSeconds * 1000) {
      cycle.status = 'expired';
      cycle.closeReason = 'discovery_ttl';
      closedCycle = { ...cycle, evidence: [...cycle.evidence] };
      this.cycles.delete(key);
      this.sourceStates.delete(key);
      cycle = undefined;
    }
    if (!cycle) {
      cycle = {
        key,
        chain: observation.chain,
        tokenAddress: observation.tokenAddress,
        cycleStartedAt: observation.observedAt,
        firstSeenAt: observation.observedAt,
        lastSeenAt: observation.observedAt,
        status: 'scouting',
        evidence: [],
      };
      this.cycles.set(key, cycle);
      this.sourceStates.set(key, new Map());
      startedNewCycle = true;
    }

    const states = this.sourceStates.get(key)!;
    const previous = states.get(observation.source);
    const triggered = startedNewCycle || isDiscoveryTrigger(observation, previous);
    states.set(observation.source, {
      rank: observation.rank,
      visitingCount: observation.visitingCount,
    });
    cycle.lastSeenAt = Math.max(cycle.lastSeenAt, observation.observedAt);
    cycle.evidence.push({ ...observation });
    const result: CandidateIngestResult = {
      cycle: { ...cycle, evidence: [...cycle.evidence] },
      triggered,
      startedNewCycle,
    };
    if (closedCycle) result.closedCycle = closedCycle;
    return result;
  }

  closeExpired(now: number): CandidateCycle[] {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid close time');
    const closed: CandidateCycle[] = [];
    for (const [key, cycle] of this.cycles) {
      if (now - cycle.lastSeenAt <= this.ttlSeconds * 1000) continue;
      cycle.status = 'expired';
      cycle.closeReason = 'discovery_ttl';
      closed.push({ ...cycle, evidence: [...cycle.evidence] });
      this.cycles.delete(key);
      this.sourceStates.delete(key);
    }
    return closed;
  }

  get(chain: DiscoveryObservation['chain'], tokenAddress: string): CandidateCycle | undefined {
    const cycle = this.cycles.get(`${chain}:${tokenAddress}`);
    return cycle ? { ...cycle, evidence: [...cycle.evidence] } : undefined;
  }
}

function validateObservation(observation: DiscoveryObservation): void {
  if (!Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0)
    throw new Error('Invalid discovery observedAt');
  parseAddress(observation.tokenAddress);
  if (
    observation.rank !== undefined &&
    (!Number.isSafeInteger(observation.rank) || observation.rank < 1)
  )
    throw new Error('Invalid discovery rank');
  if (
    observation.visitingCount !== undefined &&
    (!Number.isSafeInteger(observation.visitingCount) || observation.visitingCount < 0)
  )
    throw new Error('Invalid visiting count');
}

function isDiscoveryTrigger(
  observation: DiscoveryObservation,
  previous: SourceState | undefined,
): boolean {
  if (!previous) return true;
  if (observation.source === 'hot_searches')
    return (
      observation.visitingCount !== undefined &&
      previous.visitingCount !== undefined &&
      observation.visitingCount > previous.visitingCount
    );
  return (
    observation.rank !== undefined &&
    previous.rank !== undefined &&
    observation.rank < previous.rank
  );
}

export type EvidenceValue<T> = { state: DataState; value?: T };

export type CheapPreFilterInput = {
  chain: 'sol' | 'bsc';
  tokenAddress: string;
  safety: SafetyResult;
  marketCapUsd: EvidenceValue<string>;
  liquidityUsd: EvidenceValue<string>;
  minMarketCapUsd: string;
  minLiquidityUsd: string;
  attentionProgress: boolean;
};

export type CheapPreFilterResult =
  | { status: 'pass' }
  | { status: 'rejected'; reason: string }
  | { status: 'incomplete'; reason: string };

export function runCheapPreFilter(input: CheapPreFilterInput): CheapPreFilterResult {
  try {
    parseAddress(input.tokenAddress);
  } catch {
    return { status: 'incomplete', reason: 'invalid:token_address' };
  }
  if (input.safety.status !== 'pass')
    return {
      status: input.safety.status === 'incomplete' ? 'incomplete' : 'rejected',
      reason: `safety:${input.safety.status}`,
    };
  if (!input.attentionProgress) return { status: 'rejected', reason: 'attention:no_progress' };
  const marketCap = readEvidence(input.marketCapUsd, 'market_cap_usd');
  if (marketCap.status !== 'pass') return marketCap;
  const liquidity = readEvidence(input.liquidityUsd, 'liquidity_usd');
  if (liquidity.status !== 'pass') return liquidity;
  try {
    if (marketCap.value!.lessThan(input.minMarketCapUsd))
      return { status: 'rejected', reason: 'market_cap:below_threshold' };
    if (liquidity.value!.lessThan(input.minLiquidityUsd))
      return { status: 'rejected', reason: 'liquidity:below_threshold' };
  } catch {
    return { status: 'incomplete', reason: 'invalid:prefilter_threshold' };
  }
  return { status: 'pass' };
}

function readEvidence(
  evidence: EvidenceValue<string>,
  field: string,
): CheapPreFilterResult & { value?: ReturnType<typeof parseDecimalString> } {
  if (evidence.state !== 'complete')
    return {
      status:
        evidence.state === 'invalid' || evidence.state === 'conflict' ? 'rejected' : 'incomplete',
      reason: `${field}:${evidence.state}`,
    };
  try {
    return { status: 'pass', value: parseDecimalString(evidence.value, { nonNegative: true }) };
  } catch {
    return { status: 'incomplete', reason: `${field}:invalid` };
  }
}

export function unresolvedRetryAt(
  observedAt: number,
  attempt: number,
  initialSeconds: number,
  maxSeconds: number,
): number {
  if (
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 0 ||
    !Number.isFinite(initialSeconds) ||
    initialSeconds <= 0 ||
    !Number.isFinite(maxSeconds) ||
    maxSeconds < initialSeconds
  )
    throw new Error('Invalid unresolved retry configuration');
  const delaySeconds = Math.min(maxSeconds, initialSeconds * 2 ** Math.min(attempt, 30));
  return observedAt + delaySeconds * 1000;
}

export function isPoolResolvedForLevel1(status: 'resolved' | 'unresolved' | 'invalid'): boolean {
  return status === 'resolved';
}

export function isAnchorCooldownActive(until: number | undefined, now: number): boolean {
  return until !== undefined && until > now;
}

export function canCreateSignal(
  chain: DiscoveryObservation['chain'],
  tokenAddress: string,
  now: number,
  anchorCooldownUntil: number | undefined,
): { status: 'pass' } | { status: 'rejected'; reason: string } {
  try {
    parseAddress(tokenAddress);
  } catch {
    return { status: 'rejected', reason: 'invalid:token_address' };
  }
  if (isAnchorCooldownActive(anchorCooldownUntil, now))
    return { status: 'rejected', reason: `cooldown:${chain}:${tokenAddress}` };
  return { status: 'pass' };
}
