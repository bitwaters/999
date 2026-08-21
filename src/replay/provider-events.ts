import type { DiscoveryObservation } from '../pipeline/candidate.js';
import type { ReplayEvidence } from './timeline.js';

export type ReplayProviderEventRow = {
  provider: string;
  capability: string;
  chain?: 'sol' | 'bsc' | null;
  token_address?: string | null;
  pool_address?: string | null;
  observed_at: number;
};

export function extractReplayProviderEvent(
  row: ReplayProviderEventRow,
  payload: unknown,
): { discovery: DiscoveryObservation[]; evidence: ReplayEvidence[] } {
  const chain = row.chain;
  if (!chain) return { discovery: [], evidence: [] };
  if (row.provider === 'gmgn' && row.capability.startsWith('market.'))
    return extractGmgn({ ...row, chain }, payload);
  if (row.provider === 'gmgn' && row.capability === 'token.security') {
    const tokenAddress = row.token_address
      ? normalizeToken(chain, row.token_address)
      : normalizeToken(chain, asRecord(payload).address);
    return tokenAddress
      ? {
          discovery: [],
          evidence: [
            {
              kind: 'safety',
              chain,
              tokenAddress,
              observedAt: row.observed_at,
              payload,
            },
          ],
        }
      : { discovery: [], evidence: [] };
  }
  if (row.provider !== 'coingecko') return { discovery: [], evidence: [] };
  const base = { chain, observedAt: row.observed_at, payload };
  if (row.capability === 'tokens.multi')
    return { discovery: [], evidence: [{ kind: 'pool', ...base }] };
  if (row.capability === 'pools.multi.level1')
    return { discovery: [], evidence: [{ kind: 'level1', ...base }] };
  if (row.capability === 'G2' && row.pool_address)
    return {
      discovery: [],
      evidence: [{ kind: 'g2', ...base, poolAddress: row.pool_address }],
    };
  const tokenAddress = row.token_address ? normalizeToken(chain, row.token_address) : undefined;
  if (row.capability === 'trades.level1' && row.pool_address && tokenAddress)
    return {
      discovery: [],
      evidence: [
        {
          kind: 'trades',
          ...base,
          poolAddress: row.pool_address,
          tokenAddress,
        },
      ],
    };
  if (row.capability === 'ohlcv.30s' && row.pool_address && tokenAddress)
    return {
      discovery: [],
      evidence: [
        {
          kind: 'ohlcv',
          ...base,
          poolAddress: row.pool_address,
          tokenAddress,
        },
      ],
    };
  return { discovery: [], evidence: [] };
}

function extractGmgn(
  row: ReplayProviderEventRow & { chain: 'sol' | 'bsc' },
  payload: unknown,
): { discovery: DiscoveryObservation[]; evidence: ReplayEvidence[] } {
  const source = row.capability.endsWith('trending.1m')
    ? 'trending_1m'
    : row.capability.endsWith('trending.5m')
      ? 'trending_5m'
      : row.capability.endsWith('hot-searches.1m')
        ? 'hot_searches'
        : undefined;
  if (!source) return { discovery: [], evidence: [] };
  const record = asRecord(payload);
  const tokens =
    source === 'hot_searches'
      ? Array.isArray(payload)
        ? asRecord(payload.find((item) => asRecord(item).chain === row.chain)).tokens
        : []
      : asRecord(record.data).rank;
  if (!Array.isArray(tokens)) return { discovery: [], evidence: [] };
  const discovery: DiscoveryObservation[] = [];
  const evidence: ReplayEvidence[] = [];
  tokens.forEach((value, index) => {
    const token = asRecord(value);
    const tokenAddress = normalizeToken(row.chain, token.address ?? token.token_address);
    if (!tokenAddress) return;
    const visitingCount = readInteger(token.visiting_count);
    discovery.push({
      chain: row.chain,
      tokenAddress,
      source,
      observedAt: row.observed_at,
      ...(source === 'hot_searches' && visitingCount !== undefined ? { visitingCount } : {}),
      ...(source !== 'hot_searches' ? { rank: index + 1 } : {}),
    });
    evidence.push({
      kind: 'safety',
      chain: row.chain,
      tokenAddress,
      observedAt: row.observed_at,
      payload: token,
    });
  });
  return { discovery, evidence };
}

function normalizeToken(chain: 'sol' | 'bsc', value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    /\s/u.test(value)
  )
    return undefined;
  return chain === 'bsc' ? value.toLowerCase() : value;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
