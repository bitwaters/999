import { Decimal } from 'decimal.js';
import type { BotConfig } from '../config/schema.js';
import type { DataState } from '../providers/types.js';
import { parseDecimalString, parseInteger } from '../providers/parsing.js';

export type AgeMode = 'newborn' | 'early' | 'established';
export type WindowKey = 'm1' | 'm5' | 'm15' | 'm30';

export type AgeClassification =
  { status: 'valid'; mode: AgeMode; ageSeconds: number } | { status: 'invalid'; reason: string };

export type WindowStats = {
  state: DataState;
  coverageSeconds: number;
  buys: number;
  buyers: number;
  volumeUsd: string;
};

export type AgeEvaluation =
  | {
      status: 'pass';
      mode: AgeMode;
      coverageSeconds: number;
      rates: { buys: string; buyers: string; volumeUsd: string };
    }
  | { status: 'rejected' | 'incomplete' | 'invalid'; mode?: AgeMode; reason: string };

type AgeConfig = Pick<BotConfig['chains']['sol'], 'newborn' | 'established'>;

export function classifyAge(
  poolCreatedAt: number,
  decisionTime: number,
  config: AgeConfig,
  maxClockSkewSeconds: number,
): AgeClassification {
  if (
    !Number.isSafeInteger(poolCreatedAt) ||
    poolCreatedAt < 0 ||
    !Number.isSafeInteger(decisionTime) ||
    decisionTime < 0 ||
    !Number.isFinite(maxClockSkewSeconds) ||
    maxClockSkewSeconds < 0
  )
    return { status: 'invalid', reason: 'invalid:age_clock' };
  if (poolCreatedAt > decisionTime + maxClockSkewSeconds * 1000)
    return { status: 'invalid', reason: 'invalid:future_pool_created_at' };
  const ageSeconds = Math.max(0, Math.floor((decisionTime - poolCreatedAt) / 1000));
  const mode: AgeMode =
    ageSeconds <= config.newborn.max_age_seconds
      ? 'newborn'
      : ageSeconds < config.established.min_age_seconds
        ? 'early'
        : 'established';
  return { status: 'valid', mode, ageSeconds };
}

export function evaluateAge(
  poolCreatedAt: number,
  decisionTime: number,
  config: AgeConfig,
  maxClockSkewSeconds: number,
  windows: Partial<Record<WindowKey, WindowStats>>,
  g2ObservationSeconds: number,
): AgeEvaluation {
  const classification = classifyAge(poolCreatedAt, decisionTime, config, maxClockSkewSeconds);
  if (classification.status === 'invalid') return classification;
  const { mode } = classification;
  if (!Number.isFinite(g2ObservationSeconds) || g2ObservationSeconds < 0)
    return { status: 'invalid', mode, reason: 'invalid:g2_observation_seconds' };

  if (mode === 'established') {
    for (const window of config.established.required_windows) {
      const stats = windows[window];
      if (!stats || stats.state !== 'complete')
        return {
          status: 'incomplete',
          mode,
          reason: `window:${window}:${stats?.state ?? 'missing'}`,
        };
    }
    return buildRates(mode, windows.m5 ?? windows.m15 ?? windows.m30);
  }

  if (g2ObservationSeconds < config.newborn.min_g2_observation_seconds)
    return { status: 'incomplete', mode, reason: 'g2:insufficient_observation' };
  const stats = usableYoungWindow(windows);
  if (!stats) return { status: 'incomplete', mode, reason: 'window:m1_or_partial_m5' };
  const base = buildRates(mode, stats);
  if (base.status !== 'pass') return base;
  const volume = parseDecimalString(stats.volumeUsd, { nonNegative: true });
  const minAbsolute = config.newborn.min_absolute;
  const minRate = config.newborn.min_rate_per_second;
  if (
    stats.buys < minAbsolute.buys ||
    stats.buyers < minAbsolute.buyers ||
    volume.lessThan(String(minAbsolute.volume_usd)) ||
    new Decimal(base.rates.buys).lessThan(String(minRate.buys)) ||
    new Decimal(base.rates.buyers).lessThan(String(minRate.buyers)) ||
    new Decimal(base.rates.volumeUsd).lessThan(String(minRate.volume_usd))
  )
    return { status: 'rejected', mode, reason: 'sample:below_newborn_threshold' };
  return base;
}

function usableYoungWindow(
  windows: Partial<Record<WindowKey, WindowStats>>,
): WindowStats | undefined {
  const m1 = windows.m1;
  if (m1 && (m1.state === 'complete' || m1.state === 'partial')) return m1;
  const m5 = windows.m5;
  if (m5 && (m5.state === 'complete' || m5.state === 'partial')) return m5;
  return undefined;
}

function buildRates(mode: AgeMode, stats: WindowStats | undefined): AgeEvaluation {
  if (!stats) return { status: 'incomplete', mode, reason: 'window:missing' };
  if (stats.state !== 'complete' && stats.state !== 'partial')
    return { status: 'incomplete', mode, reason: `window:${stats.state}` };
  try {
    const coverageSeconds = parseInteger(stats.coverageSeconds, { min: 1 });
    const buys = parseInteger(stats.buys, { min: 0 });
    const buyers = parseInteger(stats.buyers, { min: 0 });
    const volume = parseDecimalString(stats.volumeUsd, { nonNegative: true });
    return {
      status: 'pass',
      mode,
      coverageSeconds,
      rates: {
        buys: new Decimal(buys).div(coverageSeconds).toString(),
        buyers: new Decimal(buyers).div(coverageSeconds).toString(),
        volumeUsd: volume.div(coverageSeconds).toString(),
      },
    };
  } catch {
    return { status: 'incomplete', mode, reason: 'window:invalid_stats' };
  }
}
