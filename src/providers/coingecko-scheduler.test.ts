import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigText } from '../config/load.js';
import {
  CoinGeckoRestScheduler,
  FinalistReservationBook,
  FreshSingleFlightCache,
  chunkCoinGeckoPools,
  compareCoinGeckoWork,
  finalistKey,
  g2IdentityKey,
  isCreditDeferredWork,
  type CoinGeckoWorkKind,
} from './coingecko-scheduler.js';

const template = await readFile(new URL('../../config/bot.yaml', import.meta.url), 'utf8');
const baseConfig = parseConfigText(template).config.providers.coingecko;

test('pool batching covers boundaries without loss or over-50 requests', () => {
  for (const size of [0, 1, 49, 50, 51, 120]) {
    const source = Array.from({ length: size }, (_, index) => index);
    const chunks = chunkCoinGeckoPools(source);
    assert.deepEqual(chunks.flat(), source);
    assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 50));
  }
  assert.deepEqual(
    chunkCoinGeckoPools(Array.from({ length: 120 }, (_, index) => index)).map(
      (item) => item.length,
    ),
    [50, 50, 20],
  );
});

test('deadline promotion outranks normal priority and aged recheck gains candidate priority', () => {
  const item = (kind: CoinGeckoWorkKind, createdAt: number, deadlineAt?: number) => ({
    kind,
    createdAt,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    sequence: 0,
  });
  const now = 100_000;
  assert.ok(
    compareCoinGeckoWork(
      item('outcome', 99_000, 110_000),
      item('confirmation', 99_000),
      now,
      45_000,
      60_000,
    ) < 0,
  );
  assert.ok(
    compareCoinGeckoWork(
      item('recheck', 30_000),
      item('armed_batch', 99_000),
      now,
      45_000,
      60_000,
    ) < 0,
  );
});

test('credit projection blocks only low-priority discovery work', () => {
  assert.equal(isCreditDeferredWork('candidate_batch'), true);
  assert.equal(isCreditDeferredWork('recheck'), true);
  assert.equal(isCreditDeferredWork('armed_batch'), false);
  assert.equal(isCreditDeferredWork('confirmation'), false);
  assert.equal(isCreditDeferredWork('outcome'), false);
});

test('scheduler orders work, enforces request-type concurrency and single-flights keys', async () => {
  const config = structuredClone(baseConfig);
  config.scheduler.batch_concurrency = 1;
  config.scheduler.finalist_trades_concurrency = 1;
  const scheduler = new CoinGeckoRestScheduler(config);
  const order: string[] = [];
  let releases = 0;
  const enqueue = (key: string, kind: CoinGeckoWorkKind, deadlineAt?: number) =>
    scheduler.enqueue({
      key,
      kind,
      requestType: 'batch',
      createdAt: Date.now(),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      run: async () => {
        order.push(key);
        releases += 1;
        return key;
      },
    });
  const normalOutcome = enqueue('outcome-normal', 'outcome');
  const candidate = enqueue('candidate', 'candidate_batch');
  const confirmation = enqueue('confirmation', 'confirmation');
  const urgentOutcome = enqueue('outcome-urgent', 'outcome', Date.now() + 5_000);
  const duplicate = scheduler.enqueue({
    key: 'candidate',
    kind: 'candidate_batch',
    requestType: 'batch',
    createdAt: Date.now(),
    run: async () => 'must-not-run',
  });
  const values = await Promise.all([
    normalOutcome,
    candidate,
    confirmation,
    urgentOutcome,
    duplicate,
  ]);
  assert.deepEqual(order, ['outcome-urgent', 'confirmation', 'candidate', 'outcome-normal']);
  assert.equal(releases, 4);
  assert.equal(values[4], 'candidate');
  await scheduler.stop();
});

test('fresh cache reuses values and merges in-flight loads without changing evidence time', async () => {
  const cache = new FreshSingleFlightCache<{ observedAt: number }>();
  let loads = 0;
  let release!: (value: { observedAt: number }) => void;
  const load = () => {
    loads += 1;
    return new Promise<{ observedAt: number }>((resolve) => {
      release = resolve;
    });
  };
  const first = cache.getOrLoad('sol:pool', 1_000, 10_000, load);
  const merged = cache.getOrLoad('sol:pool', 2_000, 10_000, load);
  assert.equal(loads, 1);
  release({ observedAt: 2_500 });
  assert.deepEqual(await first, { observedAt: 2_500 });
  assert.deepEqual(await merged, { observedAt: 2_500 });
  assert.deepEqual(
    await cache.getOrLoad('sol:pool', 5_000, 10_000, async () => ({ observedAt: 5_000 })),
    { observedAt: 2_500 },
  );
  assert.equal(loads, 1);
});

