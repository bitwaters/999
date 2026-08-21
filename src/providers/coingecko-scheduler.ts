import type { BotConfig } from '../config/schema.js';

export type CoinGeckoWorkKind =
  'confirmation' | 'candidate_batch' | 'armed_batch' | 'recheck' | 'outcome';
export type CoinGeckoRequestType = 'batch' | 'trade';
export type CoinGeckoReserve = 'confirmation' | 'outcome' | 'shared';

export type CoinGeckoWork<T = unknown> = {
  key: string;
  kind: CoinGeckoWorkKind;
  requestType: CoinGeckoRequestType;
  chain?: 'sol' | 'bsc';
  createdAt: number;
  deadlineAt?: number;
  run: (signal: AbortSignal) => Promise<T>;
};

type PendingWork = CoinGeckoWork & {
  sequence: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export type SchedulerStats = {
  queued: number;
  running: number;
  oldestWaitMs: number;
  byKind: Record<CoinGeckoWorkKind, number>;
  blockedUntil?: number;
  effectiveRpm: number;
  batchConcurrency: number;
  tradeConcurrency: number;
  creditDeferred: boolean;
  remainingCredits?: number;
  burnCreditsPerHour?: number;
  projectedExhaustionAt?: number;
  completed: number;
  failed: number;
  rejected: number;
  lastQueueWaitMs: number;
  lastRunLatencyMs: number;
};

const normalPriority: Record<CoinGeckoWorkKind, number> = {
  confirmation: 0,
  candidate_batch: 1,
  armed_batch: 2,
  recheck: 3,
  outcome: 4,
};

export function chunkCoinGeckoPools<T>(items: readonly T[], limit = 50): T[][] {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 50)
    throw new Error('Invalid CoinGecko pool batch limit');
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += limit)
    chunks.push(items.slice(index, index + limit));
  return chunks;
}

export function reserveFor(kind: CoinGeckoWorkKind): CoinGeckoReserve {
  if (kind === 'confirmation') return 'confirmation';
  if (kind === 'outcome') return 'outcome';
  return 'shared';
}

export function compareCoinGeckoWork(
  left: Pick<PendingWork, 'kind' | 'createdAt' | 'deadlineAt' | 'sequence'>,
  right: Pick<PendingWork, 'kind' | 'createdAt' | 'deadlineAt' | 'sequence'>,
  now: number,
  deadlinePromotionMs: number,
  maxDynamicWaitMs: number,
): number {
  const leftUrgent = left.deadlineAt !== undefined && left.deadlineAt - now <= deadlinePromotionMs;
  const rightUrgent =
    right.deadlineAt !== undefined && right.deadlineAt - now <= deadlinePromotionMs;
  if (leftUrgent !== rightUrgent) return leftUrgent ? -1 : 1;
  if (leftUrgent && rightUrgent && left.deadlineAt !== right.deadlineAt)
    return left.deadlineAt! - right.deadlineAt!;
  const priority = (item: typeof left) =>
    item.kind === 'recheck' && now - item.createdAt >= maxDynamicWaitMs
      ? normalPriority.candidate_batch
      : normalPriority[item.kind];
  const priorityDifference = priority(left) - priority(right);
  if (priorityDifference !== 0) return priorityDifference;
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.sequence - right.sequence;
}

export class CoinGeckoRestScheduler {
  private readonly pending: PendingWork[] = [];
  private readonly pendingByKey = new Map<string, Promise<unknown>>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly requestStarts: Array<{ at: number; reserve: CoinGeckoReserve }> = [];
  private runningBatch = 0;
  private runningTrade = 0;
  private sequence = 0;
  private providerRpm: number | undefined;
  private blockedUntil = 0;
  private batchConcurrency: number;
  private tradeConcurrency: number;
  private concurrencyRecoveryAt = 0;
  private providerMonthlyCredits: number | undefined;
  private providerCreditsUsed: number | undefined;
  private creditObservedAt: number | undefined;
  private creditMonth: string | undefined;
  private burnCreditsPerMs: number | undefined;
  private completed = 0;
  private failed = 0;
  private rejected = 0;
  private lastQueueWaitMs = 0;
  private lastRunLatencyMs = 0;
  private wakeTimer: NodeJS.Timeout | undefined;
  private accepting = true;
  private stopping = false;

