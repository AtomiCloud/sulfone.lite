import { existsSync } from 'node:fs';

if (!existsSync('package.json') || !existsSync('knip.precommit.json')) {
  console.error('Knip requires package.json and knip.precommit.json.');
  process.exit(1);
}

const steps: Array<[string, string[]]> = [
  ['default', ['bun', 'x', 'knip', '--config', 'knip.precommit.json', '--workspace', '.', '--include', 'files']],
  [
    'production',
    ['bun', 'x', 'knip', '--config', 'knip.precommit.json', '--workspace', '.', '--production', '--include', 'files'],
  ],
];

let failed = false;

for (const [name, args] of steps) {
  console.error(`\nknip pre-commit (${name})`);

  const result = Bun.spawnSync({
    cmd: args,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  failed ||= !result.success;
}

process.exit(failed ? 1 : 0);
