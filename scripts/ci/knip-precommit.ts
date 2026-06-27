import { existsSync } from 'node:fs';

if (!existsSync('package.json') && !existsSync('knip.precommit.json')) {
  console.error('Skipping Knip: package.json and knip.precommit.json are absent.');
  process.exit(0);
}

const steps = [
  ['default', ['run', 'knip', '--config', 'knip.precommit.json', '--include', 'files']],
  ['production', ['run', 'knip', '--config', 'knip.precommit.json', '--production', '--include', 'files']],
] as const;

let failed = false;

for (const [name, args] of steps) {
  console.error(`\nknip pre-commit (${name})`);

  const result = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    stdout: 'inherit',
    stderr: 'inherit',
  });

  failed ||= !result.success;
}

process.exit(failed ? 1 : 0);
