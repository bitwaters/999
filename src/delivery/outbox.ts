import type { SqliteDatabase } from '../persistence/db.js';
import { boundedWrite, type WriteBudget } from '../persistence/write-budget.js';
import type { SignalSnapshot } from '../pipeline/ace.js';

export type OutboxDestination = 'admin_private' | 'channel' | 'group';
export type OutboxMessageType = 'ENTRY_SIGNAL' | 'REPORT' | 'SYSTEM_ALERT';
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'expired';

export type OutboxRow = {
  signalId?: number;
  destination: OutboxDestination;
  messageType: OutboxMessageType;
  dedupeKey: string;
  renderedPayload: string;
  status: OutboxStatus;
  attempts: number;
  dueAt: number;
  expiresAt?: number;
  attemptStartedAt?: number;
  sentAt?: number;
  messageId?: string;
  deliveryUncertain: boolean;
  lastError?: string;
};

export type EntryDestinationPolicy = {
  destination: OutboxDestination;
  enabled: boolean;
  anchor: boolean;
  cooldownUntil?: number;
  renderedPayload: string;
};

export function makeDedupeKey(
  input:
    | { messageType: 'ENTRY_SIGNAL'; signalId: number }
    | { messageType: 'REPORT'; reportRequestId: string }
    | { messageType: 'SYSTEM_ALERT'; alertType: string; scope: string; coalescingWindow: string },
): string {
  if (input.messageType === 'ENTRY_SIGNAL') {
    if (!Number.isSafeInteger(input.signalId) || input.signalId <= 0)
      throw new Error('Invalid signal ID');
    return `signal:${input.signalId}`;
  }
  if (input.messageType === 'REPORT') {
    if (!input.reportRequestId) throw new Error('Invalid report request ID');
    return `report:${input.reportRequestId}`;
  }
  if (!input.alertType || !input.scope || !input.coalescingWindow)
    throw new Error('Invalid system alert dedupe identity');
  return `alert:${input.alertType}:${input.scope}:${input.coalescingWindow}`;
}

export function createEntryOutboxRows(input: {
  signalId: number;
  confirmedAt: number;
  entryTtlSeconds: number;
  now: number;
  destinations: readonly EntryDestinationPolicy[];
}): { status: 'ready'; rows: OutboxRow[] } | { status: 'blocked'; reason: string } {
  if (!Number.isSafeInteger(input.signalId) || input.signalId <= 0 || input.entryTtlSeconds <= 0)
    return { status: 'blocked', reason: 'invalid:entry_outbox_timing' };
  const anchor = input.destinations.find((destination) => destination.anchor);
  if (!anchor?.enabled) return { status: 'blocked', reason: 'anchor:not_enabled' };
  if (anchor.cooldownUntil !== undefined && anchor.cooldownUntil > input.now)
    return { status: 'blocked', reason: 'cooldown:anchor' };
  const expiresAt = input.confirmedAt + input.entryTtlSeconds * 1000;
  const dedupeKey = makeDedupeKey({ messageType: 'ENTRY_SIGNAL', signalId: input.signalId });
  const rows = input.destinations
    .filter(
      (destination) =>
        destination.enabled &&
        (destination.anchor ||
          destination.cooldownUntil === undefined ||
          destination.cooldownUntil <= input.now),
    )
    .map((destination) => ({
      signalId: input.signalId,
      destination: destination.destination,
      messageType: 'ENTRY_SIGNAL' as const,
      dedupeKey,
      renderedPayload: destination.renderedPayload,
      status: 'pending' as const,
      attempts: 0,
      dueAt: input.now,
      expiresAt,
      deliveryUncertain: false,
    }));
  return { status: 'ready', rows };
}

export function beginDelivery(row: OutboxRow, now: number): OutboxRow {
  if (row.status === 'sent') throw new Error('Cannot send an already sent outbox row');
  if (row.status === 'expired' || (row.expiresAt !== undefined && now >= row.expiresAt))
    return { ...row, status: 'expired' };
  return {
    ...row,
    status: 'sending',
    attempts: row.attempts + 1,
    attemptStartedAt: now,
  };
}

export function completeDelivery(row: OutboxRow, sentAt: number, messageId: string): OutboxRow {
  if (row.status !== 'sending') throw new Error('Outbox row is not sending');
  if (!messageId) throw new Error('Missing Telegram message ID');
  return withoutAttempt(row, { status: 'sent', sentAt, messageId });
}

export function failDelivery(input: {
  row: OutboxRow;
  now: number;
  error: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}): OutboxRow {
  const { row } = input;
  if (row.status !== 'sending') throw new Error('Outbox row is not sending');
  const expired =
    row.attempts >= input.maxAttempts ||
    (row.expiresAt !== undefined && input.now >= row.expiresAt);
  if (expired) return withoutAttempt(row, { status: 'expired', lastError: input.error });
  const delay = Math.min(input.maxDelayMs, input.baseDelayMs * 2 ** Math.max(0, row.attempts - 1));
  return {
    ...withoutAttempt(row, {}),
    status: 'pending',
    dueAt: input.now + delay,
    lastError: input.error,
  };
}

export function recoverSending(row: OutboxRow, now: number): OutboxRow {
  if (row.status !== 'sending') return row;
  if (row.expiresAt !== undefined && now >= row.expiresAt)
    return withoutAttempt(row, { status: 'expired', deliveryUncertain: true });
  return withoutAttempt(row, { status: 'pending', dueAt: now, deliveryUncertain: true });
}

