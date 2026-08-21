import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigText } from '../config/load.js';
import {
  evaluateAttention,
  evaluateConviction,
  evaluateEntryQuality,
  evaluateOrganic,
  evaluateDispatchGuard,
  solidifyEmergingSignal,
} from './ace.js';
import type { G2Window } from '../market-data/g2.js';
import type { Level1Snapshot } from '../market-data/level1.js';

const template = await readFile(new URL('../../config/bot.yaml', import.meta.url), 'utf8');
const config = parseConfigText(template).config;
const safety = {
  status: 'pass' as const,
  reasons: [],
  checkedAt: 1_000,
  expiresAt: 61_000,
  providerEventId: 'event',
  configVersionId: 'config-1',
  canonical: {},
};
const level1: Level1Snapshot = {
  chain: 'sol',
  poolAddress: 'pool',
  tokenAddress: 'token',
  observedAt: 1_000,
  dataState: 'complete',
  poolStatus: 'stable',
  reserveUsd: '20000',
  priceUsd: '1',
  buys: 10,
  sells: 2,
  buyers: 8,
  sellers: 2,
  volumeUsd: '2000',
  netBuyUsd: '1500',
  poolAgeSeconds: 100,
  lastTradeAt: 1_000,
};
const g2: G2Window = {
  status: 'complete',
  windowStart: 0,
  windowEnd: 2_000,
  coverageSeconds: 2,
  lateCount: 0,
  duplicateCount: 0,
  ambiguousCount: 0,
  buyVolumeUsd: '2000',
  sellVolumeUsd: '500',
  netBuyUsd: '1500',
  buyVolumeShare: '0.8',
  top1BuyShare: '0.2',
  top3BuyShare: '0.5',
};

test('ACE evaluates alternative Attention sources without inventing scores', () => {
  assert.equal(
    evaluateAttention(
      { rankBefore: 20, rankAfter: 10 },
      config.strategies.emerging_breakout.attention,
    ).status,
    'pass',
  );
  assert.equal(
    evaluateAttention(
      { visitingBefore: 10, visitingAfter: 11 },
      config.strategies.emerging_breakout.attention,
    ).status,
    'pass',
  );
  assert.equal(
    evaluateAttention(
      { rankBefore: 20, rankAfter: 20 },
      config.strategies.emerging_breakout.attention,
    ).status,
    'rejected',
  );
  assert.equal(
    evaluateAttention({}, config.strategies.emerging_breakout.attention).status,
    'incomplete',
  );
});

test('Conviction requires fresh Level 1 buyers and Organic blocks concentration', () => {
  assert.equal(
    evaluateConviction(g2, level1, 45_000, 45, config.strategies.emerging_breakout.conviction)
      .status,
    'pass',
  );
  assert.equal(
    evaluateConviction(
      g2,
      { ...level1, observedAt: 0 },
      46_000,
      45,
      config.strategies.emerging_breakout.conviction,
    ).status,
    'incomplete',
  );
  assert.equal(
    evaluateOrganic(g2, safety, config.strategies.emerging_breakout.organic_growth).status,
    'pass',
  );
  assert.equal(
    evaluateOrganic(
      { ...g2, top1BuyShare: '0.8' },
      safety,
      config.strategies.emerging_breakout.organic_growth,
    ).status,
    'rejected',
  );
});

test('unique Emerging Breakout requires all hard gates and dispatch guard cancels overextension', () => {
  const attention = evaluateAttention(
    { rankBefore: 20, rankAfter: 10 },
    config.strategies.emerging_breakout.attention,
  );
  const conviction = evaluateConviction(
    g2,
    level1,
    45_000,
    45,
    config.strategies.emerging_breakout.conviction,
  );
  const organic = evaluateOrganic(g2, safety, config.strategies.emerging_breakout.organic_growth);
  const entryQuality = evaluateEntryQuality(
    { reserveUsd: '20000', priceExtension: '0.1', preSendDrift: '0.05' },
    config.strategies.emerging_breakout.entry_quality,
  );
  const solidified = solidifyEmergingSignal({
    candidateKey: 'sol:token:1',
    chain: 'sol',
    tokenAddress: 'token',
    poolAddress: 'pool',
    cycleStartedAt: 1,
    confirmedAt: 2_000,
    entryTtlSeconds: 60,
    configVersionId: 'config-1',
    confirmationPriceUsd: '1',
    safety,
    candidateFresh: true,
    poolStable: true,
    level1Fresh: true,
    g2State: 'complete',
    evidenceComplete: true,
    attention,
    conviction,
    organic,
    entryQuality,
  });
  assert.equal(solidified.status, 'pass');
  if (solidified.status !== 'pass') return;
  assert.equal(solidified.snapshot.signalType, 'Emerging Breakout');
  const send = evaluateDispatchGuard({
    signal: solidified.snapshot,
    now: 2_001,
    safety,
    latestPoolStable: true,
    latestPoolFresh: true,
    latestG2State: 'complete',
    latestPriceUsd: '1.2',
    maxPreSendDrift: '0.1',
  });
  assert.equal(send.status, 'cancel');
  assert.equal(solidified.snapshot.expiresAt, 62_000);
  assert.equal(
    solidifyEmergingSignal({
      candidateKey: 'sol:token:2',
      chain: 'sol',
      tokenAddress: 'token',
      poolAddress: 'pool',
      cycleStartedAt: 1,
      confirmedAt: 2_000,
      entryTtlSeconds: 60,
      configVersionId: 'config-1',
      confirmationPriceUsd: '0',
      safety,
      candidateFresh: true,
      poolStable: true,
      level1Fresh: true,
      g2State: 'complete',
      evidenceComplete: true,
      attention,
      conviction,
      organic,
      entryQuality,
    }).status,
    'blocked',
  );
});
