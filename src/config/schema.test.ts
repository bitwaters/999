import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { parseConfigText, readGitCommit, requireSecretEnv } from './load.js';

const template = await readFile(new URL('../../config/bot.yaml', import.meta.url), 'utf8');

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('accepts the complete Shadow configuration', () => {
  const loaded = parseConfigText(template);
  assert.equal(loaded.runMode, 'shadow');
  assert.equal(loaded.config.delivery.outcome_anchor_destination, 'admin_private');
  assert.equal(loaded.config.providers.coingecko.max_pools_per_batch, 50);
  assert.match(loaded.configHash, /^[a-f0-9]{64}$/u);
});

test('uses the injected build commit when container metadata has no Git checkout', () => {
  const previous = process.env.BUILD_GIT_COMMIT;
  process.env.BUILD_GIT_COMMIT = '0123456789abcdef0123456789abcdef01234567';
  try {
    assert.equal(readGitCommit('/path/without/a/git/checkout'), process.env.BUILD_GIT_COMMIT);
  } finally {
    if (previous === undefined) delete process.env.BUILD_GIT_COMMIT;
    else process.env.BUILD_GIT_COMMIT = previous;
  }
});

test('rejects unknown keys instead of silently dropping them', () => {
  const value = YAML.parse(template) as Record<string, unknown>;
  (value.global as Record<string, unknown>).unexpected = true;
  assert.throws(() => parseConfigText(YAML.stringify(value)), /Unrecognized key/u);
});

test('rejects Shadow channel or group delivery', () => {
  const value = record(YAML.parse(template));
  const delivery = record(value.delivery);
  const channel = record(delivery.channel);
  channel.enabled = true;
  assert.throws(() => parseConfigText(YAML.stringify(value)), /Shadow mode requires/u);
});

test('rejects invalid run mode and numeric Telegram IDs', () => {
  const value = record(YAML.parse(template));
  const global = record(value.global);
  const delivery = record(value.delivery);
  const adminPrivate = record(delivery.admin_private);
  global.run_mode = 'development';
  assert.throws(() => parseConfigText(YAML.stringify(value)), /Invalid option/u);
  global.run_mode = 'shadow';
  adminPrivate.chat_id = 123;
  assert.throws(() => parseConfigText(YAML.stringify(value)), /expected string/u);
});

test('rejects invalid credits and queue watermarks', () => {
  const value = record(YAML.parse(template));
  const providers = record(value.providers);
  const coingecko = record(providers.coingecko);
  const creditBuckets = record(coingecko.credit_buckets);
  const runtime = record(value.runtime);
  const g2Queue = record(runtime.g2_queue);
  creditBuckets.reserve_percent = 6;
  assert.throws(() => parseConfigText(YAML.stringify(value)), /total 100/u);
  creditBuckets.reserve_percent = 5;
  g2Queue.high_watermark = 10000;
  assert.throws(() => parseConfigText(YAML.stringify(value)), /high < hard/u);
});

test('rejects unsupported GMGN signal types', () => {
  const value = YAML.parse(template) as Record<string, unknown>;
  const providers = value.providers as Record<string, unknown>;
  const gmgn = providers.gmgn as Record<string, unknown>;
  gmgn.signal_type_allowlist = [14];
  assert.throws(() => parseConfigText(YAML.stringify(value)), /14, 15, and 16/u);
});

test('rejects enabling an unverified S1 field', () => {
  const value = record(YAML.parse(template));
  const chains = record(value.chains);
  const sol = record(chains.sol);
  const safety = record(sol.safety);
  const s1 = record(safety.s1);
  const top10 = record(s1.top_10_holder_rate);
  top10.enabled = true;
  assert.throws(() => parseConfigText(YAML.stringify(value)), /must be verified/u);
});

test('blocks production until both chain S0 fixtures are verified', () => {
  const value = record(YAML.parse(template));
  const global = record(value.global);
  global.run_mode = 'production';
  assert.throws(() => parseConfigText(YAML.stringify(value)), /verified SOL and BSC S0/u);
});

test('requires non-blank secret environment values without exposing them', () => {
  const loaded = parseConfigText(template);
  assert.throws(
    () =>
      requireSecretEnv(loaded.config, {
        GMGN_API_KEY: ' ',
        COINGECKO_PRO_API_KEY: 'cg',
        TELEGRAM_BOT_TOKEN: 'tg',
      }),
    /GMGN_API_KEY/u,
  );
  assert.deepEqual(
    requireSecretEnv(loaded.config, {
      GMGN_API_KEY: ' gmgn ',
      COINGECKO_PRO_API_KEY: 'cg',
      TELEGRAM_BOT_TOKEN: 'tg',
    }),
    {
      GMGN_API_KEY: 'gmgn',
      COINGECKO_PRO_API_KEY: 'cg',
      TELEGRAM_BOT_TOKEN: 'tg',
    },
  );
});

test('resolves Telegram destinations from complete runtime environment without changing source YAML', () => {
  const loaded = parseConfigText(template, process.cwd(), {
    TELEGRAM_ADMIN_USER_IDS: '101, 102',
    TELEGRAM_ADMIN_CHAT_ID: '101',
    TELEGRAM_CHANNEL_CHAT_ID: '-1001',
    TELEGRAM_GROUP_CHAT_ID: '-1002',
  });
  assert.deepEqual(loaded.config.delivery.admin_private.allowed_user_ids, ['101', '102']);
  assert.equal(loaded.config.delivery.admin_private.chat_id, '101');
  assert.equal(loaded.config.delivery.channel.chat_id, '-1001');
  assert.equal(loaded.config.delivery.group.chat_id, '-1002');
  assert.doesNotMatch(template, /(?:101|102|-1001|-1002)/u);
});

test('rejects partial Telegram destination environment', () => {
  assert.throws(
    () =>
      parseConfigText(template, process.cwd(), {
        TELEGRAM_ADMIN_USER_IDS: '101',
        TELEGRAM_ADMIN_CHAT_ID: '101',
      }),
    /Telegram destination environment variables must be provided together/u,
  );
});

test('requires Telegram destination environment when runtime resolution is enabled', () => {
  assert.throws(
    () => parseConfigText(template, process.cwd(), {}),
    /Telegram destination environment variables are required at runtime/u,
  );
});

test('produces the same config hash regardless of YAML key order', () => {
  const value = record(YAML.parse(template));
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(
    parseConfigText(template).configHash,
    parseConfigText(YAML.stringify(reordered)).configHash,
  );
});
