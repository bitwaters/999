import type { CanonicalPool } from '../market-data/pools.js';
import {
  G2SubscriptionManager,
  type RawG2Item,
  type G2SubscriptionState,
} from '../market-data/g2.js';

type G2Logger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

export type G2ClientOptions = {
  websocketUrl: string;
  apiKey: string;
  maxSubscriptions: number;
  maxResponseBytes: number;
  connectTimeoutMs: number;
  reconnectDelayMs: number;
  logger?: G2Logger;
  onMessage?: (message: RawG2Item, observedAt: number) => void;
};

export type G2ClientStatus = 'ok' | 'failed' | 'unknown';

export class CoinGeckoG2Client {
  private readonly manager: G2SubscriptionManager;
  private socket: WebSocket | undefined;
  private connectPromise: Promise<void> | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private confirmed = false;
  private state: G2ClientStatus = 'unknown';

  public constructor(private readonly options: G2ClientOptions) {
    this.manager = new G2SubscriptionManager(options.maxSubscriptions);
    if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0)
      throw new Error('Invalid G2 response limit');
    if (!Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs <= 0)
      throw new Error('Invalid G2 connect timeout');
    if (!Number.isSafeInteger(options.reconnectDelayMs) || options.reconnectDelayMs <= 0)
      throw new Error('Invalid G2 reconnect delay');
  }

  public status(): G2ClientStatus {
    return this.state;
  }

  public async start(): Promise<void> {
    this.stopping = false;
    if (this.socket || this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectOnce().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.confirmed = false;
    this.manager.disconnect();
    socket?.close();
    await this.connectPromise;
  }

  public request(
    pool: CanonicalPool,
    state: G2SubscriptionState,
  ): 'subscribe' | 'retain' | 'rejected_capacity' {
    const result = this.manager.request(pool, state);
    if (result === 'subscribe' && this.confirmed) this.sendSetPools();
    return result;
  }

  public unset(poolIdentityKey: string): boolean {
    const removed = this.manager.unset(poolIdentityKey);
    if (removed && this.confirmed) this.sendSetPools();
    return removed;
  }

  public active(): ReadonlyMap<string, G2SubscriptionState> {
    return this.manager.active();
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const url = new URL(this.options.websocketUrl);
      url.searchParams.set('x_cg_pro_api_key', this.options.apiKey);
      const socket = new WebSocket(url);
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        this.fail('g2_connect_timeout');
        reject(new Error('CoinGecko G2 connection timed out'));
      }, this.options.connectTimeoutMs);
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.socket = socket;
        this.confirmed = false;
        this.manager.connect();
        this.state = 'ok';
        this.options.logger?.('info', 'g2_connected');
        socket.send(subscriptionCommand());
        resolve();
      });
      socket.addEventListener('message', (event) => void this.handleMessage(event.data));
      socket.addEventListener('error', () => {
        this.fail('g2_socket_error');
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('CoinGecko G2 socket error'));
        }
      });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        if (this.socket === socket) this.socket = undefined;
        this.confirmed = false;
        this.manager.disconnect();
        if (!settled) {
          settled = true;
          reject(new Error('CoinGecko G2 socket closed before connect'));
        }
        this.scheduleReconnect();
      });
    });
  }

  private async handleMessage(data: unknown): Promise<void> {
    const raw = await messageText(data);
    if (raw === undefined) {
      this.fail('g2_invalid_message');
      this.socket?.close();
      return;
    }
    if (Buffer.byteLength(raw, 'utf8') > this.options.maxResponseBytes) {
      this.fail('g2_response_too_large');
      this.socket?.close();
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.fail('g2_invalid_json');
      this.socket?.close();
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.fail('g2_invalid_shape');
      this.socket?.close();
      return;
    }
    const record = message as Record<string, unknown>;
    if (record.type === 'confirm_subscription') {
      this.confirmed = true;
      this.sendSetPools();
      return;
    }
    if (record.c === 'G2') this.options.onMessage?.(record, Date.now());
  }

  private sendSetPools(): void {
    if (!this.socket || !this.confirmed) return;
    const pools = [...this.manager.active().keys()].map((identityKey) => {
      const [chain, poolAddress] = identityKey.split(':');
      return `${chain === 'sol' ? 'solana' : 'bsc'}:${poolAddress}`;
    });
    this.socket.send(
      JSON.stringify({
        command: 'message',
        identifier: JSON.stringify({ channel: 'OnchainTrade' }),
        data: JSON.stringify({ 'network_id:pool_addresses': pools, action: 'set_pools' }),
      }),
    );
  }

  private fail(event: string): void {
    this.state = 'failed';
    this.options.logger?.('warn', event);
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start().catch(() => undefined);
    }, this.options.reconnectDelayMs);
  }
}

export function subscriptionCommand(): string {
  return JSON.stringify({
    command: 'subscribe',
    identifier: JSON.stringify({ channel: 'OnchainTrade' }),
  });
}

async function messageText(data: unknown): Promise<string | undefined> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (data instanceof Blob) return data.text();
  return undefined;
}
