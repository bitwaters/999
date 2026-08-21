import { loadConfig, requireSecretEnv } from '../config/load.js';

const loaded = await loadConfig();
const secretsChecked = process.argv.includes('--check-secrets');
if (secretsChecked) requireSecretEnv(loaded.config);
console.log(
  JSON.stringify({
    config_hash: loaded.configHash,
    git_commit: loaded.gitCommit,
    run_mode: loaded.runMode,
    secrets_checked: secretsChecked,
  }),
);