function withoutAttempt(row: OutboxRow, patch: Partial<OutboxRow>): OutboxRow {
  const rest = { ...row };
  delete rest.attemptStartedAt;
  return { ...rest, ...patch };
}

export type AnchorLifecycle =
  | { status: 'pending' }
  | { status: 'delivered'; anchorDeliveredAt: number }
  | { status: 'uncertain' }
  | { status: 'expired' };

export function anchorLifecycle(
  rows: readonly OutboxRow[],
  anchorDestination: OutboxDestination,
): AnchorLifecycle {
  const anchor = rows.find(
    (row) => row.destination === anchorDestination && row.messageType === 'ENTRY_SIGNAL',
  );
  if (!anchor) return { status: 'pending' };
  if (anchor.deliveryUncertain && anchor.status !== 'expired') return { status: 'uncertain' };
  if (anchor.status === 'sent' && anchor.sentAt !== undefined)
    return { status: 'delivered', anchorDeliveredAt: anchor.sentAt };
  if (anchor.status === 'expired') return { status: 'expired' };
  return { status: 'pending' };
}

export function shouldStartOutcome(lifecycle: AnchorLifecycle): boolean {
  return lifecycle.status === 'delivered';
}

export function shouldKeepG2(lifecycle: AnchorLifecycle): boolean {
  return lifecycle.status !== 'expired';
}

export function insertSignalAndOutbox(
  database: SqliteDatabase,
  input: {
    candidateId: number;
    configVersionId: number;
    confirmedAt: number;
    snapshot: SignalSnapshot;
    rows: readonly OutboxRow[];
  },
  budget: WriteBudget,
): number {
  return boundedWrite(database, budget, (context) => {
    const signalInsert = database
      .prepare(
        `INSERT INTO signals (candidate_id, config_version_id, signal_type, confirmed_at, status, snapshot_json, created_at)
         VALUES (?, ?, 'Emerging Breakout', ?, 'confirmed-pending-anchor', ?, ?)`,
      )
      .run(
        input.candidateId,
        input.configVersionId,
        input.confirmedAt,
        JSON.stringify(input.snapshot),
        input.confirmedAt,
      );
    context.addRows(1);
    const signalId = Number(signalInsert.lastInsertRowid);
    const insertOutbox = database.prepare(
      `INSERT OR IGNORE INTO delivery_outbox
       (signal_id, destination, message_type, dedupe_key, status, rendered_payload, expires_at, attempts, due_at, delivery_uncertain)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of input.rows)
      insertOutbox.run(
        signalId,
        row.destination,
        row.messageType,
        row.dedupeKey,
        row.status,
        row.renderedPayload,
        row.expiresAt ?? null,
        row.attempts,
        row.dueAt,
        row.deliveryUncertain ? 1 : 0,
      );
    context.addRows(input.rows.length);
    return signalId;
  }).value;
}

export function insertSignalAndPolicies(
  database: SqliteDatabase,
  input: {
    candidateId: number;
    configVersionId: number;
    confirmedAt: number;
    snapshot: SignalSnapshot;
    entryTtlSeconds: number;
    now: number;
    destinations: readonly EntryDestinationPolicy[];
  },
  budget: WriteBudget,
): { status: 'ready'; signalId: number } | { status: 'blocked'; reason: string } {
  const preview = createEntryOutboxRows({
    signalId: 1,
    confirmedAt: input.confirmedAt,
    entryTtlSeconds: input.entryTtlSeconds,
    now: input.now,
    destinations: input.destinations,
  });
  if (preview.status === 'blocked') return preview;
  const signalId = boundedWrite(database, budget, (context) => {
    const signalInsert = database
      .prepare(
        `INSERT INTO signals (candidate_id, config_version_id, signal_type, confirmed_at, status, snapshot_json, created_at)
         VALUES (?, ?, 'Emerging Breakout', ?, 'confirmed-pending-anchor', ?, ?)`,
      )
      .run(
        input.candidateId,
        input.configVersionId,
        input.confirmedAt,
        JSON.stringify(input.snapshot),
        input.confirmedAt,
      );
    context.addRows(1);
    const rows = createEntryOutboxRows({
      signalId: Number(signalInsert.lastInsertRowid),
      confirmedAt: input.confirmedAt,
      entryTtlSeconds: input.entryTtlSeconds,
      now: input.now,
      destinations: input.destinations,
    });
    if (rows.status === 'blocked') throw new Error(`Outbox blocked: ${rows.reason}`);
    const insertOutbox = database.prepare(
      `INSERT OR IGNORE INTO delivery_outbox
       (signal_id, destination, message_type, dedupe_key, status, rendered_payload, expires_at, attempts, due_at, delivery_uncertain)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows.rows)
      insertOutbox.run(
        Number(signalInsert.lastInsertRowid),
        row.destination,
        row.messageType,
        row.dedupeKey,
        row.status,
        row.renderedPayload,
        row.expiresAt ?? null,
        row.attempts,
        row.dueAt,
        row.deliveryUncertain ? 1 : 0,
      );
    context.addRows(rows.rows.length);
    const candidateUpdate = database
      .prepare(
        `UPDATE candidates SET status = 'confirmed-pending-anchor', funnel_status = 'confirmed-pending-anchor', updated_at = ?
         WHERE id = ?`,
      )
      .run(input.confirmedAt, input.candidateId);
    context.addRows(candidateUpdate.changes);
    return Number(signalInsert.lastInsertRowid);
  }).value;
  return { status: 'ready', signalId };
}
