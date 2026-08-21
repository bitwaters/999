import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { parseDecimalString, parseInteger, parseTimestampMs } from '../providers/parsing.js';
import type { CanonicalPool } from './pools.js';

export type RawG2Item = Record<string, unknown>;

export type NormalizedTrade = {
  chain: CanonicalPool['chain'];
  poolAddress: string;
  tokenAddress: string;
  rawSide: 'buy' | 'sell';
  targetSide: 'buy' | 'sell';
  tokenAmount: string;
  quoteAmount: string;
  priceUsd: string;
  eventAt: number;
  observedAt: number;
  providerTradeId?: string;
  txHash?: string;
  logIndex?: number;
  legIndex?: number;
  itemIndex: number;
  identityKey?: string;
  dedupStatus: 'unique' | 'duplicate';
  ambiguityStatus: 'none' | 'ambiguous';
  fingerprint: string;
};

export type G2ParseResult =
  { status: 'complete'; trade: NormalizedTrade } | { status: 'invalid'; reason: string };

export function normalizeG2Item(
  raw: RawG2Item,
  pool: CanonicalPool,
  observedAt: number,
  itemIndex = 0,
): G2ParseResult {
  try {
    if (raw.c !== undefined && raw.c !== 'G2') throw new Error('invalid:capability');
    if (raw.n !== undefined && raw.n !== networkForChain(pool.chain))
      throw new Error('invalid:network');
    if (raw.pa !== undefined && raw.pa !== pool.poolAddress)
      throw new Error('identity:pool_address');
    const rawSide = parseSide(raw.ty);
    const eventAt = parseTimestampMs(raw.t);
    const tokenAmount = parseG2Decimal(raw.to);
    const quoteAmount = parseG2Decimal(raw.toq);
    if (tokenAmount.isZero()) throw new Error('invalid:zero_token_amount');
    const identity = optionalIdentity(raw);
    const item = parseInteger(raw.item_index ?? itemIndex, { min: 0 });
    const txHash = optionalString(raw.tx_hash);
    const logIndex = optionalInteger(raw.log_index);
    const legIndex = optionalInteger(raw.leg_index);
    const fingerprint = [
      pool.chain,
      pool.poolAddress,
      rawSide,
      eventAt,
      tokenAmount.toString(),
      quoteAmount.toString(),
      item,
    ].join('|');
    return {
      status: 'complete',
      trade: {
        chain: pool.chain,
        poolAddress: pool.poolAddress,
        tokenAddress: pool.tokenAddress,
        rawSide,
        targetSide: pool.targetSide === 'base' ? rawSide : invertSide(rawSide),
        tokenAmount: tokenAmount.toString(),
        quoteAmount: quoteAmount.toString(),
        priceUsd: quoteAmount.div(tokenAmount).toString(),
        eventAt,
        observedAt: parseTimestampMs(observedAt),
        ...(identity ? { providerTradeId: identity } : {}),
        ...(txHash ? { txHash } : {}),
        ...(logIndex !== undefined ? { logIndex } : {}),
        ...(legIndex !== undefined ? { legIndex } : {}),
        itemIndex: item,
        ...(identity
          ? { identityKey: `provider:${identity}` }
          : txHash && (logIndex !== undefined || legIndex !== undefined)
            ? { identityKey: `tx:${txHash}:${logIndex ?? ''}:${legIndex ?? ''}` }
            : {}),
        dedupStatus: 'unique',
        ambiguityStatus: 'none',
        fingerprint,
      },
    };
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : 'invalid:g2' };
  }
}

export class TradeDeduper {
  private readonly messages = new Set<string>();
  private readonly identities = new Map<string, string>();
  private readonly fingerprints = new Set<string>();

