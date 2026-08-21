import { Decimal } from 'decimal.js';
import { dataStates, type DataState } from './types.js';

const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

export type DecimalParseOptions = {
  maxScale?: number;
  min?: string;
  max?: string;
  nonNegative?: boolean;
};

export function parseDecimalString(value: unknown, options: DecimalParseOptions = {}): Decimal {
  if (typeof value !== 'string' || value.length === 0 || !decimalPattern.test(value))
    throw new Error('Invalid decimal string');
  const scale = value.includes('.') ? value.length - value.indexOf('.') - 1 : 0;
  if (options.maxScale !== undefined && scale > options.maxScale)
    throw new Error('Decimal scale exceeds configured precision');
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new Error('Decimal is not finite');
  if (options.nonNegative && parsed.isNegative()) throw new Error('Decimal must be non-negative');
  if (options.min !== undefined && parsed.lessThan(options.min))
    throw new Error('Decimal is below minimum');
  if (options.max !== undefined && parsed.greaterThan(options.max))
    throw new Error('Decimal is above maximum');
  return parsed;
}

export function parseInteger(value: unknown, options: { min?: number; max?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('Invalid safe integer');
  if (options.min !== undefined && value < options.min) throw new Error('Integer is below minimum');
  if (options.max !== undefined && value > options.max) throw new Error('Integer is above maximum');
  return value;
}

export function parseTimestampMs(value: unknown): number {
  return parseInteger(value, { min: 0 });
}

export function parseAddress(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    /\s/u.test(value)
  )
    throw new Error('Invalid address');
  return value;
}

export function classifyWindow(input: {
  present: boolean;
  valid: boolean;
  conflict?: boolean;
  stale?: boolean;
  coverageSeconds?: number;
  requiredSeconds?: number;
  count?: number;
}): DataState {
  if (input.conflict) return 'conflict';
  if (!input.present) return 'missing';
  if (!input.valid) return 'invalid';
  if (input.stale) return 'stale';
  if (
    input.coverageSeconds !== undefined &&
    input.requiredSeconds !== undefined &&
    input.coverageSeconds < input.requiredSeconds
  )
    return 'partial';
  if (input.count === 0) return 'zero';
  return 'complete';
}

export function isDataState(value: unknown): value is DataState {
  return typeof value === 'string' && (dataStates as readonly string[]).includes(value);
}
