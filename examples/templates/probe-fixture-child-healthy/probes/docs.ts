import type { ProbeDefinition } from '@cyanprint/contracts';

/**
 * Probes for the child's own `docs` feature. The parent's features need no
 * authoring here: composing the parent is enough to inherit their probes.
 */
const definition: ProbeDefinition = {
  contractVersion: 1,
  probes: [
    {
      name: 'baseline-usage-doc-present',
      description: 'The generated repo documents usage in docs/USAGE.md.',
      kind: 'baseline',
      async run(repo) {
        const content = await repo.read('docs/USAGE.md');
        if (!content.includes('# Usage')) {
          throw new Error('docs/USAGE.md is missing its Usage heading');
        }
      },
    },
  ],
};

export default definition;
