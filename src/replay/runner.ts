import type { SqliteDatabase } from '../persistence/db.js';
import { assertCleanReplayWorktree } from './config.js';
import type { SimulatedReplayResult } from './simulator.js';

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
  simulatedResults: readonly SimulatedReplayResult[];
  resultBatchSize: number;
  worktreeStatus?: string;
  gitCwd?: string;
  shouldYield?: () => boolean;
  runId?: number;
};

export type ReplayRunResult = {
  runId: number;
  status: ReplayRunStatus;
  resultCount: number;
  fullCount: number;
  partialCount: number;
  unavailableCount: number;
};

export type ReplayRunMetadata = Pick<
  ReplayRunInput,
  | 'database'
  | 'configVersionId'
  | 'gitCommit'
  | 'runMode'
  | 'dataStartAt'
  | 'dataEndAt'
  | 'dataCutoffAt'
  | 'startedAt'
>;

export function startReplayRun(input: ReplayRunMetadata): number {
  validateReplayMetadata(input);
  assertConfigIdentity(input);
  return Number(
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
}

export function failReplayRun(
  database: SqliteDatabase,
  runId: number,
  error: unknown,
  completedAt: number,
): void {
  const message = error instanceof Error ? error.message : 'Replay failed';
  database
    .prepare(
      `UPDATE replay_runs SET status = 'failed', error_message = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(message, completedAt, runId);
}

export function runReplay(input: ReplayRunInput): ReplayRunResult {
  assertCleanReplayWorktree(input.worktreeStatus, input.gitCwd);
  validateInput(input);
  assertConfigIdentity(input);
  const runId = input.runId ?? startReplayRun(input);
  if (input.runId !== undefined) assertRunningReplay(input, runId);
  try {
    let status: ReplayRunStatus = 'complete';
    let resultCount = 0;
    let fullCount = 0;
    let partialCount = 0;
    let unavailableCount = 0;
    for (let index = 0; index < input.simulatedResults.length; index += input.resultBatchSize) {
      if (input.shouldYield?.()) {
        status = 'paused';
        break;
      }
      const batch = input.simulatedResults.slice(index, index + input.resultBatchSize);
      const insertBatch = input.database.transaction(() => {
        for (const candidate of batch) {
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
              JSON.stringify(candidate.sourceLiveCandidateIds),
              JSON.stringify(candidate.simulatedSignal),
              JSON.stringify(candidate.outcome),
              candidate.completenessStatus,
              input.startedAt,
            );
          resultCount += 1;
          if (candidate.completenessStatus === 'full') fullCount += 1;
          else if (candidate.completenessStatus === 'partial') partialCount += 1;
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
    failReplayRun(input.database, runId, error, input.now);
    throw error;
  }
}

function assertConfigIdentity(input: ReplayRunMetadata): void {
  const config = input.database
    .prepare(
      'SELECT git_commit AS gitCommit, run_mode AS runMode FROM rule_config_versions WHERE id = ?',
    )
    .get(input.configVersionId) as { gitCommit: string; runMode: string } | undefined;
  if (!config) throw new Error(`Unknown replay config version: ${input.configVersionId}`);
  if (config.gitCommit !== input.gitCommit || config.runMode !== input.runMode)
    throw new Error('Replay config version does not match Git commit or run mode');
}

function assertRunningReplay(input: ReplayRunMetadata, runId: number): void {
  const row = input.database
    .prepare(
      `SELECT config_version_id, data_start_at, data_end_at, data_cutoff_at, status, started_at
       FROM replay_runs WHERE id = ?`,
    )
    .get(runId) as
    | {
        config_version_id: number;
        data_start_at: number | null;
        data_end_at: number | null;
        data_cutoff_at: number;
        status: string;
        started_at: number;
      }
    | undefined;
  if (
    !row ||
    row.status !== 'running' ||
    row.config_version_id !== input.configVersionId ||
    row.data_start_at !== (input.dataStartAt ?? null) ||
    row.data_end_at !== (input.dataEndAt ?? null) ||
    row.data_cutoff_at !== input.dataCutoffAt ||
    row.started_at !== input.startedAt
  )
    throw new Error('Replay run metadata does not match the prepared run');
}

function validateInput(input: ReplayRunInput): void {
  validateReplayMetadata(input);
  if (
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(input.startedAt) ||
    input.now < input.startedAt
  )
    throw new Error('Invalid replay run clock');
  if (!Number.isInteger(input.resultBatchSize) || input.resultBatchSize <= 0)
    throw new Error('Invalid replay result batch size');
  const keys = new Set<string>();
  for (const result of input.simulatedResults) {
    if (!result.key || keys.has(result.key)) throw new Error('Invalid duplicate replay result key');
    keys.add(result.key);
  }
}

function validateReplayMetadata(input: ReplayRunMetadata): void {
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
  if (!Number.isSafeInteger(input.startedAt) || input.startedAt < 0)
    throw new Error('Invalid replay start clock');
}
