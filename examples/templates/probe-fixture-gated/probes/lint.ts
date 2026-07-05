import type { ProbeDefinition } from '@cyanprint/contracts';

/**
 * Probes for the `lint` feature: the lint gate genuinely scans src/ and turns
 * red when a forbidden construct is introduced.
 */
const definition: ProbeDefinition = {
  contractVersion: 1,
  probes: [
    {
      name: 'baseline-lint-gate-green',
      description: 'The untouched repo passes its lint gate.',
      kind: 'baseline',
      async run(repo) {
        const result = await repo.exec('bash scripts/lint-gate.sh');
        if (result.exitCode !== 0) {
          throw new Error(`lint gate failed on the healthy repo: ${result.stderr}`);
        }
      },
    },
    {
      name: 'lint-error-reddens-gate',
      description: 'Introducing a forbidden var binding must turn the lint gate red.',
      kind: 'mutation',
      expectedImpact: ['ci'],
      async run(repo) {
        const source = await repo.read('src/calc.js');
        await repo.write('src/calc.js', `${source}var sneaky = 1;\n`);
        const result = await repo.exec('bash scripts/lint-gate.sh');
        if (result.exitCode === 0) {
          throw new Error('lint gate stayed green with a forbidden var binding');
        }
      },
    },
  ],
};

export default definition;
