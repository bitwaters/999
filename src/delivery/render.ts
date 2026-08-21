import type { SignalSnapshot } from '../pipeline/ace.js';

export type DeliveryDestination = 'admin_private' | 'channel' | 'group';

export type EntryMessage = {
  chain: 'sol' | 'bsc';
  tokenAddress: string;
  poolAddress: string;
  priceUsd: string;
  reserveUsd: string;
  attentionSummary: string;
  convictionSummary: string;
  safetySummary: string;
  configVersionId: string;
};

export function renderEntry(snapshot: SignalSnapshot, destination: DeliveryDestination): string {
  const base = [
    'Emerging Breakout',
    `chain=${safe(snapshot.chain)}`,
    `token=${safe(snapshot.tokenAddress)}`,
    `pool=${safe(snapshot.poolAddress)}`,
    `price_usd=${safe(snapshot.confirmationPriceUsd)}`,
    `config=${safe(snapshot.configVersionId)}`,
  ];
  if (destination === 'admin_private') {
    return [
      ...base,
      `attention=${safe(snapshot.attention.status)}`,
      `conviction=${safe(snapshot.conviction.status)}`,
      `organic=${safe(snapshot.organic.status)}`,
      `entry_quality=${safe(snapshot.entryQuality.status)}`,
      `expires_at=${snapshot.expiresAt}`,
    ].join('\n');
  }
  return base.join('\n');
}

export function renderReport(text: string, destination: DeliveryDestination): string {
  if (destination !== 'admin_private') throw new Error('REPORT is admin_private-only');
  return `REPORT\n${safe(text)}`;
}

export function renderSystemAlert(text: string, destination: DeliveryDestination): string {
  if (destination !== 'admin_private') throw new Error('SYSTEM_ALERT is admin_private-only');
  return `SYSTEM_ALERT\n${safe(text)}`;
}

function safe(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('')
    .trim();
}
