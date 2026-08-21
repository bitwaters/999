import type { SqliteDatabase } from '../persistence/db.js';
import { assertCleanReplayWorktree } from './config.js';
import { buildSimulatedCandidates, type ReplayEvidence } from './timeline.js';
import type { DiscoveryObservation } from '../pipeline/candidate.js';

export type ReplayRunStatus = 'running' | 'complete' | 'partial' | 'paused' | 'failed';

export type ReplayRunInput = {
  database: SqliteDatabase;
  configVersionId: number;
  gitCommit: string;
  runMode: 'shadow' | 'production';
  dataStartAt?: number;
  dataEndAt?: number;
  dataCutoffAt: number;
  now: number;
  startedAt: number;
  deliveryDelayMs: number;
  candidateTtlSeconds: number;
  outcomeMaxLatenessSeconds: number;
  horizonSeconds: readonly number[];
  discovery: readonly DiscoveryObservation[];
  evidence: readonly ReplayEvidence[];
  resultBatchSize: number;
  worktreeStatus?: string;
  gitCwd?: string;
  shouldYield?: () => boolean;
};

export type ReplayRunResult = {
  runId: number;
  status: ReplayRunStatus;
  resultCount: number;
  fullCount: number;
  partialCount: number;
  unavailableCount: number;
};

