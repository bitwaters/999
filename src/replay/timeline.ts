import {
  CandidateCycleTracker,
  type CandidateCycle,
  type DiscoveryObservation,
} from '../pipeline/candidate.js';

export type ReplayEvidenceKind =
  'discovery' | 'safety' | 'pool' | 'level1' | 'g2' | 'ohlcv' | 'trades';

export type ReplayEvidence = {
  kind: ReplayEvidenceKind;
  observedAt: number;
  chain?: 'sol' | 'bsc';
  tokenAddress?: string;
  poolAddress?: string;
  payload: unknown;
};

export type SimulatedCandidate = {
  key: string;
  cycle: CandidateCycle;
  confirmationAt: number;
  deliveryAt: number;
  evidenceAtDelivery: ReplayEvidence[];
};

export function evidenceVisibleAt(
  evidence: readonly ReplayEvidence[],
  simulatedAt: number,
  cutoffAt: number,
): ReplayEvidence[] {
  if (
    !Number.isSafeInteger(simulatedAt) ||
    simulatedAt < 0 ||
    !Number.isSafeInteger(cutoffAt) ||
    cutoffAt < 0
  )
    throw new Error('Invalid replay evidence time range');
  const visibleUntil = Math.min(simulatedAt, cutoffAt);
  return evidence
    .filter((item) => item.observedAt <= visibleUntil)
    .sort(
      (left, right) => left.observedAt - right.observedAt || left.kind.localeCompare(right.kind),
    );
}

export function rebuildCandidateCycles(
  observations: readonly DiscoveryObservation[],
  ttlSeconds: number,
  dataCutoffAt: number,
): CandidateCycle[] {
  const tracker = new CandidateCycleTracker(ttlSeconds);
  const ordered = [...observations]
    .filter((observation) => observation.observedAt <= dataCutoffAt)
    .sort(
      (left, right) =>
        left.observedAt - right.observedAt || left.tokenAddress.localeCompare(right.tokenAddress),
    );
  const cycles: CandidateCycle[] = [];
  for (const observation of ordered) {
    const result = tracker.ingest(observation);
    if (result.closedCycle) cycles.push(result.closedCycle);
  }
  const finalTime = ordered.at(-1)?.observedAt ?? dataCutoffAt;
  cycles.push(...tracker.closeExpired(Math.max(finalTime + ttlSeconds * 1000 + 1, dataCutoffAt)));
  return cycles.sort(
    (left, right) =>
      left.cycleStartedAt - right.cycleStartedAt || left.key.localeCompare(right.key),
  );
}

export function buildSimulatedCandidates(input: {
  observations: readonly DiscoveryObservation[];
  evidence: readonly ReplayEvidence[];
  ttlSeconds: number;
  dataCutoffAt: number;
  deliveryDelayMs: number;
}): SimulatedCandidate[] {
  if (!Number.isSafeInteger(input.deliveryDelayMs) || input.deliveryDelayMs < 0)
    throw new Error('Invalid replay delivery delay');
  return rebuildCandidateCycles(input.observations, input.ttlSeconds, input.dataCutoffAt).map(
    (cycle) => {
      const confirmationAt = cycle.lastSeenAt;
      const deliveryAt = confirmationAt + input.deliveryDelayMs;
      return {
        key: `${cycle.key}:${cycle.cycleStartedAt}`,
        cycle,
        confirmationAt,
        deliveryAt,
        evidenceAtDelivery: evidenceVisibleAt(input.evidence, deliveryAt, input.dataCutoffAt),
      };
    },
  );
}
