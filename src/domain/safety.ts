import { parseDecimalString } from '../providers/parsing.js';
import type { BotConfig } from '../config/schema.js';

export type SafetyStatus = 'pass' | 'fatal' | 'policy_reject' | 'incomplete';

export type SafetyResult = {
  status: SafetyStatus;
  reasons: string[];
  checkedAt: number;
  expiresAt: number;
  providerEventId: string;
  configVersionId: string;
  canonical: Record<string, boolean | string>;
};

type SafetyContext = {
  checkedAt: number;
  providerEventId: string;
  configVersionId: string;
};

type RawSafety = Record<string, unknown>;
type Threshold = { enabled: boolean; verified: boolean; max: number };

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true' || value === 'yes') return true;
  if (value === 0 || value === '0' || value === 'false' || value === 'no') return false;
  return undefined;
}

function has(raw: RawSafety, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

function requiredBoolean(
  raw: RawSafety,
  key: string,
  incompleteReasons: string[],
  canonical: Record<string, boolean | string>,
): boolean | undefined {
  if (!has(raw, key)) {
    incompleteReasons.push(`missing:${key}`);
    return undefined;
  }
  const parsed = parseBoolean(raw[key]);
  if (parsed === undefined) {
    incompleteReasons.push(`invalid:${key}`);
    return undefined;
  }
  canonical[key] = parsed;
  return parsed;
}

function readThreshold(
  raw: RawSafety,
  field: string,
  threshold: Threshold,
  incompleteReasons: string[],
  policyReasons: string[],
  canonical: Record<string, boolean | string>,
): void {
  if (!threshold.enabled) return;
  if (!threshold.verified) {
    incompleteReasons.push(`unverified:${field}`);
    return;
  }
  if (!has(raw, field)) {
    incompleteReasons.push(`missing:${field}`);
    return;
  }
  try {
    const value = parseDecimalString(raw[field], { nonNegative: true });
    canonical[field] = value.toString();
    if (value.greaterThan(String(threshold.max))) policyReasons.push(`threshold:${field}`);
  } catch {
    incompleteReasons.push(`invalid:${field}`);
  }
}

function finish(
  fatalReasons: string[],
  policyReasons: string[],
  incompleteReasons: string[],
  config: { freshness_seconds: number },
  context: SafetyContext,
  canonical: Record<string, boolean | string>,
): SafetyResult {
  const status: SafetyStatus =
    fatalReasons.length > 0
      ? 'fatal'
      : incompleteReasons.length > 0
        ? 'incomplete'
        : policyReasons.length > 0
          ? 'policy_reject'
          : 'pass';
  return {
    status,
    reasons: [...fatalReasons, ...policyReasons, ...incompleteReasons],
    checkedAt: context.checkedAt,
    expiresAt: context.checkedAt + config.freshness_seconds * 1000,
    providerEventId: context.providerEventId,
    configVersionId: context.configVersionId,
    canonical,
  };
}

export function evaluateSolSafety(
  raw: RawSafety,
  config: BotConfig['chains']['sol']['safety'],
  context: SafetyContext,
): SafetyResult {
  const fatalReasons: string[] = [];
  const policyReasons: string[] = [];
  const incompleteReasons: string[] = [];
  const canonical: Record<string, boolean | string> = {};
  const mint = requiredBoolean(raw, 'renounced_mint', incompleteReasons, canonical);
  const freeze = requiredBoolean(raw, 'renounced_freeze_account', incompleteReasons, canonical);
  if (mint === false) fatalReasons.push('fatal:renounced_mint');
  if (freeze === false) fatalReasons.push('fatal:renounced_freeze_account');

  for (const [field, threshold] of Object.entries(config.s1))
    readThreshold(raw, field, threshold, incompleteReasons, policyReasons, canonical);

  return finish(fatalReasons, policyReasons, incompleteReasons, config, context, canonical);
}

export function evaluateBscSafety(
  raw: RawSafety,
  config: BotConfig['chains']['bsc']['safety'],
  context: SafetyContext,
): SafetyResult {
  const fatalReasons: string[] = [];
  const policyReasons: string[] = [];
  const incompleteReasons: string[] = [];
  const canonical: Record<string, boolean | string> = {};
  const honeypot = requiredBoolean(raw, 'is_honeypot', incompleteReasons, canonical);
  const openSource = requiredBoolean(raw, 'is_open_source', incompleteReasons, canonical);

  let ownership: boolean | undefined;
  if (has(raw, 'is_renounced')) {
    ownership = parseBoolean(raw.is_renounced);
    if (ownership === undefined) incompleteReasons.push('invalid:is_renounced');
  } else if (has(raw, 'owner_renounced')) {
    ownership = parseBoolean(raw.owner_renounced);
    if (ownership === undefined) incompleteReasons.push('invalid:owner_renounced');
  } else {
    incompleteReasons.push('missing:ownership_renounced');
  }
  if (has(raw, 'is_renounced') && has(raw, 'owner_renounced')) {
    const primary = parseBoolean(raw.is_renounced);
    const fallback = parseBoolean(raw.owner_renounced);
    if (primary === undefined || fallback === undefined) {
      incompleteReasons.push('invalid:ownership_source');
    } else if (primary !== fallback) {
      incompleteReasons.push('conflict:ownership_source');
      ownership = undefined;
    } else {
      ownership = primary;
    }
  }
  if (ownership !== undefined) canonical.ownership_renounced = ownership;

  const buyTax = readBscTax(raw, 'buy_tax', incompleteReasons, canonical);
  const sellTax = readBscTax(raw, 'sell_tax', incompleteReasons, canonical);
  if (honeypot === true) fatalReasons.push('fatal:is_honeypot');
  if (ownership === false) fatalReasons.push('fatal:ownership_renounced');
  if (openSource === false) fatalReasons.push('fatal:is_open_source');
  if (buyTax?.greaterThan(String(config.s0.max_buy_tax))) fatalReasons.push('fatal:buy_tax');
  if (sellTax?.greaterThan(String(config.s0.max_sell_tax))) fatalReasons.push('fatal:sell_tax');

  for (const [field, threshold] of Object.entries(config.s1))
    readThreshold(raw, field, threshold, incompleteReasons, policyReasons, canonical);

  return finish(fatalReasons, policyReasons, incompleteReasons, config, context, canonical);
}

function readBscTax(
  raw: RawSafety,
  field: string,
  incompleteReasons: string[],
  canonical: Record<string, boolean | string>,
) {
  if (!has(raw, field)) {
    incompleteReasons.push(`missing:${field}`);
    return undefined;
  }
  try {
    const value = parseDecimalString(raw[field], { nonNegative: true });
    canonical[field] = value.toString();
    return value;
  } catch {
    incompleteReasons.push(`invalid:${field}`);
    return undefined;
  }
}

export function canReuseSafetyPass(
  result: SafetyResult,
  now: number,
  configVersionId: string,
): boolean {
  return (
    result.status === 'pass' && result.expiresAt > now && result.configVersionId === configVersionId
  );
}
