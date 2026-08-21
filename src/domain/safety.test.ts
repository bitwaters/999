import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigText } from '../config/load.js';
import { evaluateBscSafety, evaluateSolSafety, canReuseSafetyPass } from './safety.js';
import { runAfterSafety } from './safety-gate.js';

const template = await readFile(new URL('../../config/bot.yaml', import.meta.url), 'utf8');
const loaded = parseConfigText(template);
const context = { checkedAt: 1_000, providerEventId: 'provider-1', configVersionId: 'config-1' };

test('SOL ignores BSC placeholder fields and returns canonical S0 values', () => {
  const result = evaluateSolSafety(
    {
      renounced_mint: 'yes',
      renounced_freeze_account: true,
      is_honeypot: true,
      owner_renounced: false,
      is_open_source: false,
      buy_tax: '0.99',
    },
    loaded.config.chains.sol.safety,
    context,
  );
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.canonical, {
    renounced_mint: true,
    renounced_freeze_account: true,
  });
  assert.equal(result.expiresAt, 61_000);
});

test('SOL distinguishes fatal S0, incomplete S0, and enabled S1 policy rejection', () => {
  const fatal = evaluateSolSafety(
    { renounced_mint: false, renounced_freeze_account: true },
    loaded.config.chains.sol.safety,
    context,
  );
  assert.equal(fatal.status, 'fatal');

  const incomplete = evaluateSolSafety(
    { renounced_mint: true, renounced_freeze_account: null },
    loaded.config.chains.sol.safety,
    context,
  );
  assert.equal(incomplete.status, 'incomplete');

  const config = structuredClone(loaded.config);
  config.chains.sol.safety.s1.top_10_holder_rate.enabled = true;
  config.chains.sol.safety.s1.top_10_holder_rate.verified = true;
  const rejected = evaluateSolSafety(
    {
      renounced_mint: true,
      renounced_freeze_account: true,
      top_10_holder_rate: '0.9',
    },
    config.chains.sol.safety,
    context,
  );
  assert.equal(rejected.status, 'policy_reject');

  const mixed = evaluateSolSafety(
    {
      renounced_mint: true,
      renounced_freeze_account: true,
      top_10_holder_rate: '0.9',
    },
    {
      ...config.chains.sol.safety,
      s1: {
        ...config.chains.sol.safety.s1,
        dev_team_hold_rate: { enabled: true, verified: true, max: 0.1 },
      },
    },
    context,
  );
  assert.equal(mixed.status, 'incomplete');
});

test('enabled SOL S1 missing data is incomplete, while observations do not affect status', () => {
  const config = structuredClone(loaded.config);
  config.chains.sol.safety.s1.rug_ratio.enabled = true;
  config.chains.sol.safety.s1.rug_ratio.verified = true;
  const result = evaluateSolSafety(
    {
      renounced_mint: true,
      renounced_freeze_account: true,
      is_wash_trading: true,
      bundler_rate: 'not-a-number',
    },
    config.chains.sol.safety,
    context,
  );
  assert.equal(result.status, 'incomplete');
  assert.ok(!result.reasons.includes('invalid:bundler_rate'));
});

test('BSC uses one ownership mapping and only BSC safety fields', () => {
  const pass = evaluateBscSafety(
    {
      is_honeypot: 'no',
      is_renounced: 'yes',
      owner_renounced: true,
      is_open_source: true,
      buy_tax: '0.01',
      sell_tax: '0.02',
      renounced_mint: false,
      renounced_freeze_account: false,
    },
    loaded.config.chains.bsc.safety,
    context,
  );
  assert.equal(pass.status, 'pass');
  assert.equal(pass.canonical.ownership_renounced, true);

  const conflict = evaluateBscSafety(
    {
      is_honeypot: false,
      is_renounced: true,
      owner_renounced: false,
      is_open_source: true,
      buy_tax: '0',
      sell_tax: '0',
    },
    loaded.config.chains.bsc.safety,
    context,
  );
  assert.equal(conflict.status, 'incomplete');
  assert.ok(conflict.reasons.includes('conflict:ownership_source'));
  assert.equal('ownership_renounced' in conflict.canonical, false);

  const fatal = evaluateBscSafety(
    {
      is_honeypot: 'yes',
      owner_renounced: true,
      is_open_source: true,
      buy_tax: '0.06',
      sell_tax: '0',
    },
    loaded.config.chains.bsc.safety,
    context,
  );
  assert.equal(fatal.status, 'fatal');
});

test('safety pass reuse requires freshness and the same config version', () => {
  const result = evaluateSolSafety(
    { renounced_mint: true, renounced_freeze_account: true },
    loaded.config.chains.sol.safety,
    context,
  );
  assert.equal(canReuseSafetyPass(result, 60_999, 'config-1'), true);
  assert.equal(canReuseSafetyPass(result, 61_000, 'config-1'), false);
  assert.equal(canReuseSafetyPass(result, 60_999, 'config-2'), false);
});

test('non-pass safety never calls the CoinGecko downstream gate', () => {
  const safety = evaluateSolSafety(
    { renounced_mint: false, renounced_freeze_account: true },
    loaded.config.chains.sol.safety,
    context,
  );
  let coingeckoCalls = 0;
  const blocked = runAfterSafety(safety, () => {
    coingeckoCalls += 1;
    return 'called';
  });
  assert.equal(blocked.called, false);
  assert.equal(coingeckoCalls, 0);

  const passed = evaluateSolSafety(
    { renounced_mint: true, renounced_freeze_account: true },
    loaded.config.chains.sol.safety,
    context,
  );
  const allowed = runAfterSafety(passed, () => {
    coingeckoCalls += 1;
    return 'called';
  });
  assert.equal(allowed.called, true);
  assert.equal(coingeckoCalls, 1);
});

test('SOL and BSC safety configurations remain independently typed', () => {
  assert.notDeepEqual(loaded.config.chains.sol.safety.s0, loaded.config.chains.bsc.safety.s0);
  assert.equal('renounced_mint_required' in loaded.config.chains.sol.safety.s0, true);
  assert.equal('honeypot_must_be_false' in loaded.config.chains.bsc.safety.s0, true);
});
