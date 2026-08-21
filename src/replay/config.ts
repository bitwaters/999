import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { parseConfigText, type LoadedConfig } from '../config/load.js';

export type ReplayConfigInput = {
  currentBotYaml?: string;
  savedConfigYaml?: string;
  overrides?: readonly string[];
  gitCwd?: string;
  worktreeStatus?: string;
};

export function assertCleanReplayWorktree(status?: string, gitCwd = process.cwd()): void {
  const porcelain =
    status ?? execFileSync('git', ['-C', gitCwd, 'status', '--porcelain'], { encoding: 'utf8' });
  if (porcelain.trim() !== '') throw new Error('Replay requires a clean worktree');
}

export function loadReplayConfig(input: ReplayConfigInput): LoadedConfig {
  assertCleanReplayWorktree(input.worktreeStatus, input.gitCwd);
  const overrides = input.overrides ?? [];
  if (input.currentBotYaml && input.savedConfigYaml)
    throw new Error('Replay accepts one config source only');
  if (input.currentBotYaml && overrides.length > 0)
    throw new Error('Replay --set requires a saved config version');
  if (!input.currentBotYaml && !input.savedConfigYaml)
    throw new Error('Replay requires current bot.yaml or a saved config version');
  if (input.savedConfigYaml && overrides.length === 0)
    throw new Error('Saved replay config requires explicit --set overrides');
  const base = input.savedConfigYaml ?? input.currentBotYaml!;
  const text = overrides.length === 0 ? base : applyOverrides(base, overrides);
  return parseConfigText(
    text,
    input.gitCwd,
    process.env.CONTAINERIZED_RUN === '1' ? process.env : undefined,
  );
}

function applyOverrides(yamlText: string, overrides: readonly string[]): string {
  const parsed: unknown = YAML.parse(yamlText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Replay config must be a YAML object');
  const root = structuredClone(parsed) as Record<string, unknown>;
  for (const override of overrides) {
    const separator = override.indexOf('=');
    if (separator <= 0) throw new Error(`Invalid replay override: ${override}`);
    const path = override.slice(0, separator).split('.');
    const value = YAML.parse(override.slice(separator + 1));
    let cursor: Record<string, unknown> = root;
    for (const segment of path.slice(0, -1)) {
      const next = cursor[segment];
      if (!next || typeof next !== 'object' || Array.isArray(next))
        throw new Error(`Replay override path does not exist: ${path.join('.')}`);
      cursor = next as Record<string, unknown>;
    }
    const leaf = path.at(-1)!;
    if (!(leaf in cursor))
      throw new Error(`Replay override path does not exist: ${path.join('.')}`);
    cursor[leaf] = value;
  }
  return YAML.stringify(root);
}
