import type { BotConfig } from '../config/schema.js';
import { boundedWrite, type WriteBudget } from '../persistence/write-budget.js';
import type { SqliteDatabase } from '../persistence/db.js';
import {
  beginDelivery,
  completeDelivery,
  failDelivery,
  recoverSending,
  type OutboxRow,
  type OutboxMessageType,
} from './outbox.js';
import { requestJson, type HttpClientOptions } from '../providers/http.js';

type DeliveryLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

type TelegramResponse = {
  ok: boolean;
  result?: { message_id?: number };
  description?: string;
};

export type DeliveryWorkerOptions = {
  config: BotConfig;
  botToken: string;
  database: SqliteDatabase;
  writeBudget: WriteBudget;
  logger: DeliveryLogger;
  pollIntervalMs?: number;
  beforeSend?: (
    row: OutboxRow,
    now: number,
  ) =>
    | { status: 'send'; preSendDrift?: string }
    | { status: 'defer'; reason: string; dueAt?: number }
    | { status: 'cancel'; reason: string };
};

export class TelegramDeliveryWorker {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopping = false;

  public constructor(private readonly options: DeliveryWorkerOptions) {}

  public start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.runOnce(), this.options.pollIntervalMs ?? 1_000);
    void this.runOnce();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private async runOnce(): Promise<void> {
    if (this.stopping || this.inFlight) return;
    this.inFlight = Promise.resolve()
      .then(() => this.recoverStaleSending())
      .then(() => this.drainPending())
      .finally(() => {
        this.inFlight = undefined;
      });
    await this.inFlight;
  }

  private async recoverStaleSending(): Promise<void> {
    const rows = this.options.database
      .prepare(
        `SELECT * FROM delivery_outbox
         WHERE status = 'sending'
         ORDER BY attempt_started_at ASC LIMIT 50`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const raw of rows) {
      const row = readOutboxRow(raw);
      const recovered = recoverSending(row, Date.now());
      if (recovered === row) continue;
      this.updateRow(recovered, Number(raw.id));
      this.options.logger('warn', 'delivery_recovered_uncertain', {
        outbox_id: raw.id,
        destination: row.destination,
      });
    }
  }

  private async drainPending(): Promise<void> {
    const rows = this.options.database
      .prepare(
        `SELECT * FROM delivery_outbox
         WHERE status = 'pending' AND due_at <= ?
         ORDER BY due_at ASC, id ASC LIMIT 20`,
      )
      .all(Date.now()) as Array<Record<string, unknown>>;
    for (const raw of rows) {
      if (this.stopping) return;
      await this.sendOne(Number(raw.id), readOutboxRow(raw));
    }
  }

  private async sendOne(id: number, row: OutboxRow): Promise<void> {
    const now = Date.now();
    let dispatchDecision:
      | { status: 'send'; preSendDrift?: string }
      | { status: 'defer'; reason: string; dueAt?: number }
      | { status: 'cancel'; reason: string }
      | undefined;
    if (row.messageType === 'ENTRY_SIGNAL' && this.options.beforeSend) {
      try {
        dispatchDecision = this.options.beforeSend(row, now);
      } catch (error) {
        dispatchDecision = {
          status: 'defer',
          reason: `dispatch:guard_error:${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (dispatchDecision.status !== 'send') {
        const expired =
          row.expiresAt !== undefined && now >= row.expiresAt
            ? true
            : dispatchDecision.status === 'cancel';
        const next: OutboxRow = expired
          ? { ...row, status: 'expired', lastError: `dispatch:${dispatchDecision.reason}` }
          : {
              ...row,
              status: 'pending',
              dueAt:
                dispatchDecision.status === 'defer' && dispatchDecision.dueAt !== undefined
                  ? dispatchDecision.dueAt
                  : now + (this.options.pollIntervalMs ?? 1_000),
              lastError: `dispatch:${dispatchDecision.reason}`,
            };
        this.updateRow(next, id);
        this.options.logger('warn', 'delivery_dispatch_guard', {
          outbox_id: id,
          status: next.status,
          reason: dispatchDecision.reason,
        });
        return;
      }
    }
    if (
      row.messageType === 'ENTRY_SIGNAL' &&
      row.signalId !== undefined &&
      row.destination === this.options.config.delivery.outcome_anchor_destination &&
      dispatchDecision?.status === 'send' &&
      dispatchDecision.preSendDrift !== undefined
    ) {
      boundedWrite(this.options.database, this.options.writeBudget, (context) => {
        const info = this.options.database
          .prepare('UPDATE signals SET pre_send_drift = ? WHERE id = ?')
          .run(dispatchDecision.preSendDrift, row.signalId);
        context.addRows(info.changes);
      });
    }
    const sending = beginDelivery(row, now);
    this.updateRow(sending, id);
    if (sending.status === 'expired') return;
    try {
      const destination = this.options.config.delivery[sending.destination];
      if (!destination.enabled) throw new Error(`Destination disabled: ${sending.destination}`);
      const result = await requestJson<TelegramResponse>(
        `https://api.telegram.org/bot${this.options.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: destination.chat_id,
            text: sending.renderedPayload,
            disable_web_page_preview: true,
          }),
        },
        telegramHttpOptions(this.options.config),
      );
      if (!result.data.ok || result.data.result?.message_id === undefined)
        throw new Error(result.data.description || 'Telegram sendMessage returned no message ID');
      const completed = completeDelivery(
        sending,
        Date.now(),
        String(result.data.result.message_id),
      );
      this.updateRow(completed, id);
      this.options.logger('info', 'delivery_sent', { outbox_id: id, destination: row.destination });
    } catch (error) {
      const failed = failDelivery({
        row: sending,
        now: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        maxAttempts: this.options.config.delivery.retry.max_attempts,
        baseDelayMs: this.options.config.delivery.retry.base_delay_ms,
        maxDelayMs: this.options.config.delivery.retry.max_delay_ms,
      });
      this.updateRow(failed, id);
      this.options.logger('warn', 'delivery_failed', {
        outbox_id: id,
        destination: row.destination,
        status: failed.status,
      });
    }
  }

  private updateRow(row: OutboxRow, id: number): void {
    boundedWrite(this.options.database, this.options.writeBudget, (context) => {
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Delivery row ID is required');
      const info = this.options.database
        .prepare(
          `UPDATE delivery_outbox SET status = ?, attempts = ?, due_at = ?, expires_at = ?,
           attempt_started_at = ?, sent_at = ?, message_id = ?, delivery_uncertain = ?, last_error = ?
           WHERE id = ?`,
        )
        .run(
          row.status,
          row.attempts,
          row.dueAt,
          row.expiresAt ?? null,
          row.attemptStartedAt ?? null,
          row.sentAt ?? null,
          row.messageId ?? null,
          row.deliveryUncertain ? 1 : 0,
          row.lastError ?? null,
          id,
        );
      context.addRows(info.changes);
    });
  }
}

