import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigText } from '../config/load.js';
import { openDatabase } from '../persistence/db.js';
import { TelegramDeliveryWorker } from './worker.js';

const config = parseConfigText(
  readFileSync(new URL('../../config/bot.yaml', import.meta.url), 'utf8'),
).config;

test('delivery worker applies ENTRY dispatch cancellation before Telegram request', async () => {
  const database = openDatabase(':memory:');
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO delivery_outbox
       (signal_id, destination, message_type, dedupe_key, status, rendered_payload, expires_at, attempts, due_at, delivery_uncertain)
       VALUES (NULL, 'admin_private', 'ENTRY_SIGNAL', 'signal:test', 'pending', 'entry', ?, 0, ?, 0)`,
    )
    .run(now + 30_000, now);
  let requests = 0;
  const worker = new TelegramDeliveryWorker({
    config,
    botToken: 'test-token',
    database,
    writeBudget: { maxRows: 20, maxMs: 100 },
    pollIntervalMs: 10_000,
    logger: () => undefined,
    beforeSend: () => ({ status: 'cancel', reason: 'pre_send_drift:overextended' }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error('fetch should not be called');
  }) as typeof fetch;
  let status: string | undefined;
  try {
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await worker.stop();
    status = (
      database.prepare('SELECT status FROM delivery_outbox WHERE id = 1').get() as {
        status: string;
      }
    ).status;
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
  assert.equal(requests, 0);
  assert.equal(status, 'expired');
});
