import type { ProbeDefinition } from '@cyanprint/contracts';

/**
 * Probes for the `ci` feature: scripts/ci.sh genuinely chains every gate, so a
 * sabotage any single gate catches also turns the whole chain red.
 */
const definition: ProbeDefinition = {
  contractVersion: 1,
  probes: [
    {
      name: 'baseline-ci-green',
      description: 'The untouched repo passes its full ci.sh gate chain.',
      kind: 'baseline',
      async run(repo) {
        const result = await repo.exec('bash scripts/ci.sh');
        if (result.exitCode !== 0) {
          throw new Error(`ci.sh failed on the healthy repo: ${result.stderr}`);
        }
      },
    },
    {
      name: 'gate-failure-reddens-ci',
      description: 'A sabotage caught by any chained gate must turn ci.sh red.',
      kind: 'mutation',
      expectedImpact: ['lint'],
      async run(repo) {
        const source = await repo.read('src/calc.js');
        await repo.write('src/calc.js', `${source}var sneaky = 1;\n`);
        const result = await repo.exec('bash scripts/ci.sh');
        if (result.exitCode === 0) {
          throw new Error('ci.sh stayed green while its lint gate should have failed');
        }
      },
    },
  ],
};

export default definition;
