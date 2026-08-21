import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { SqliteDatabase } from './db.js';
import { boundedWrite, type WriteBudget } from './write-budget.js';

const allowedRequestMeta = new Set([
  'endpoint_name',
  'method',
  'status',
  'request_id',
  'subscription_id',
  'content_type',
  'response_bytes',
]);
const forbiddenKey = /(authorization|api[-_]?key|token|secret|header|url)/iu;

export type ProviderEventInput = {
  provider: string;
  capability: string;
  chain?: 'sol' | 'bsc';
  tokenAddress?: string;
  poolAddress?: string;
  eventAt?: number;
  observedAt: number;
  schemaVersion: string;
  payload: string | Uint8Array;
  billingBucket?: string;
  creditsEstimate?: string;
  requestMeta?: Record<string, string | number | boolean | null>;
};

function safeRequestMeta(meta: ProviderEventInput['requestMeta']): string | null {
  if (!meta) return null;
  const safe = Object.fromEntries(
    Object.entries(meta).filter(([key]) => allowedRequestMeta.has(key) && !forbiddenKey.test(key)),
  );
  return JSON.stringify(safe);
}

export function encodePayload(payload: string | Uint8Array): {
  hash: string;
  encoding: 'identity' | 'gzip';
  bytes: Buffer;
} {
  const raw = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const compressed = gzipSync(raw);
  if (compressed.length < raw.length)
    return {
      hash: createHash('sha256').update(raw).digest('hex'),
      encoding: 'gzip',
      bytes: compressed,
    };
  return { hash: createHash('sha256').update(raw).digest('hex'), encoding: 'identity', bytes: raw };
}

export function insertProviderEvent(
  database: SqliteDatabase,
  input: ProviderEventInput,
  budget: WriteBudget,
): { id: number; hash: string; timingIncomplete: boolean } {
  const encoded = encodePayload(input.payload);
  const result = boundedWrite(database, budget, (context) => {
    const statement = database.prepare(`INSERT OR IGNORE INTO provider_events
      (provider, capability, chain, token_address, pool_address, event_at, observed_at, schema_version,
       payload_hash, payload_encoding, payload, billing_bucket, credits_estimate, request_meta_json)
      VALUES (@provider, @capability, @chain, @tokenAddress, @poolAddress, @eventAt, @observedAt, @schemaVersion,
       @hash, @encoding, @bytes, @billingBucket, @creditsEstimate, @requestMetaJson)`);
    const info = statement.run({
      provider: input.provider,
      capability: input.capability,
      chain: input.chain ?? null,
      tokenAddress: input.tokenAddress ?? null,
      poolAddress: input.poolAddress ?? null,
      eventAt: input.eventAt ?? null,
      observedAt: input.observedAt,
      schemaVersion: input.schemaVersion,
      hash: encoded.hash,
      encoding: encoded.encoding,
      bytes: encoded.bytes,
      billingBucket: input.billingBucket ?? null,
      creditsEstimate: input.creditsEstimate ?? null,
      requestMetaJson: safeRequestMeta(input.requestMeta),
    });
    context.addRows(info.changes);
    const id =
      info.changes > 0
        ? Number(info.lastInsertRowid)
        : Number(
            database
              .prepare(
                'SELECT id FROM provider_events WHERE provider = ? AND capability = ? AND observed_at = ? AND payload_hash = ?',
              )
              .pluck()
              .get(input.provider, input.capability, input.observedAt, encoded.hash),
          );
    return id;
  });
  return { id: result.value, hash: encoded.hash, timingIncomplete: result.timingIncomplete };
}
