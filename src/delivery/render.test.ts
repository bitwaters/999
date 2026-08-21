import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEntry, renderReport, renderSystemAlert } from './render.js';
import type { SignalSnapshot } from '../pipeline/ace.js';

const snapshot: SignalSnapshot = {
  signalType: 'Emerging Breakout',
  candidateKey: 'sol:token:1',
  chain: 'sol',
  tokenAddress: 'token',
  poolAddress: 'pool',
  cycleStartedAt: 1,
  confirmedAt: 2,
  expiresAt: 62_000,
  configVersionId: 'config',
  confirmationPriceUsd: '1',
  attention: { status: 'pass', reasons: [] },
  conviction: { status: 'pass', reasons: [] },
  organic: { status: 'pass', reasons: [] },
  entryQuality: { status: 'pass', reasons: [] },
  age: {
    status: 'pass',
    mode: 'newborn',
    coverageSeconds: 60,
    rates: { buys: '0.1', buyers: '0.1', volumeUsd: '10' },
  },
};

test('entry renderer restricts channel/group to concise content', () => {
  const admin = renderEntry(snapshot, 'admin_private');
  const channel = renderEntry(snapshot, 'channel');
  assert.match(admin, /attention=pass/u);
  assert.doesNotMatch(channel, /attention=pass/u);
  assert.match(renderEntry(snapshot, 'group'), /Emerging Breakout/u);
  assert.throws(() => renderReport('diagnostic', 'channel'), /admin_private/u);
  assert.throws(() => renderSystemAlert('failure', 'group'), /admin_private/u);
});
