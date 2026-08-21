import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionCommand } from './coingecko-g2.js';

test('G2 subscription command uses the provider OnchainTrade protocol', () => {
  assert.deepEqual(JSON.parse(subscriptionCommand()), {
    command: 'subscribe',
    identifier: JSON.stringify({ channel: 'OnchainTrade' }),
  });
});