  ingest(
    messageKey: string,
    trades: readonly NormalizedTrade[],
  ): {
    duplicateMessage: boolean;
    trades: NormalizedTrade[];
  } {
    if (this.messages.has(messageKey))
      return {
        duplicateMessage: true,
        trades: trades.map((trade) => ({ ...trade, dedupStatus: 'duplicate' })),
      };
    this.messages.add(messageKey);
    return {
      duplicateMessage: false,
      trades: trades.map((trade) => {
        if (trade.identityKey) {
          const previous = this.identities.get(trade.identityKey);
          if (previous === undefined) {
            this.identities.set(trade.identityKey, trade.fingerprint);
            return trade;
          }
          if (previous === trade.fingerprint) return { ...trade, dedupStatus: 'duplicate' };
          return { ...trade, ambiguityStatus: 'ambiguous' };
        }
        if (this.fingerprints.has(trade.fingerprint))
          return { ...trade, ambiguityStatus: 'ambiguous' };
        this.fingerprints.add(trade.fingerprint);
        return trade;
      }),
    };
  }
}

export type G2Window = {
  status: 'complete' | 'partial' | 'zero' | 'incomplete';
  windowStart: number;
  windowEnd: number;
  coverageSeconds: number;
  lateCount: number;
  duplicateCount: number;
  ambiguousCount: number;
  buyVolumeUsd: string;
  sellVolumeUsd: string;
  netBuyUsd: string;
  buyVolumeShare?: string;
  top1BuyShare?: string;
  top3BuyShare?: string;
};

export function aggregateG2Window(
  trades: readonly NormalizedTrade[],
  windowStart: number,
  windowEnd: number,
  observedAt: number,
): G2Window {
  const duplicateCount = trades.filter((trade) => trade.dedupStatus === 'duplicate').length;
  const ambiguousCount = trades.filter((trade) => trade.ambiguityStatus === 'ambiguous').length;
  const lateCount = trades.filter((trade) => trade.eventAt < windowStart).length;
  const inWindow = trades.filter(
    (trade) =>
      trade.eventAt >= windowStart &&
      trade.eventAt < windowEnd &&
      trade.dedupStatus === 'unique' &&
      trade.ambiguityStatus === 'none',
  );
  let buy = new Decimal(0);
  let sell = new Decimal(0);
  let invalidNumeric = false;
  const buyVolumes: Decimal[] = [];
  for (const trade of inWindow) {
    let amount: Decimal;
    try {
      amount = parseDecimalString(trade.quoteAmount, { nonNegative: true });
    } catch {
      invalidNumeric = true;
      continue;
    }
    if (trade.targetSide === 'buy') {
      buy = buy.plus(amount);
      buyVolumes.push(amount);
    } else sell = sell.plus(amount);
  }
  const total = buy.plus(sell);
  const status =
    ambiguousCount > 0 || invalidNumeric
      ? 'incomplete'
      : observedAt < windowEnd
        ? 'partial'
        : total.isZero()
          ? 'zero'
          : 'complete';
  buyVolumes.sort((left, right) => right.comparedTo(left));
  return {
    status,
    windowStart,
    windowEnd,
    coverageSeconds: Math.max(
      0,
      Math.floor((Math.min(observedAt, windowEnd) - windowStart) / 1000),
    ),
    lateCount,
    duplicateCount,
    ambiguousCount,
    buyVolumeUsd: buy.toString(),
    sellVolumeUsd: sell.toString(),
    netBuyUsd: buy.minus(sell).toString(),
    ...(total.isZero() ? {} : { buyVolumeShare: buy.div(total).toString() }),
    ...(buy.isZero()
      ? {}
      : {
          top1BuyShare: buyVolumes[0]!.div(buy).toString(),
          top3BuyShare: buyVolumes
            .slice(0, 3)
            .reduce((sum, item) => sum.plus(item), new Decimal(0))
            .div(buy)
            .toString(),
        }),
  };
}

export type G2SubscriptionState = 'armed' | 'confirmed-pending-anchor';

export class G2SubscriptionManager {
  private connected = false;
  private readonly subscriptions = new Map<string, G2SubscriptionState>();

  constructor(private readonly maxSubscriptions: number) {
    if (!Number.isSafeInteger(maxSubscriptions) || maxSubscriptions <= 0)
      throw new Error('Invalid G2 subscription limit');
  }

