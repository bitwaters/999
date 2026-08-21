import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { ProviderResponseTooLargeError, requestJson } from './http.js';

const options = {
  provider: 'test',
  capability: 'fixture',
  timeoutMs: 100,
  maxResponseBytes: 1024,
  maxDecompressedBytes: 2048,
  maxAttempts: 3,
  baseDelayMs: 0,
  maxDelayMs: 10,
};

test('retries 429 using the provider reset hint and returns diagnostics', async () => {
  let calls = 0;
  const result = await requestJson<{ ok: boolean }>(
    'https://example.test',
    {},
    {
      ...options,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1)
          return new Response('busy', { status: 429, headers: { 'retry-after': '0' } });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  );
  assert.equal(result.data.ok, true);
  assert.equal(result.diagnostic.attempts, 2);
  assert.equal(calls, 2);
});

test('rejects oversized responses before JSON parsing', async () => {
  await assert.rejects(
    () =>
      requestJson(
        'https://example.test',
        {},
        { ...options, maxResponseBytes: 3, fetchImpl: async () => new Response('1234') },
      ),
    (error: unknown) =>
      error instanceof ProviderResponseTooLargeError &&
      error.code === 'PROVIDER_RESPONSE_TOO_LARGE',
  );
});

test('does not retry a caller cancellation', async () => {
  const controller = new AbortController();
  let calls = 0;
  const promise = requestJson(
    'https://example.test',
    { signal: controller.signal },
    {
      ...options,
      fetchImpl: async (_url, init) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return new Response('{}');
      },
    },
  );
  controller.abort();
  await assert.rejects(promise, /Abort/u);
  assert.equal(calls, 1);
});

test('does not double-decompress a fetch body already decoded by undici', async () => {
  const result = await requestJson<{ ok: boolean }>(
    'https://example.test',
    {},
    {
      ...options,
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-encoding': 'gzip' },
        }),
    },
  );
  assert.equal(result.data.ok, true);
});

test('decompresses a genuine gzip body marked by the provider', async () => {
  const result = await requestJson<{ ok: boolean }>(
    'https://example.test',
    {},
    {
      ...options,
      fetchImpl: async () =>
        new Response(gzipSync(JSON.stringify({ ok: true })), {
          status: 200,
          headers: { 'content-encoding': 'gzip' },
        }),
    },
  );
  assert.equal(result.data.ok, true);
});