  public constructor(
    private readonly config: BotConfig['providers']['coingecko'],
    private readonly now: () => number = Date.now,
  ) {
    this.batchConcurrency = config.scheduler.batch_concurrency;
    this.tradeConcurrency = config.scheduler.finalist_trades_concurrency;
  }

  public setProviderRpm(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid provider RPM');
    this.providerRpm = value;
    this.scheduleDrain();
  }

  public blockUntil(timestamp: number): void {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid block time');
    this.blockedUntil = Math.max(this.blockedUntil, timestamp);
    this.scheduleDrain();
  }

  public recordRateLimit(retryAfterMs = 1_000): void {
    const now = this.now();
    this.blockUntil(now + Math.max(1, retryAfterMs));
    this.batchConcurrency = Math.max(1, this.batchConcurrency - 1);
    this.tradeConcurrency = Math.max(1, this.tradeConcurrency - 1);
    this.concurrencyRecoveryAt = Math.max(this.concurrencyRecoveryAt, now + 60_000);
  }

  public setProviderCreditState(
    monthlyCredits: number,
    usedCredits: number,
    observedAt: number,
  ): void {
    if (
      !Number.isSafeInteger(monthlyCredits) ||
      monthlyCredits <= 0 ||
      !Number.isSafeInteger(usedCredits) ||
      usedCredits < 0 ||
      !Number.isSafeInteger(observedAt) ||
      observedAt < 0
    )
      throw new Error('Invalid provider credit state');
    const month = new Date(observedAt).toISOString().slice(0, 7);
    if (
      this.creditMonth !== undefined &&
      (this.creditMonth !== month ||
        (this.providerCreditsUsed !== undefined && usedCredits < this.providerCreditsUsed))
    )
      this.burnCreditsPerMs = undefined;
    else if (
      this.providerCreditsUsed !== undefined &&
      this.creditObservedAt !== undefined &&
      observedAt > this.creditObservedAt &&
      usedCredits >= this.providerCreditsUsed
    ) {
      const sampleBurn =
        (usedCredits - this.providerCreditsUsed) / (observedAt - this.creditObservedAt);
      if (sampleBurn >= 0)
        this.burnCreditsPerMs =
          this.burnCreditsPerMs === undefined
            ? sampleBurn > 0
              ? sampleBurn
              : undefined
            : this.burnCreditsPerMs * 0.7 + sampleBurn * 0.3;
    }
    this.providerMonthlyCredits = monthlyCredits;
    this.providerCreditsUsed = usedCredits;
    this.creditObservedAt = observedAt;
    this.creditMonth = month;
    this.scheduleDrain();
  }