function telegramHttpOptions(config: BotConfig): HttpClientOptions {
  return {
    provider: 'telegram',
    capability: 'sendMessage',
    timeoutMs: config.providers.telegram.request_timeout_ms,
    maxResponseBytes: config.providers.telegram.max_response_bytes,
    maxDecompressedBytes: config.providers.telegram.max_decompressed_bytes,
    maxAttempts: 1,
    baseDelayMs: 1,
    maxDelayMs: 1,
  };
}

function readOutboxRow(raw: Record<string, unknown>): OutboxRow {
  const destination = raw.destination;
  if (destination !== 'admin_private' && destination !== 'channel' && destination !== 'group')
    throw new Error('Invalid delivery destination');
  const status = raw.status;
  if (status !== 'pending' && status !== 'sending' && status !== 'sent' && status !== 'expired')
    throw new Error('Invalid delivery status');
  const messageType = raw.message_type;
  if (messageType !== 'ENTRY_SIGNAL' && messageType !== 'REPORT' && messageType !== 'SYSTEM_ALERT')
    throw new Error('Invalid delivery message type');
  return {
    ...(raw.signal_id === null || raw.signal_id === undefined
      ? {}
      : { signalId: Number(raw.signal_id) }),
    destination,
    messageType: messageType as OutboxMessageType,
    dedupeKey: String(raw.dedupe_key),
    renderedPayload: String(raw.rendered_payload),
    status,
    attempts: Number(raw.attempts),
    dueAt: Number(raw.due_at),
    ...(raw.expires_at === null || raw.expires_at === undefined
      ? {}
      : { expiresAt: Number(raw.expires_at) }),
    ...(raw.attempt_started_at === null || raw.attempt_started_at === undefined
      ? {}
      : { attemptStartedAt: Number(raw.attempt_started_at) }),
    ...(raw.sent_at === null || raw.sent_at === undefined ? {} : { sentAt: Number(raw.sent_at) }),
    ...(raw.message_id === null || raw.message_id === undefined
      ? {}
      : { messageId: String(raw.message_id) }),
    deliveryUncertain: raw.delivery_uncertain === 1,
    ...(raw.last_error === null || raw.last_error === undefined
      ? {}
      : { lastError: String(raw.last_error) }),
  } satisfies OutboxRow;
}
