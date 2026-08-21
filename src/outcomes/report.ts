import { Decimal } from 'decimal.js';

export type ReportOutcome = {
  configVersionId: string;
  runMode: 'shadow' | 'production';
  anchorDeliveredAt: number;
  executionStatus: 'executable' | 'not_executable' | 'incomplete';
  deliveryDrift?: string;
  credits?: string;
  latencyMs?: number;
  horizons: readonly {
    horizonSeconds: number;
    status: 'complete' | 'late_entry' | 'incomplete';
    forwardReturn?: string;
    mfe?: string;
    mae?: string;
  }[];
};

export type OutcomeReport = {
  configVersionId: string;
  runMode: 'shadow' | 'production';
  denominator: number;
  executionCounts: Record<ReportOutcome['executionStatus'], number>;
  executableRate: string;
  horizonCounts: Record<string, Record<'complete' | 'late_entry' | 'incomplete', number>>;
  horizonRates: Record<string, { timelyExecutableRate: string; completeRate: string }>;
  returnsSampleCount: number;
  averageForwardReturn?: string;
  averageMfe?: string;
  averageMae?: string;
  averageDeliveryDrift?: string;
  totalCredits?: string;
  averageLatencyMs?: number;
};

export function buildOutcomeReport(input: {
  outcomes: readonly ReportOutcome[];
  configVersionId: string;
  runMode: 'shadow' | 'production';
  startAt: number;
  endAt: number;
  maxRows: number;
}): OutcomeReport {
  if (!Number.isInteger(input.maxRows) || input.maxRows <= 0)
    throw new Error('maxRows must be a positive integer');
  if (
    !Number.isFinite(input.startAt) ||
    !Number.isFinite(input.endAt) ||
    input.startAt > input.endAt
  )
    throw new Error('Invalid report time range');
  const outcomes = input.outcomes
    .filter(
      (outcome) =>
        outcome.configVersionId === input.configVersionId &&
        outcome.runMode === input.runMode &&
        outcome.anchorDeliveredAt >= input.startAt &&
        outcome.anchorDeliveredAt <= input.endAt,
    )
    .slice(0, input.maxRows);
  const executionCounts = { executable: 0, not_executable: 0, incomplete: 0 };
  const horizonCounts: OutcomeReport['horizonCounts'] = {};
  const horizonTimelyExecutable = new Map<string, number>();
  const returns: Decimal[] = [];
  const mfes: Decimal[] = [];
  const maes: Decimal[] = [];
  const drifts: Decimal[] = [];
  const credits: Decimal[] = [];
  let latencyTotal = 0;
  let latencyCount = 0;
  for (const outcome of outcomes) {
    executionCounts[outcome.executionStatus] += 1;
    for (const horizon of outcome.horizons) {
      const key = String(horizon.horizonSeconds);
      const counts = (horizonCounts[key] ??= { complete: 0, late_entry: 0, incomplete: 0 });
      counts[horizon.status] += 1;
      if (outcome.executionStatus === 'executable' && horizon.status === 'complete')
        horizonTimelyExecutable.set(key, (horizonTimelyExecutable.get(key) ?? 0) + 1);
      if (outcome.executionStatus === 'executable' && horizon.status === 'complete') {
        if (horizon.forwardReturn !== undefined) returns.push(new Decimal(horizon.forwardReturn));
        if (horizon.mfe !== undefined) mfes.push(new Decimal(horizon.mfe));
        if (horizon.mae !== undefined) maes.push(new Decimal(horizon.mae));
      }
    }
    if (outcome.executionStatus === 'executable' && outcome.deliveryDrift !== undefined)
      drifts.push(new Decimal(outcome.deliveryDrift));
    if (outcome.credits !== undefined) credits.push(new Decimal(outcome.credits));
    if (outcome.latencyMs !== undefined) {
      latencyTotal += outcome.latencyMs;
      latencyCount += 1;
    }
  }
  return {
    configVersionId: input.configVersionId,
    runMode: input.runMode,
    denominator: outcomes.length,
    executionCounts,
    executableRate:
      outcomes.length === 0
        ? '0'
        : new Decimal(executionCounts.executable).div(outcomes.length).toString(),
    horizonCounts,
    horizonRates: Object.fromEntries(
      Object.entries(horizonCounts).map(([horizon, counts]) => {
        const denominator = counts.complete + counts.late_entry + counts.incomplete;
        return [
          horizon,
          {
            timelyExecutableRate: new Decimal(horizonTimelyExecutable.get(horizon) ?? 0)
              .div(denominator)
              .toString(),
            completeRate: new Decimal(counts.complete).div(denominator).toString(),
          },
        ];
      }),
    ),
    returnsSampleCount: returns.length,
    ...(returns.length > 0 ? { averageForwardReturn: average(returns) } : {}),
    ...(mfes.length > 0 ? { averageMfe: average(mfes) } : {}),
    ...(maes.length > 0 ? { averageMae: average(maes) } : {}),
    ...(drifts.length > 0 ? { averageDeliveryDrift: average(drifts) } : {}),
    ...(credits.length > 0
      ? { totalCredits: credits.reduce((sum, value) => sum.plus(value), new Decimal(0)).toString() }
      : {}),
    ...(latencyCount > 0 ? { averageLatencyMs: latencyTotal / latencyCount } : {}),
  };
}

function average(values: readonly Decimal[]): string {
  return values
    .reduce((sum, value) => sum.plus(value), new Decimal(0))
    .div(values.length)
    .toString();
}
