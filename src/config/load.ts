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

export function parseConfigText(text: string, gitCwd = process.cwd()): LoadedConfig {
  const parsed: unknown = YAML.parse(text);
  const config = configSchema.parse(parsed);
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
  return parseConfigText(await readFile(configPath, 'utf8'), path.dirname(configPath));
}

export function readGitCommit(cwd = process.cwd()): string {
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
