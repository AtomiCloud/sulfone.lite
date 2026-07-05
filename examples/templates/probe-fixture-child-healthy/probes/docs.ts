import type { ProbeDefinition } from '@cyanprint/contracts';

/**
 * Probes for the child's own `docs` feature. The parent's features need no
 * authoring here: composing the parent is enough to inherit their probes.
 *
 * `docs` is a first-class gated feature: the child ships `scripts/docs-gate.sh`,
 * a genuine generated-repo gate that scans `docs/USAGE.md` and reddens on drift.
 * These probes run THAT gate — the baseline proves it is green on the untouched
 * repo, and the mutation sabotages the doc then asserts the generated-repo gate
 * turns red (mirroring the parent's lint/coverage/test probes, per SKILL.md's
 * rule that a mutation must redden a real generated-repo gate).
 */
const definition: ProbeDefinition = {
  contractVersion: 1,
  probes: [
    {
      name: 'baseline-usage-doc-present',
      description: 'The untouched repo passes its docs gate.',
      kind: 'baseline',
      async run(repo) {
        const result = await repo.exec('bash scripts/docs-gate.sh');
        if (result.exitCode !== 0) {
          throw new Error(`docs gate failed on the healthy repo: ${result.stderr}`);
        }
      },
    },
    {
      name: 'stripped-usage-heading-fails-doc-check',
      description: 'Removing the Usage heading from docs/USAGE.md must turn the docs gate red.',
      kind: 'mutation',
      async run(repo) {
        await repo.patch('docs/USAGE.md', { find: '# Usage', replace: '# Removed' });
        const result = await repo.exec('bash scripts/docs-gate.sh');
        if (result.exitCode === 0) {
          throw new Error('docs gate stayed green after the Usage heading was removed');
        }
      },
    },
  ],
};

export default definition;
