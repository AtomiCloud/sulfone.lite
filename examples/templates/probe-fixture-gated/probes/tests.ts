import type { ProbeDefinition } from '@cyanprint/contracts';

/**
 * Probes for the `tests` feature: the generated repo carries a real bun test
 * suite whose gate genuinely reddens when the suite is deleted or failing.
 */
const definition: ProbeDefinition = {
  contractVersion: 1,
  probes: [
    {
      name: 'baseline-test-gate-green',
      description: 'The untouched repo passes its test gate.',
      kind: 'baseline',
      async run(repo) {
        const result = await repo.exec('bash scripts/test-gate.sh');
        if (result.exitCode !== 0) {
          throw new Error(`test gate failed on the healthy repo: ${result.stderr}`);
        }
      },
    },
    {
      name: 'deleting-tests-reddens-gate',
      description: 'Removing the whole test suite must turn the test gate red.',
      kind: 'mutation',
      expectedImpact: ['coverage', 'ci'],
      async run(repo) {
        await repo.remove('tests');
        const result = await repo.exec('bash scripts/test-gate.sh');
        if (result.exitCode === 0) {
          throw new Error('test gate stayed green after the test suite was deleted');
        }
      },
    },
    {
      name: 'failing-test-reddens-gate',
      description: 'A genuinely failing test must turn the test gate red.',
      kind: 'mutation',
      expectedImpact: ['ci'],
      async run(repo) {
        await repo.patch('src/calc.js', { find: 'return left + right;', replace: 'return left - right;' });
        const result = await repo.exec('bash scripts/test-gate.sh');
        if (result.exitCode === 0) {
          throw new Error('test gate stayed green with a failing test');
        }
      },
    },
  ],
};

export default definition;
