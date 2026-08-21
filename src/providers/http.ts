import { gunzipSync } from 'node:zlib';
import type { ProviderDiagnostic } from './types.js';

export type HttpClientOptions = {
  provider: string;
  capability: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxDecompressedBytes: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  fetchImpl?: typeof fetch;
};

export type HttpResult<T> = { data: T; diagnostic: ProviderDiagnostic; headers: Headers };

export class ProviderResponseTooLargeError extends Error {
  public readonly code = 'PROVIDER_RESPONSE_TOO_LARGE';
}

export class ProviderRequestError extends Error {
  public readonly code = 'PROVIDER_REQUEST_FAILED';
  public constructor(
    message: string,
    public readonly diagnostic: ProviderDiagnostic,
  ) {
    super(message);
  }
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after') ?? headers.get('x-ratelimit-reset');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function readBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ProviderResponseTooLargeError(`Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodeBody(body: Uint8Array, response: Response, maxBytes: number): string {
  const encoded = response.headers.get('content-encoding');
  const decoded = encoded?.includes('gzip') ? gunzipSync(body) : body;
  if (decoded.byteLength > maxBytes)
    throw new ProviderResponseTooLargeError(`Decoded response exceeded ${maxBytes} bytes`);
  return Buffer.from(decoded).toString('utf8');
}

function shouldRetry(status: number | null): boolean {
  return (
    status === null ||
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export async function requestJson<T>(
  url: string,
  init: RequestInit,
  options: HttpClientOptions,
): Promise<HttpResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const abortFromCaller = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) abortFromCaller();
    else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      const raw = await readBody(response, options.maxResponseBytes);
      const text = decodeBody(raw, response, options.maxDecompressedBytes);
      const retryAfter = retryAfterMs(response.headers);
      const diagnostic: ProviderDiagnostic = {
        provider: options.provider,
        capability: options.capability,
        status: response.status,
        latencyMs: Math.round(performance.now() - startedAt),
        attempts: attempt,
        ...(response.status === 429 && retryAfter !== undefined
          ? { retryAfterMs: retryAfter }
          : {}),
      };
      if (!response.ok) {
        lastError = new ProviderRequestError(`HTTP ${response.status}`, diagnostic);
        if (!shouldRetry(response.status) || attempt === options.maxAttempts) throw lastError;
        const waitMs =
          diagnostic.retryAfterMs ??
          Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      return { data: JSON.parse(text) as T, diagnostic, headers: response.headers };
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderResponseTooLargeError) throw error;
      if (init.signal?.aborted) throw error;
      if (error instanceof ProviderRequestError && !shouldRetry(error.diagnostic.status))
        throw error;
      if (attempt === options.maxAttempts) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1))),
      );
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
  const diagnostic: ProviderDiagnostic = {
    provider: options.provider,
    capability: options.capability,
    status: null,
    latencyMs: 0,
    attempts: options.maxAttempts,
    errorCode: lastError instanceof Error ? lastError.name : 'unknown',
  };
  throw new ProviderRequestError('Provider request failed after retries', diagnostic);
}

export function assertAnalystEndpoint(url: string, configuredBaseUrl: string): void {
  const target = new URL(url);
  const base = new URL(configuredBaseUrl);
  if (
    target.origin !== base.origin ||
    !target.pathname.startsWith(base.pathname.replace(/\/$/u, '') + '/')
  )
    throw new Error('CoinGecko requests must use the configured Analyst endpoint');
}