export function runReplay(input: ReplayRunInput): ReplayRunResult {
  assertCleanReplayWorktree(input.worktreeStatus, input.gitCwd);
  validateInput(input);
  const config = input.database
    .prepare(
      'SELECT git_commit AS gitCommit, run_mode AS runMode FROM rule_config_versions WHERE id = ?',
    )
    .get(input.configVersionId) as { gitCommit: string; runMode: string } | undefined;
  if (!config) throw new Error(`Unknown replay config version: ${input.configVersionId}`);
  if (config.gitCommit !== input.gitCommit || config.runMode !== input.runMode)
    throw new Error('Replay config version does not match Git commit or run mode');

  const runId = Number(
    input.database
      .prepare(
        `INSERT INTO replay_runs
         (config_version_id, data_start_at, data_end_at, data_cutoff_at, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        input.configVersionId,
        input.dataStartAt ?? null,
        input.dataEndAt ?? null,
        input.dataCutoffAt,
        input.startedAt,
      ).lastInsertRowid,
  );
  try {
    const dataStartAt = input.dataStartAt ?? 0;
    const dataEndAt = input.dataEndAt ?? input.dataCutoffAt;
    const candidates = buildSimulatedCandidates({
      observations: input.discovery.filter(
        (observation) =>
          observation.observedAt >= dataStartAt && observation.observedAt <= dataEndAt,
      ),
      evidence: input.evidence.filter(
        (item) => item.observedAt >= dataStartAt && item.observedAt <= dataEndAt,
      ),
      ttlSeconds: input.candidateTtlSeconds,
      dataCutoffAt: input.dataCutoffAt,
      deliveryDelayMs: input.deliveryDelayMs,
    });
    let status: ReplayRunStatus = 'complete';
    let resultCount = 0;
    let fullCount = 0;
    let partialCount = 0;
    let unavailableCount = 0;
    for (let index = 0; index < candidates.length; index += input.resultBatchSize) {
      if (input.shouldYield?.()) {
        status = 'paused';
        break;
      }
      const batch = candidates.slice(index, index + input.resultBatchSize);
      const insertBatch = input.database.transaction(() => {
        for (const candidate of batch) {
          const candidateEvidence = candidate.evidenceAtDelivery.filter(
            (item) =>
              item.tokenAddress === candidate.cycle.tokenAddress &&
              (item.chain === undefined || item.chain === candidate.cycle.chain),
          );
          const hasG2 = candidateEvidence.some((item) => item.kind === 'g2');
          const hasRest = candidateEvidence.some((item) => item.kind === 'ohlcv');
          const maxHorizon = Math.max(...input.horizonSeconds);
          const horizonCutoff =
            candidate.deliveryAt + (maxHorizon + input.outcomeMaxLatenessSeconds) * 1000;
          const complete = hasG2 && hasRest && input.dataCutoffAt >= horizonCutoff;
          const completenessStatus = !hasG2 ? 'unavailable' : complete ? 'full' : 'partial';
          const outcomeStatus = !hasG2 ? 'unavailable' : complete ? 'full' : 'partial';
          input.database
            .prepare(
              `INSERT INTO replay_results
               (replay_run_id, simulated_candidate_key, source_live_candidate_ids_json,
                simulated_signal_json, outcome_json, completeness_status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              runId,
              candidate.key,
              JSON.stringify([]),
              JSON.stringify({
                simulatedCandidateKey: candidate.key,
                simulatedConfirmedAt: candidate.confirmationAt,
                simulatedDeliveredAt: candidate.deliveryAt,
                evidenceObservedAtDelivery: candidateEvidence.map((item) => item.observedAt),
              }),
              JSON.stringify({
                status: outcomeStatus,
                entry: hasG2 ? 'recomputed_from_raw_g2' : 'unavailable:no_historical_g2',
                horizonCutoff,
              }),
              completenessStatus,
              input.startedAt,
            );
          resultCount += 1;
          if (completenessStatus === 'full') fullCount += 1;
          else if (completenessStatus === 'partial') partialCount += 1;
          else unavailableCount += 1;
        }
      });
      insertBatch();
    }
    const summary = { resultCount, fullCount, partialCount, unavailableCount };
    input.database
      .prepare(
        `UPDATE replay_runs
         SET status = ?, summary_json = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(status, JSON.stringify(summary), status === 'paused' ? null : input.now, runId);
    return { runId, status, ...summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Replay failed';
    input.database
      .prepare(
        'UPDATE replay_runs SET status = ?, error_message = ?, completed_at = ? WHERE id = ?',
      )
      .run('failed', message, input.now, runId);
    throw error;
  }
}

function validateInput(input: ReplayRunInput): void {
  if (!Number.isInteger(input.configVersionId) || input.configVersionId <= 0)
    throw new Error('Invalid replay config version');
  if (!Number.isSafeInteger(input.dataCutoffAt) || input.dataCutoffAt < 0)
    throw new Error('Invalid replay data cutoff');
  if (
    input.dataStartAt !== undefined &&
    (!Number.isSafeInteger(input.dataStartAt) || input.dataStartAt < 0)
  )
    throw new Error('Invalid replay data start');
  if (input.dataStartAt !== undefined && input.dataStartAt > input.dataCutoffAt)
    throw new Error('Replay data start is after cutoff');
  if (
    input.dataEndAt !== undefined &&
    (!Number.isSafeInteger(input.dataEndAt) || input.dataEndAt < 0)
  )
    throw new Error('Invalid replay data end');
  if (input.dataEndAt !== undefined && input.dataEndAt > input.dataCutoffAt)
    throw new Error('Replay data end is after cutoff');
  if (
    input.dataStartAt !== undefined &&
    input.dataEndAt !== undefined &&
    input.dataStartAt > input.dataEndAt
  )
    throw new Error('Replay data start is after data end');
  if (
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(input.startedAt) ||
    input.now < input.startedAt
  )
    throw new Error('Invalid replay run clock');
  if (!Number.isInteger(input.resultBatchSize) || input.resultBatchSize <= 0)
    throw new Error('Invalid replay result batch size');
  if (
    input.horizonSeconds.length === 0 ||
    input.horizonSeconds.some((value) => !Number.isInteger(value) || value <= 0)
  )
    throw new Error('Invalid replay horizons');
  if (!Number.isInteger(input.outcomeMaxLatenessSeconds) || input.outcomeMaxLatenessSeconds < 0)
    throw new Error('Invalid replay outcome lateness');
}
