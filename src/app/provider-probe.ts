import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotConfig } from '../config/schema.js';
import { insertProviderEvent } from '../persistence/provider-events.js';
import type { SqliteDatabase } from '../persistence/db.js';
import type { WriteBudget } from '../persistence/write-budget.js';
import { requestJson, type HttpClientOptions } from '../providers/http.js';
import { gmgnTrendingRawSchema } from '../providers/raw-schemas.js';

type ProbeState = 'ok' | 'failed' | 'unknown';
type ProbeLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

export type ProviderProbeStatus = {
  provider: ProbeState;
  telegram: ProbeState;
  lastProbeAt?: number;
  lastError?: string;
};

export type ProviderProbeOptions = {
  config: BotConfig;
  secrets: Record<string, string>;
  database: SqliteDatabase;
  writeBudget: WriteBudget;
  logger: ProbeLogger;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gmgnCli = path.join(root, 'node_modules', 'gmgn-cli', 'dist', 'index.js');

export class ProviderProbe {
  private gmgn: ProbeState = 'unknown';
  private coingecko: ProbeState = 'unknown';
  private telegram: ProbeState = 'unknown';
  private lastProbeAt: number | undefined;
  private lastError: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopping = false;
  private statusChangeListener: (() => void) | undefined;

  public constructor(private readonly options: ProviderProbeOptions) {}

  public start(): void {
    if (this.timer) return;
    const intervalMs =
      Math.min(
        this.options.config.chains.sol.discovery.poll_interval_seconds,
        this.options.config.chains.bsc.discovery.poll_interval_seconds,
      ) * 1000;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    void this.runOnce();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  public status(): ProviderProbeStatus {
    const providerStates = [this.gmgn, this.coingecko];
    return {
      provider: providerStates.every((state) => state === 'ok')
        ? 'ok'
        : providerStates.includes('failed')
          ? 'failed'
          : 'unknown',
      telegram: this.telegram,
      ...(this.lastProbeAt === undefined ? {} : { lastProbeAt: this.lastProbeAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  public onStatusChange(listener: () => void): void {
    this.statusChangeListener = listener;
  }

  private async runOnce(): Promise<void> {
    if (this.stopping || this.inFlight) return;
    this.inFlight = Promise.allSettled([
      this.probeGmgn(),
      this.probeCoinGecko(),
      this.probeTelegram(),
    ])
      .then((results) => {
        this.lastProbeAt = Date.now();
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => this.safeError(result.reason));
        this.lastError = failures[0];
        this.statusChangeListener?.();
        this.options.logger('info', 'provider_probe_status', {
          status: this.status(),
          failure_count: failures.length,
        });
        if (failures.length > 0)
          this.options.logger('warn', 'provider_probe_failed', { errors: failures });
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    await this.inFlight;
  }

  private async probeGmgn(): Promise<void> {
    const key = this.options.secrets[this.options.config.providers.gmgn.api_key_env];
    if (!key) throw new Error('GMGN secret is not configured');
    try {
      for (const chain of ['sol', 'bsc'] as const) {
        const observedAt = Date.now();
        const raw = await runGmgn(
          ['market', 'trending', '--chain', chain, '--interval', '1m', '--limit', '1'],
          key,
          this.options.config.providers.gmgn.request_timeout_ms,
        );
        gmgnTrendingRawSchema.parse(JSON.parse(raw));
        insertProviderEvent(
          this.options.database,
          {
            provider: 'gmgn',
            capability: 'market.trending.1m',
            chain,
            observedAt,
            schemaVersion: 'gmgn.trending.v1',
            payload: raw,
            requestMeta: {
              endpoint_name: 'market.trending',
              method: 'cli',
              response_bytes: Buffer.byteLength(raw),
            },
          },
          this.options.writeBudget,
        );
        if (chain === 'sol')
          await delay(this.options.config.providers.gmgn.rate_limit.minimum_interval_ms);
      }
      this.gmgn = 'ok';
    } catch (error) {
      this.gmgn = 'failed';
      throw error;
    }
  }

  private async probeCoinGecko(): Promise<void> {
    const key = this.options.secrets[this.options.config.providers.coingecko.api_key_env];
    if (!key) throw new Error('CoinGecko secret is not configured');
    const options = httpOptions(this.options.config, 'coingecko', 'key');
    try {
      const result = await requestJson<Record<string, unknown>>(
        `${this.options.config.providers.coingecko.rest_base_url}/key`,
        { headers: { 'x-cg-pro-api-key': key } },
        options,
      );
      const observedAt = Date.now();
      const payload = JSON.stringify(result.data);
      insertProviderEvent(
        this.options.database,
        {
          provider: 'coingecko',
          capability: 'key',
          observedAt,
          schemaVersion: 'coingecko.key.v1',
          payload,
          requestMeta: {
            endpoint_name: 'key',
            method: 'GET',
            status: result.diagnostic.status,
            response_bytes: Buffer.byteLength(payload),
          },
        },
        this.options.writeBudget,
      );
      this.coingecko = 'ok';
    } catch (error) {
      this.coingecko = 'failed';
      throw error;
    }
  }

  private async probeTelegram(): Promise<void> {
    const token = this.options.secrets[this.options.config.providers.telegram.bot_token_env];
    if (!token) throw new Error('Telegram secret is not configured');
    try {
      await requestJson<Record<string, unknown>>(
        `https://api.telegram.org/bot${token}/getMe`,
        {},
        httpOptions(this.options.config, 'telegram', 'getMe'),
      );
      this.telegram = 'ok';
    } catch (error) {
      this.telegram = 'failed';
      throw error;
    }
  }

  private safeError(error: unknown): string {
    const values = Object.values(this.options.secrets);
    const details =
      error && typeof error === 'object' && 'diagnostic' in error
        ? JSON.stringify((error as { diagnostic: unknown }).diagnostic)
        : '';
    return redact(
      `${error instanceof Error ? error.message : String(error)}${details ? ` ${details}` : ''}`,
      values,
    ).slice(0, 500);
  }
}

function httpOptions(
  config: BotConfig,
  provider: 'coingecko' | 'telegram',
  capability: string,
): HttpClientOptions {
  const source = config.providers[provider];
  return {
    provider,
    capability,
    timeoutMs: source.request_timeout_ms,
    maxResponseBytes: source.max_response_bytes,
    maxDecompressedBytes: source.max_decompressed_bytes,
    maxAttempts: 1,
    baseDelayMs: 1,
    maxDelayMs: 1,
  };
}

function runGmgn(args: string[], apiKey: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gmgnCli, ...args, '--raw'], {
      cwd: root,
      env: { ...process.env, GMGN_API_KEY: apiKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `gmgn-cli exit ${code}`));
      else resolve(stdout.trim());
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (text, secret) =>
        text.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]'),
      value,
    );
}
