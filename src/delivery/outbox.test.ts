import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigText } from '../config/load.js';
import { openDatabase } from '../persistence/db.js';
import type { SignalSnapshot } from '../pipeline/ace.js';
import {
  anchorLifecycle,
  beginDelivery,
  completeDelivery,
  createEntryOutboxRows,
  failDelivery,
  insertSignalAndOutbox,
  makeDedupeKey,
  recoverSending,
  shouldKeepG2,
  shouldStartOutcome,
} from './outbox.js';

const configTemplate = await readFile(new URL('../../config/bot.yaml', import.meta.url), 'utf8');
parseConfigText(configTemplate);
const snapshot: SignalSnapshot = {
  signalType: 'Emerging Breakout',
  candidateKey: 'sol:token:1',
  chain: 'sol',
  tokenAddress: 'token',
  poolAddress: 'pool',
  cycleStartedAt: 1,
  confirmedAt: 2_000,
  expiresAt: 62_000,
  configVersionId: 'config',
  confirmationPriceUsd: '1',
  attention: { status: 'pass', reasons: [] },
  conviction: { status: 'pass', reasons: [] },
  organic: { status: 'pass', reasons: [] },
  entryQuality: { status: 'pass', reasons: [] },
};

test('entry outbox rows use one fixed TTL and suppress only cooled non-anchors', () => {
  const created = createEntryOutboxRows({
    signalId: 5,
    confirmedAt: 2_000,
    entryTtlSeconds: 60,
    now: 2_001,
    destinations: [
      { destination: 'admin_private', enabled: true, anchor: true, renderedPayload: 'admin' },
      {
        destination: 'channel',
        enabled: true,
        anchor: false,
        cooldownUntil: 3_000,
        renderedPayload: 'channel',
      },
      { destination: 'group', enabled: true, anchor: false, renderedPayload: 'group' },
    ],
  });
  assert.equal(created.status, 'ready');
  if (created.status !== 'ready') return;
  assert.deepEqual(
    created.rows.map((row) => row.destination),
    ['admin_private', 'group'],
  );
  assert.equal(created.rows[0]?.expiresAt, 62_000);
  assert.equal(makeDedupeKey({ messageType: 'REPORT', reportRequestId: 'r1' }), 'report:r1');
  assert.equal(
    makeDedupeKey({
      messageType: 'SYSTEM_ALERT',
      alertType: '429',
      scope: 'gmgn/sol',
      coalescingWindow: '1m',
    }),
    'alert:429:gmgn/sol:1m',
  );
});

test('outbox state machine retries, fixes TTL, and marks crash recovery uncertain', () => {
  const base = createEntryOutboxRows({
    signalId: 5,
    confirmedAt: 2_000,
    entryTtlSeconds: 60,
    now: 2_001,
    destinations: [
      { destination: 'admin_private', enabled: true, anchor: true, renderedPayload: 'admin' },
    ],
  });
  assert.equal(base.status, 'ready');
  if (base.status !== 'ready') return;
  const sending = beginDelivery(base.rows[0]!, 2_001);
  const failed = failDelivery({
    row: sending,
    now: 2_002,
    error: '429',
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 500,
  });
  assert.equal(failed.status, 'pending');
  assert.equal(failed.dueAt, 2_102);
  const second = beginDelivery(failed, 2_102);
  const uncertain = recoverSending(second, 2_103);
  assert.equal(uncertain.deliveryUncertain, true);
  assert.equal(anchorLifecycle([uncertain], 'admin_private').status, 'uncertain');
  const retriedSent = completeDelivery(beginDelivery(uncertain, 2_104), 2_105, 'tg-1');
  assert.equal(anchorLifecycle([retriedSent], 'admin_private').status, 'uncertain');
  const sent = completeDelivery(beginDelivery(base.rows[0]!, 2_104), 2_105, 'tg-2');
  assert.equal(anchorLifecycle([sent], 'admin_private').status, 'delivered');
  assert.equal(shouldStartOutcome(anchorLifecycle([sent], 'admin_private')), true);
  assert.equal(shouldKeepG2(anchorLifecycle([sent], 'admin_private')), true);
  const expired = beginDelivery(base.rows[0]!, 62_000);
  assert.equal(expired.status, 'expired');
});

test('non-anchor delivery never starts the anchor Outcome lifecycle', () => {
  const created = createEntryOutboxRows({
    signalId: 9,
    confirmedAt: 2_000,
    entryTtlSeconds: 60,
    now: 2_001,
    destinations: [
      { destination: 'admin_private', enabled: true, anchor: true, renderedPayload: 'admin' },
      { destination: 'channel', enabled: true, anchor: false, renderedPayload: 'channel' },
    ],
  });
  assert.equal(created.status, 'ready');
  if (created.status !== 'ready') return;
  const channel = created.rows.find((row) => row.destination === 'channel')!;
  const sentChannel = completeDelivery(beginDelivery(channel, 2_001), 2_002, 'tg-channel');
  const anchor = created.rows.find((row) => row.destination === 'admin_private')!;
  const lifecycle = anchorLifecycle([sentChannel, anchor], 'admin_private');
  assert.equal(lifecycle.status, 'pending');
  assert.equal(shouldStartOutcome(lifecycle), false);
});

test('signal and outbox rows commit atomically and preserve one row per destination', () => {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO rule_config_versions (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
     VALUES ('hash', 'commit', 'shadow', 'yaml', 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO candidates
     (chain, token_address, cycle_started_at, first_seen_at, last_seen_at, status, funnel_status, config_version_id, updated_at)
     VALUES ('sol', 'token', 1, 1, 2, 'active', 'confirmed-pending-anchor', 1, 2)`,
    )
    .run();
  const rows = createEntryOutboxRows({
    signalId: 5,
    confirmedAt: 2_000,
    entryTtlSeconds: 60,
    now: 2_001,
    destinations: [
      { destination: 'admin_private', enabled: true, anchor: true, renderedPayload: 'admin' },
      { destination: 'channel', enabled: true, anchor: false, renderedPayload: 'channel' },
    ],
  });
  assert.equal(rows.status, 'ready');
  if (rows.status !== 'ready') return;
  const signalId = insertSignalAndOutbox(
    database,
    {
      candidateId: 1,
      configVersionId: 1,
      confirmedAt: 2_000,
      snapshot,
      rows: rows.rows,
    },
    { maxRows: 10, maxMs: 100 },
  );
  assert.equal(
    (database.prepare('SELECT COUNT(*) AS count FROM signals').get() as { count: number }).count,
    1,
  );
  assert.equal(
    (
      database
        .prepare('SELECT COUNT(*) AS count FROM delivery_outbox WHERE signal_id = ?')
        .get(signalId) as { count: number }
    ).count,
    2,
  );
  database.close();
});
