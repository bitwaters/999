import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutcomeReport, type ReportOutcome } from './report.js';

const outcomes: ReportOutcome[] = [
  {
    configVersionId: 'config-1',
    runMode: 'shadow',
    anchorDeliveredAt: 1_000,
    executionStatus: 'executable',
    deliveryDrift: '0.1',
    credits: '2',
    latencyMs: 10,
    horizons: [
      { horizonSeconds: 60, status: 'complete', forwardReturn: '0.2', mfe: '0.3', mae: '-0.1' },
    ],
  },
  {
    configVersionId: 'config-1',
    runMode: 'shadow',
    anchorDeliveredAt: 2_000,
    executionStatus: 'not_executable',
    horizons: [{ horizonSeconds: 60, status: 'late_entry' }],
  },
  {
    configVersionId: 'config-1',
    runMode: 'shadow',
    anchorDeliveredAt: 3_000,
    executionStatus: 'incomplete',
    horizons: [{ horizonSeconds: 60, status: 'incomplete' }],
  },
];

test('report preserves denominator and only averages executable complete outcomes', () => {
  const report = buildOutcomeReport({
    outcomes,
    configVersionId: 'config-1',
    runMode: 'shadow',
    startAt: 0,
    endAt: 4_000,
    maxRows: 10,
  });
  assert.equal(report.denominator, 3);
  assert.deepEqual(report.executionCounts, { executable: 1, not_executable: 1, incomplete: 1 });
  assert.equal(report.executableRate, '0.33333333333333333333');
  assert.equal(report.returnsSampleCount, 1);
  assert.equal(report.averageForwardReturn, '0.2');
  assert.deepEqual(report.horizonCounts['60'], { complete: 1, late_entry: 1, incomplete: 1 });
  assert.equal(report.horizonRates['60']?.timelyExecutableRate, '0.33333333333333333333');
  assert.equal(report.horizonRates['60']?.completeRate, '0.33333333333333333333');
  assert.equal(report.totalCredits, '2');
});

test('report rejects unbounded or inverted query ranges', () => {
  const base = {
    outcomes,
    configVersionId: 'config-1' as const,
    runMode: 'shadow' as const,
    startAt: 0,
    endAt: 4_000,
    maxRows: 10,
  };
  assert.throws(
    () => buildOutcomeReport({ ...base, maxRows: 0 }),
    /maxRows must be a positive integer/,
  );
  assert.throws(
    () => buildOutcomeReport({ ...base, startAt: 10, endAt: 9 }),
    /Invalid report time range/,
  );
});
