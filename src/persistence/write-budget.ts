import type { SqliteDatabase } from './db.js';

export type WriteBudget = { maxRows: number; maxMs: number };
export type WriteContext = { addRows: (count?: number) => void; rows: number };
export type WriteResult<T> = {
  value: T;
  rows: number;
  elapsedMs: number;
  timingIncomplete: boolean;
};

export class WriteBudgetExceededError extends Error {
  public readonly code = 'WRITE_BUDGET_EXCEEDED';

  public constructor(message: string) {
    super(message);
    this.name = 'WriteBudgetExceededError';
  }
}

export function boundedWrite<T>(
  database: SqliteDatabase,
  budget: WriteBudget,
  operation: (context: WriteContext) => T,
): WriteResult<T> {
  const startedAt = performance.now();
  let rows = 0;
  const transaction = database.transaction(() => {
    const context: WriteContext = {
      rows,
      addRows(count = 1) {
        rows += count;
        context.rows = rows;
        if (rows > budget.maxRows)
          throw new WriteBudgetExceededError(
            `Write row budget exceeded: ${rows} > ${budget.maxRows}`,
          );
      },
    };
    return operation(context);
  });
  const value = transaction();
  const elapsedMs = performance.now() - startedAt;
  return { value, rows, elapsedMs, timingIncomplete: elapsedMs > budget.maxMs };
}