test('finalist reservations bind cycle and pool, expire, and convert before occupying G2', () => {
  const book = new FinalistReservationBook(2);
  const first = {
    chain: 'bsc' as const,
    tokenAddress: '0xABCDEF0123456789012345678901234567890123',
    poolAddress: '0x1234567890ABCDEF1234567890ABCDEF12345678',
    cycleStartedAt: 100,
  };
  const second = { ...first, cycleStartedAt: 200 };
  const firstResult = book.acquire(first, 1_000, 500, 10);
  assert.equal(firstResult.status, 'acquired');
  assert.equal(book.acquire(first, 1_100, 500, 10).status, 'existing');
  assert.equal(book.acquire(second, 1_100, 500, 9).status, 'acquired');
  assert.equal(
    book.acquire({ ...second, cycleStartedAt: 300 }, 1_100, 500, 8).status,
    'rejected_capacity',
  );
  const preempted = book.acquire({ ...second, cycleStartedAt: 300 }, 1_100, 500, 11);
  assert.equal(preempted.status, 'acquired');
  if (preempted.status === 'acquired') assert.equal(preempted.preempted?.key, finalistKey(second));
  const firstKey = finalistKey(first);
  assert.equal(book.convertToArmed(firstKey, 1_200), true);
  assert.deepEqual(book.expire(1_700), [finalistKey({ ...second, cycleStartedAt: 300 })]);
  book.reconcileOccupied(new Set([g2IdentityKey(first)]));
  assert.deepEqual(book.clearReservations(), []);
});

test('429 blocks starts and converges concurrency before gradual recovery', () => {
  let now = Date.UTC(2026, 7, 20);
  const scheduler = new CoinGeckoRestScheduler(structuredClone(baseConfig), () => now);
  scheduler.recordRateLimit(2_000);
  let stats = scheduler.stats();
  assert.equal(stats.blockedUntil, now + 2_000);
  assert.equal(stats.batchConcurrency, baseConfig.scheduler.batch_concurrency - 1);
  assert.equal(stats.tradeConcurrency, baseConfig.scheduler.finalist_trades_concurrency - 1);
  now += 62_000;
  stats = scheduler.stats();
  assert.equal(stats.batchConcurrency, baseConfig.scheduler.batch_concurrency - 1);
  scheduler.stop(0).catch(() => undefined);
});

test('burn projection defers new scans while confirmation retains service', async () => {
  const now = Date.UTC(2026, 7, 20);
  const scheduler = new CoinGeckoRestScheduler(structuredClone(baseConfig), () => now);
  scheduler.setProviderCreditState(500_000, 100_000, now - 86_400_000);
  scheduler.setProviderCreditState(500_000, 200_000, now);
  assert.equal(scheduler.stats().creditDeferred, true);
  await assert.rejects(
    scheduler.enqueue({
      key: 'deferred-candidate',
      kind: 'candidate_batch',
      requestType: 'batch',
      createdAt: now,
      run: async () => 'candidate',
    }),
    /scheduler:credit_deferred/u,
  );
  const confirmation = scheduler.enqueue({
    key: 'protected-confirmation',
    kind: 'confirmation',
    requestType: 'batch',
    createdAt: now,
    run: async () => 'confirmation',
  });
  assert.equal(await confirmation, 'confirmation');
  assert.equal(scheduler.stats().queued, 0);
  await scheduler.stop(0);
});

test('backlog overload rejects new scans before protected work', async () => {
  const now = Date.UTC(2026, 7, 20);
  const config = structuredClone(baseConfig);
  config.scheduler.backlog_high_watermark = 1;
  config.scheduler.backlog_hard_limit = 2;
  const scheduler = new CoinGeckoRestScheduler(config, () => now);
  scheduler.blockUntil(now + 60_000);
  const first = scheduler.enqueue({
    key: 'candidate-1',
    kind: 'candidate_batch',
    requestType: 'batch',
    createdAt: now,
    run: async () => undefined,
  });
  await assert.rejects(
    scheduler.enqueue({
      key: 'candidate-2',
      kind: 'candidate_batch',
      requestType: 'batch',
      createdAt: now,
      run: async () => undefined,
    }),
    /scheduler:backlog_high_watermark/u,
  );
  const outcome = scheduler.enqueue({
    key: 'outcome',
    kind: 'outcome',
    requestType: 'batch',
    createdAt: now,
    deadlineAt: now + 1_000,
    run: async () => undefined,
  });
  const firstRejected = assert.rejects(first, /scheduler:stopped/u);
  const outcomeRejected = assert.rejects(outcome, /scheduler:stopped/u);
  await assert.rejects(
    scheduler.enqueue({
      key: 'confirmation',
      kind: 'confirmation',
      requestType: 'batch',
      createdAt: now,
      run: async () => undefined,
    }),
    /scheduler:backlog_hard_limit/u,
  );
  await scheduler.stop(0);
  await firstRejected;
  await outcomeRejected;
  assert.equal(scheduler.stats().rejected, 2);
});

test('monthly credit reset discards the previous month burn projection', () => {
  let now = Date.UTC(2026, 7, 31, 23, 59);
  const scheduler = new CoinGeckoRestScheduler(structuredClone(baseConfig), () => now);
  scheduler.setProviderCreditState(500_000, 400_000, now - 60_000);
  scheduler.setProviderCreditState(500_000, 450_000, now);
  assert.ok(scheduler.stats().burnCreditsPerHour);
  now = Date.UTC(2026, 8, 1, 0, 1);
  scheduler.setProviderCreditState(500_000, 100, now);
  assert.equal(scheduler.stats().burnCreditsPerHour, undefined);
  void scheduler.stop(0);
});

test('bounded shutdown aborts active provider requests', async () => {
  const scheduler = new CoinGeckoRestScheduler(structuredClone(baseConfig));
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  const work = scheduler.enqueue({
    key: 'active-request',
    kind: 'confirmation',
    requestType: 'batch',
    createdAt: Date.now(),
    run: (signal) =>
      new Promise<void>((_resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  });
  const rejected = assert.rejects(work, /aborted/u);
  await didStart;
  await scheduler.stop(0);
  await rejected;
});
