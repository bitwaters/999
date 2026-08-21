import type { BotConfig } from '../config/schema.js';
import type { SqliteDatabase } from './db.js';
import { boundedWrite, type WriteBudget } from './write-budget.js';

export type ConfigVersionInput = {
  config: BotConfig;
  configHash: string;
  gitCommit: string;
  normalizedYaml: string;
  createdAt: number;
};

export function ensureConfigVersion(
  database: SqliteDatabase,
  input: ConfigVersionInput,
  budget: WriteBudget,
): { id: number; timingIncomplete: boolean } {
  const result = boundedWrite(database, budget, (context) => {
    const existing = database
      .prepare(
        'SELECT id FROM rule_config_versions WHERE config_hash = ? AND git_commit = ? AND run_mode = ?',
      )
      .pluck()
      .get(input.configHash, input.gitCommit, input.config.global.run_mode);
    if (existing !== undefined) return Number(existing);
    const info = database
      .prepare(
        `INSERT INTO rule_config_versions
      (config_hash, git_commit, run_mode, yaml_snapshot, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.configHash,
        input.gitCommit,
        input.config.global.run_mode,
        input.normalizedYaml,
        input.createdAt,
      );
    context.addRows(info.changes);
    return Number(info.lastInsertRowid);
  });
  return { id: result.value, timingIncomplete: result.timingIncomplete };
}
