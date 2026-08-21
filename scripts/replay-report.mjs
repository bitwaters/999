#!/usr/bin/env node
function requireCleanMain() {
  if (process.env.CONTAINERIZED_RUN !== '1')
    throw new Error('replay/report wrapper must run inside the versioned container');
  if (!process.env.BUILD_GIT_COMMIT || process.env.BUILD_GIT_COMMIT === 'unknown')
    throw new Error('replay/report wrapper requires a versioned image');
  if (process.env.BUILD_WORKTREE_STATUS !== '')
    throw new Error('replay/report wrapper requires a clean worktree at image build');
}

const command = process.argv[2];
if (command !== 'replay' && command !== 'report') {
  console.error('usage: CONTAINERIZED_RUN=1 node scripts/replay-report.mjs <replay|report>');
  process.exitCode = 2;
} else {
  requireCleanMain();
  console.log(
    JSON.stringify({
      command,
      status: 'guarded',
      writes: command === 'replay' ? ['replay_runs', 'replay_results'] : [],
    }),
  );
}