  public enqueue<T>(work: CoinGeckoWork<T>): Promise<T> {
    validateWork(work);
    if (!this.accepting) return Promise.reject(new Error('scheduler:stopping'));
    const existing = this.pendingByKey.get(work.key);
    if (existing) return existing as Promise<T>;
    if (
      this.creditStatus(this.now()).deferred &&
      (work.kind === 'candidate_batch' || work.kind === 'recheck')
    ) {
      this.rejected += 1;
      return Promise.reject(new Error('scheduler:credit_deferred'));
    }
    if (
      this.pending.length >= this.config.scheduler.backlog_high_watermark &&
      (work.kind === 'candidate_batch' || work.kind === 'recheck')
    ) {
      this.rejected += 1;
      return Promise.reject(new Error('scheduler:backlog_high_watermark'));
    }
    if (this.pending.length >= this.config.scheduler.backlog_hard_limit) {
      this.rejected += 1;
      return Promise.reject(new Error('scheduler:backlog_hard_limit'));
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.push({
        ...work,
        sequence: this.sequence++,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.pendingByKey.set(work.key, promise);
    void promise.finally(() => this.pendingByKey.delete(work.key)).catch(() => undefined);
    this.scheduleDrain();
    return promise;
  }

  public stats(at = this.now()): SchedulerStats {
    const byKind: Record<CoinGeckoWorkKind, number> = {
      confirmation: 0,
      candidate_batch: 0,
      armed_batch: 0,
      recheck: 0,
      outcome: 0,
    };
    for (const work of this.pending) byKind[work.kind] += 1;
    const credit = this.creditStatus(at);
    return {
      queued: this.pending.length,
      running: this.runningBatch + this.runningTrade,
      oldestWaitMs:
        this.pending.length === 0
          ? 0
          : Math.max(0, at - Math.min(...this.pending.map((work) => work.createdAt))),
      byKind,
      ...(this.blockedUntil > at ? { blockedUntil: this.blockedUntil } : {}),
      effectiveRpm: this.effectiveRpm(),
      batchConcurrency: this.batchConcurrency,
      tradeConcurrency: this.tradeConcurrency,
      creditDeferred: credit.deferred,
      ...(credit.remaining === undefined ? {} : { remainingCredits: credit.remaining }),
      ...(credit.burnPerHour === undefined ? {} : { burnCreditsPerHour: credit.burnPerHour }),
      ...(credit.projectedExhaustionAt === undefined
        ? {}
        : { projectedExhaustionAt: credit.projectedExhaustionAt }),
      completed: this.completed,
      failed: this.failed,
      rejected: this.rejected,
      lastQueueWaitMs: this.lastQueueWaitMs,
      lastRunLatencyMs: this.lastRunLatencyMs,
    };
  }

  public async stop(drainMs = this.config.scheduler.shutdown_drain_ms): Promise<void> {
    this.accepting = false;
    this.scheduleDrain();
    const deadline = this.now() + drainMs;
    while (
      (this.pending.length > 0 || this.runningBatch + this.runningTrade > 0) &&
      this.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    this.stopping = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    for (const controller of this.activeControllers) controller.abort('scheduler:stopped');
    for (const work of this.pending.splice(0)) work.reject(new Error('scheduler:stopped'));
  }

  private effectiveRpm(): number {
    return Math.min(
      this.config.rest_requests_per_minute,
      this.providerRpm ?? Number.MAX_SAFE_INTEGER,
    );
  }

  private scheduleDrain(delayMs = 0): void {
    if (this.stopping || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.drain();
    }, delayMs);
  }

  private drain(): void {
    if (this.stopping) return;
    const now = this.now();
    this.recoverConcurrency(now);
    if (this.blockedUntil > now) {
      this.scheduleDrain(this.blockedUntil - now);
      return;
    }
    this.pruneStarts(now);
    this.pending.sort((left, right) =>
      compareCoinGeckoWork(
        left,
        right,
        now,
        this.config.scheduler.deadline_promotion_seconds * 1000,
        this.config.scheduler.max_dynamic_wait_seconds * 1000,
      ),
    );
    let started = false;
    for (let index = 0; index < this.pending.length;) {
      const work = this.pending[index]!;
      if (
        !this.hasConcurrency(work.requestType) ||
        !this.hasRateCapacity(work.kind) ||
        !this.hasCreditCapacity(work.kind, now)
      ) {
        index += 1;
        continue;
      }
      this.pending.splice(index, 1);
      this.start(work);
      started = true;
    }
    if (this.pending.length > 0 && !started) {
      const oldest = this.requestStarts[0]?.at;
      this.scheduleDrain(oldest === undefined ? 1_000 : Math.max(1, oldest + 60_000 - now));
    }
  }

  private hasConcurrency(type: CoinGeckoRequestType): boolean {
    return type === 'batch'
      ? this.runningBatch < this.batchConcurrency
      : this.runningTrade < this.tradeConcurrency;
  }

  private hasCreditCapacity(kind: CoinGeckoWorkKind, now: number): boolean {
    if (!this.creditStatus(now).deferred) return true;
    return kind !== 'candidate_batch' && kind !== 'recheck';
  }

  private hasRateCapacity(kind: CoinGeckoWorkKind): boolean {
    const rpm = this.effectiveRpm();
    if (this.requestStarts.length >= rpm) return false;
    const reserve = reserveFor(kind);
    const confirmationReserve = Math.floor(
      (rpm * this.config.scheduler.confirmation_reserved_percent) / 100,
    );
    const outcomeReserve = Math.floor((rpm * this.config.scheduler.outcome_reserved_percent) / 100);
    const sharedLimit = rpm - confirmationReserve - outcomeReserve;
    if (reserve === 'shared') return this.requestStarts.length < sharedLimit;
    const used = this.requestStarts.filter((start) => start.reserve === reserve).length;
    const ownReserve = reserve === 'confirmation' ? confirmationReserve : outcomeReserve;
    return used < ownReserve || this.requestStarts.length < sharedLimit;
  }

  private start(work: PendingWork): void {
    const startedAt = this.now();
    const controller = new AbortController();
    this.activeControllers.add(controller);
    this.lastQueueWaitMs = Math.max(0, startedAt - work.createdAt);
    const reserve = reserveFor(work.kind);
    this.requestStarts.push({ at: startedAt, reserve });
    if (work.requestType === 'batch') this.runningBatch += 1;
    else this.runningTrade += 1;
    void work
      .run(controller.signal)
      .then(
        (value) => {
          this.completed += 1;
          work.resolve(value);
        },
        (error: unknown) => {
          this.failed += 1;
          work.reject(error);
        },
      )
      .finally(() => {
        this.activeControllers.delete(controller);
        this.lastRunLatencyMs = Math.max(0, this.now() - startedAt);
        if (work.requestType === 'batch') this.runningBatch -= 1;
        else this.runningTrade -= 1;
        this.scheduleDrain();
      });
  }

  private pruneStarts(now: number): void {
    while (this.requestStarts.length > 0 && now - this.requestStarts[0]!.at >= 60_000)
      this.requestStarts.shift();
  }

  private recoverConcurrency(now: number): void {
    if (this.concurrencyRecoveryAt === 0 || now < this.concurrencyRecoveryAt) return;
    this.batchConcurrency = Math.min(
      this.config.scheduler.batch_concurrency,
      this.batchConcurrency + 1,
    );
    this.tradeConcurrency = Math.min(
      this.config.scheduler.finalist_trades_concurrency,
      this.tradeConcurrency + 1,
    );
    this.concurrencyRecoveryAt =
      this.batchConcurrency === this.config.scheduler.batch_concurrency &&
      this.tradeConcurrency === this.config.scheduler.finalist_trades_concurrency
        ? 0
        : now + 60_000;
  }

  private creditStatus(now: number): {
    deferred: boolean;
    remaining?: number;
    burnPerHour?: number;
    projectedExhaustionAt?: number;
  } {
    if (this.providerMonthlyCredits === undefined || this.providerCreditsUsed === undefined)
      return { deferred: false };
    const limit = Math.min(this.config.monthly_credits, this.providerMonthlyCredits);
    const remaining = Math.max(0, limit - this.providerCreditsUsed);
    const burnPerHour =
      this.burnCreditsPerMs === undefined ? undefined : this.burnCreditsPerMs * 3_600_000;
    const projectedExhaustionAt =
      this.burnCreditsPerMs === undefined || this.burnCreditsPerMs <= 0
        ? undefined
        : now + remaining / this.burnCreditsPerMs;
    const monthEnd = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1);
    return {
      deferred:
        remaining === 0 ||
        (projectedExhaustionAt !== undefined && projectedExhaustionAt < monthEnd),
      remaining,
      ...(burnPerHour === undefined ? {} : { burnPerHour }),
      ...(projectedExhaustionAt === undefined ? {} : { projectedExhaustionAt }),
    };
  }
}

export class FreshSingleFlightCache<T> {
  private readonly values = new Map<string, { observedAt: number; value: T }>();
  private readonly inFlight = new Map<string, Promise<T>>();

  public getOrLoad(key: string, now: number, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    if (cached && now - cached.observedAt <= ttlMs) return Promise.resolve(cached.value);
    const active = this.inFlight.get(key);
    if (active) return active;
    const promise = load()
      .then((value) => {
        this.values.set(key, { observedAt: now, value });
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  public clear(): void {
    this.values.clear();
  }
}

export type FinalistIdentity = {
  chain: 'sol' | 'bsc';
  tokenAddress: string;
  poolAddress: string;
  cycleStartedAt: number;
};

type Reservation = FinalistIdentity & { key: string; expiresAt: number; priority: number };

export class FinalistReservationBook {
  private readonly reservations = new Map<string, Reservation>();
  private occupied = new Set<string>();

  public constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error('Invalid G2 capacity');
  }

  public reconcileOccupied(keys: ReadonlySet<string>): void {
    this.occupied = new Set(keys);
    for (const [key, reservation] of this.reservations) {
      if (keys.has(g2IdentityKey(reservation))) this.reservations.delete(key);
    }
  }

  public acquire(
    identity: FinalistIdentity,
    now: number,
    ttlMs: number,
    priority: number,
  ):
    | { status: 'acquired' | 'existing'; reservation: Reservation; preempted?: Reservation }
    | { status: 'rejected_capacity' } {
    this.expire(now);
    const key = finalistKey(identity);
    const existing = this.reservations.get(key);
    if (existing) return { status: 'existing', reservation: existing };
    if (this.occupied.has(g2IdentityKey(identity))) return { status: 'rejected_capacity' };
    let preempted: Reservation | undefined;
    if (this.occupied.size + this.reservations.size >= this.capacity) {
      preempted = [...this.reservations.values()].sort(
        (left, right) => left.priority - right.priority || right.expiresAt - left.expiresAt,
      )[0];
      if (!preempted || preempted.priority >= priority) return { status: 'rejected_capacity' };
      this.reservations.delete(preempted.key);
    }
    const reservation = { ...identity, key, expiresAt: now + ttlMs, priority };
    this.reservations.set(key, reservation);
    return { status: 'acquired', reservation, ...(preempted ? { preempted } : {}) };
  }

  public convertToArmed(key: string, now: number): boolean {
    this.expire(now);
    const reservation = this.reservations.get(key);
    if (!reservation) return false;
    this.reservations.delete(key);
    this.occupied.add(g2IdentityKey(reservation));
    return true;
  }

  public release(key: string): boolean {
    return this.reservations.delete(key);
  }

  public releaseOccupied(key: string): boolean {
    return this.occupied.delete(key);
  }

  public expire(now: number): string[] {
    const expired: string[] = [];
    for (const [key, reservation] of this.reservations) {
      if (reservation.expiresAt > now) continue;
      this.reservations.delete(key);
      expired.push(key);
    }
    return expired;
  }

  public clearReservations(): string[] {
    const keys = [...this.reservations.keys()];
    this.reservations.clear();
    return keys;
  }

  public size(): number {
    return this.reservations.size;
  }
}

export function finalistKey(identity: FinalistIdentity): string {
  const token =
    identity.chain === 'bsc' ? identity.tokenAddress.toLowerCase() : identity.tokenAddress;
  const pool = identity.chain === 'bsc' ? identity.poolAddress.toLowerCase() : identity.poolAddress;
  return `${identity.chain}:${token}:${identity.cycleStartedAt}:${pool}`;
}

export function g2IdentityKey(identity: Omit<FinalistIdentity, 'cycleStartedAt'>): string {
  const token =
    identity.chain === 'bsc' ? identity.tokenAddress.toLowerCase() : identity.tokenAddress;
  const pool = identity.chain === 'bsc' ? identity.poolAddress.toLowerCase() : identity.poolAddress;
  return `${identity.chain}:${pool}:${token}`;
}

function validateWork(work: CoinGeckoWork): void {
  if (!work.key || !Number.isSafeInteger(work.createdAt) || work.createdAt < 0)
    throw new Error('Invalid scheduler work');
  if (
    work.deadlineAt !== undefined &&
    (!Number.isSafeInteger(work.deadlineAt) || work.deadlineAt < 0)
  )
    throw new Error('Invalid scheduler deadline');
}
