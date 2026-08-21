import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseConfigText } from '../config/load.js';
import { evaluateSolSafety } from '../domain/safety.js';
import type { G2Window } from '../market-data/g2.js';
import type { Level1Snapshot } from '../market-data/level1.js';
import { orchestrateSignal } from './signal-orchestrator.js';

const config = parseConfigText(
  readFileSync(new URL('../../config/bot.yaml', import.meta.url), 'utf8'),
);

const safety = evaluateSolSafety(
  { renounced_mint: true, renounced_freeze_account: true },
  config.config.chains.sol.safety,
  { checkedAt: 1_000, providerEventId: 'event', configVersionId: '1' },
);
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
  buyers: 10,
  sellers: 2,
  volumeUsd: '2000',
  netBuyUsd: '1500',
  poolAgeSeconds: 120,
  lastTradeAt: 1_000,
};
const g2: G2Window = {
  status: 'partial',
  windowStart: 0,
  windowEnd: 2_000,
  coverageSeconds: 1,
  lateCount: 0,
  duplicateCount: 0,
  ambiguousCount: 0,
  buyVolumeUsd: '1000',
  sellVolumeUsd: '100',
  netBuyUsd: '900',
  buyVolumeShare: '0.9',
  top1BuyShare: '0.2',
  top3BuyShare: '0.5',
};

test('signal orchestration remains blocked when G2 is not complete', () => {
  const result = orchestrateSignal(
    {
      candidateKey: 'sol:token',
      chain: 'sol',
      tokenAddress: 'token',
      poolAddress: 'pool',
      cycleStartedAt: 1_000,
      confirmedAt: 1_500,
      configVersionId: '1',
      safety,
      level1,
      g2,
      candidateFresh: true,
      poolStable: true,
      priceExtension: '0.1',
      preSendDrift: '0.01',
      attention: { status: 'pass', reasons: [] },
    },
    config.config,
  );
  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') assert.ok(result.reasons.includes('g2:partial'));
});

test('signal orchestration rejects a stale safety pass before solidification', () => {
  const result = orchestrateSignal(
    {
      candidateKey: 'sol:token',
      chain: 'sol',
      tokenAddress: 'token',
      poolAddress: 'pool',
      cycleStartedAt: 1_000,
      confirmedAt: 61_000,
      configVersionId: '1',
      safety,
      level1,
      g2: { ...g2, status: 'complete' },
      candidateFresh: true,
      poolStable: true,
      priceExtension: '0.1',
      preSendDrift: '0.01',
      attention: { status: 'pass', reasons: [] },
    },
    config.config,
  );
  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked')
    assert.ok(result.reasons.includes('safety:not_fresh_or_config_mismatch'));
});