  connect(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  request(
    pool: CanonicalPool,
    state: G2SubscriptionState,
  ): 'subscribe' | 'retain' | 'rejected_capacity' {
    if (this.subscriptions.has(pool.identityKey)) {
      this.subscriptions.set(pool.identityKey, state);
      return 'retain';
    }
    if (state !== 'armed' || this.subscriptions.size >= this.maxSubscriptions)
      return 'rejected_capacity';
    this.subscriptions.set(pool.identityKey, state);
    return 'subscribe';
  }

  confirm(poolIdentityKey: string): boolean {
    return this.connected && this.subscriptions.has(poolIdentityKey);
  }

  unset(poolIdentityKey: string): boolean {
    return this.subscriptions.delete(poolIdentityKey);
  }

  reconnectPlan(): string[] {
    return this.connected ? [] : [...this.subscriptions.keys()];
  }

  active(): ReadonlyMap<string, G2SubscriptionState> {
    return new Map(this.subscriptions);
  }
}

export type G2QueueItem<T> = { observedAt: number; priority: number; value: T };

export class G2IngestQueue<T> {
  private readonly items: G2QueueItem<T>[] = [];
  private readonly incompleteReasons: string[] = [];

  constructor(
    private readonly capacity: number,
    private readonly highWatermark: number,
    private readonly hardLimit: number,
    private readonly hooks: { onHighWatermark?: () => void; onHardLimit?: () => void } = {},
  ) {
    if (!(highWatermark < hardLimit && hardLimit <= capacity) || capacity <= 0)
      throw new Error('Invalid G2 queue watermarks');
  }

  enqueue(
    value: T,
    observedAt: number,
    priority: number,
  ): { accepted: boolean; hardLimit: boolean } {
    if (!Number.isSafeInteger(observedAt) || observedAt < 0)
      throw new Error('Invalid G2 observedAt');
    if (this.items.length >= this.hardLimit) {
      this.incompleteReasons.push('queue:hard_limit');
      this.hooks.onHardLimit?.();
      return { accepted: false, hardLimit: true };
    }
    this.items.push({ observedAt, priority, value });
    if (this.items.length === this.highWatermark) this.hooks.onHighWatermark?.();
    return { accepted: true, hardLimit: false };
  }

  atHighWatermark(): boolean {
    return this.items.length >= this.highWatermark;
  }

  drain(limit: number): G2QueueItem<T>[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid G2 drain limit');
    return this.items.splice(0, limit);
  }

  dropLowestPriority(): G2QueueItem<T> | undefined {
    if (this.items.length === 0) return undefined;
    let lowestIndex = 0;
    for (let index = 1; index < this.items.length; index += 1)
      if (this.items[index]!.priority < this.items[lowestIndex]!.priority) lowestIndex = index;
    return this.items.splice(lowestIndex, 1)[0];
  }

  size(): number {
    return this.items.length;
  }

  markIncomplete(reason: string): void {
    this.incompleteReasons.push(reason);
  }

  integrity(): { status: 'complete' | 'incomplete'; reasons: string[] } {
    return {
      status: this.incompleteReasons.length > 0 ? 'incomplete' : 'complete',
      reasons: [...this.incompleteReasons],
    };
  }
}

export function hashG2Message(raw: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(raw) ?? '')
    .digest('hex');
}

function networkForChain(chain: CanonicalPool['chain']): string {
  return chain === 'sol' ? 'solana' : 'bsc';
}

function parseSide(value: unknown): 'buy' | 'sell' {
  if (value === 'buy' || value === 'b') return 'buy';
  if (value === 'sell' || value === 's') return 'sell';
  throw new Error('invalid:side');
}

function parseG2Decimal(value: unknown): Decimal {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid G2 numeric value');
    return parseDecimalString(new Decimal(value).toFixed(), { nonNegative: true });
  }
  return parseDecimalString(value, { nonNegative: true });
}

function invertSide(side: 'buy' | 'sell'): 'buy' | 'sell' {
  return side === 'buy' ? 'sell' : 'buy';
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    throw new Error('invalid:string');
  return value;
}

function optionalIdentity(raw: RawG2Item): string | undefined {
  const value = raw.trade_id ?? raw.id;
  return optionalString(value);
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return parseInteger(value, { min: 0 });
}
