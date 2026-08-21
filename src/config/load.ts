import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { configSchema, type BotConfig } from './schema.js';

export type LoadedConfig = {
  config: BotConfig;
  normalizedYaml: string;
  configHash: string;
  gitCommit: string;
  runMode: BotConfig['global']['run_mode'];
};

const telegramDestinationEnv = {
  adminUserIds: 'TELEGRAM_ADMIN_USER_IDS',
  adminChatId: 'TELEGRAM_ADMIN_CHAT_ID',
  channelChatId: 'TELEGRAM_CHANNEL_CHAT_ID',
  groupChatId: 'TELEGRAM_GROUP_CHAT_ID',
} as const;

function readNonBlankEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function resolveTelegramDestinations(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const root = structuredClone(value) as Record<string, unknown>;
  const delivery = root.delivery;
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) return root;
  const deliveryRecord = delivery as Record<string, unknown>;
  const adminPrivate = deliveryRecord.admin_private;
  const channel = deliveryRecord.channel;
  const group = deliveryRecord.group;
  if (
    !adminPrivate ||
    typeof adminPrivate !== 'object' ||
    Array.isArray(adminPrivate) ||
    !channel ||
    typeof channel !== 'object' ||
    Array.isArray(channel) ||
    !group ||
    typeof group !== 'object' ||
    Array.isArray(group)
  )
    return root;

  const adminRecord = adminPrivate as Record<string, unknown>;
  const channelRecord = channel as Record<string, unknown>;
  const groupRecord = group as Record<string, unknown>;
  const names = Object.values(telegramDestinationEnv);
  const values = names.map((name) => readNonBlankEnv(env, name));
  const supplied = values.filter((item): item is string => item !== undefined);
  if (supplied.length !== names.length)
    throw new Error(
      supplied.length === 0
        ? 'Telegram destination environment variables are required at runtime'
        : 'Telegram destination environment variables must be provided together',
    );

  adminRecord.chat_id = values[1];
  adminRecord.allowed_user_ids = values[0]!.split(/[\s,]+/u).filter(Boolean);
  channelRecord.chat_id = values[2];
  groupRecord.chat_id = values[3];
  return root;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

export function normalizeConfig(config: BotConfig): string {
  return YAML.stringify(sortKeys(config), { sortMapEntries: true });
}

export function parseConfigText(
  text: string,
  gitCwd = process.cwd(),
  env?: NodeJS.ProcessEnv,
): LoadedConfig {
  const parsed: unknown = YAML.parse(text);
  const config = configSchema.parse(env ? resolveTelegramDestinations(parsed, env) : parsed);
  const normalizedYaml = normalizeConfig(config);
  const configHash = createHash('sha256').update(normalizedYaml).digest('hex');
  return {
    config,
    normalizedYaml,
    configHash,
    gitCommit: readGitCommit(gitCwd),
    runMode: config.global.run_mode,
  };
}

export async function loadConfig(
  configPath = path.resolve('config/bot.yaml'),
): Promise<LoadedConfig> {
  return parseConfigText(await readFile(configPath, 'utf8'), path.dirname(configPath), process.env);
}

export function readGitCommit(cwd = process.cwd()): string {
  const injected = process.env.BUILD_GIT_COMMIT?.trim();
  if (/^[a-f0-9]{7,64}$/u.test(injected ?? '')) return injected!;
  try {
    return (
      execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || 'uncommitted'
    );
  } catch {
    return 'uncommitted';
  }
}

export function requireSecretEnv(
  config: BotConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const names = [
    ...new Set([
      config.providers.gmgn.api_key_env,
      config.providers.coingecko.api_key_env,
      config.providers.telegram.bot_token_env,
    ]),
  ];
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0)
    throw new Error(`Missing required secret environment variables: ${missing.join(', ')}`);
  return Object.fromEntries(names.map((name) => [name, env[name]!.trim()]));
}
