import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject } from '../create/create-project';
import { probeKey, type ResolvedFeatureProbes } from './matrix';
import { executeProbeMatrix } from './executor';
import { resolveProbesFromSource } from './resolve';

// AC5: the verdict vocabulary + attribution rules, end-to-end against plan-1's
// real fixtures. The engine is driven with EXPLICITLY SUPPLIED probe sources
// (probe-fixture-gated's definitions; the parent's for the mode-3 pair) plus
// explicit feature sets — Milestones A+B only, no three-tier resolution. Probes
// execute in isolated child processes, so each feature is resolved from its real
// `probes/<name>.ts` file (never an in-process closure); the few edge scenarios
// that need a bespoke probe write one to a temp source dir and resolve it the
// same way.

const T = 300_000;
const templatesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../examples/templates');
const gatedDir = join(templatesRoot, 'probe-fixture-gated');
const parentDir = join(templatesRoot, 'probe-fixture-parent');

const FIXTURES = [
  'probe-fixture-gated',
  'probe-fixture-parent',
  'probe-fixture-child-broken',
  'probe-fixture-falsegreen-zero-test',
] as const;

let workRoot: string;
const repos = new Map<string, string>();

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-verdicts-test-'));
  for (const fixture of FIXTURES) {
    const outDir = join(workRoot, fixture);
    const result = await createProject({ template: join(templatesRoot, fixture), outDir, headless: true });
    if (result.status !== 'done') {
      throw new Error(`generation of ${fixture} did not complete`);
    }
    repos.set(fixture, outDir);
  }
}, T);

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function repoOf(fixture: (typeof FIXTURES)[number]): string {
  const repo = repos.get(fixture);
  if (!repo) {
    throw new Error(`fixture ${fixture} was not generated`);
  }
  return repo;
}

/** Resolve real fixture probe files (explicit-source mode) for the given identities. */
function fixtureFeatures(dir: string, ids: Array<[string, string]>): Promise<ResolvedFeatureProbes[]> {
  return resolveProbesFromSource({ sourceDir: dir, features: ids.map(([template, name]) => ({ template, name })) });
}

/** Write a bespoke probe to a fresh temp source dir and resolve it for isolated execution. */
async function customFeature(
  template: string,
  name: string,
  probesArraySource: string,
): Promise<ResolvedFeatureProbes> {
  const dir = await mkdtemp(join(workRoot, 'custom-'));
  await mkdir(join(dir, 'probes'), { recursive: true });
  await writeFile(
    join(dir, 'probes', `${name}.ts`),
    `export default { contractVersion: 1, probes: ${probesArraySource} };\n`,
    'utf8',
  );
  const [resolved] = await resolveProbesFromSource({ sourceDir: dir, features: [{ template, name }] });
  if (!resolved) {
    throw new Error(`failed to resolve custom feature ${template}#${name}`);
  }
  return resolved;
}

const GATED = 'cyanprint/probe-fixture-gated';
const PARENT = 'cyanprint/probe-fixture-parent';

describe('verdicts + attribution against plan-1 fixtures (AC5)', () => {
  test(
    'scenario 1 — healthy fixture, full matrix: every baseline proven, every mutation caught (NFC4 timing)',
    async () => {
      const features = await fixtureFeatures(gatedDir, [
        [GATED, 'tests'],
        [GATED, 'coverage'],
        [GATED, 'lint'],
        [GATED, 'ci'],
      ]);
      const startedAt = Date.now();
      const execution = await executeProbeMatrix({ repoPath: repoOf('probe-fixture-gated'), features });
      const durationMs = Date.now() - startedAt;
      // NFC4: the full matrix over probe-fixture-gated at default parallelism
      // must stay under 5 minutes — the matrix-cost guard.
      console.log(`NFC4 full-matrix duration over probe-fixture-gated: ${durationMs}ms (limit 300000ms)`);
      expect(durationMs).toBeLessThan(300_000);

      // 6 runs (1 baseline + 5 mutations). Attribution positive case is embedded:
      // e.g. deleting-tests-reddens-gate legitimately reddens the coverage and ci
      // controls — both listed in expectedImpact — so its run STAYS TRUSTED and
      // the verdict is `caught`, not `broken`.
      expect(execution.runs).toHaveLength(6);
      const expectVerdict = (feature: string, probe: string, verdict: string) =>
        expect(
          `${feature}/${probe}: ${execution.verdicts.get(probeKey({ template: GATED, name: feature }, probe))}`,
        ).toBe(`${feature}/${probe}: ${verdict}`);
      expectVerdict('tests', 'baseline-test-gate-green', 'proven');
      expectVerdict('tests', 'deleting-tests-reddens-gate', 'caught');
      expectVerdict('tests', 'failing-test-reddens-gate', 'caught');
      expectVerdict('coverage', 'baseline-coverage-gate-green', 'proven');
      expectVerdict('coverage', 'edited-ledger-reddens-gate', 'caught');
      expectVerdict('lint', 'baseline-lint-gate-green', 'proven');
      expectVerdict('lint', 'lint-error-reddens-gate', 'caught');
      expectVerdict('ci', 'baseline-ci-green', 'proven');
      expectVerdict('ci', 'gate-failure-reddens-ci', 'caught');
    },
    T,
  );

  test(
    'scenario 2 — false-green fixture: the same probes yield `missed`, naming feature + probe',
    async () => {
      const features = await fixtureFeatures(gatedDir, [[GATED, 'tests']]);
      const execution = await executeProbeMatrix({
        repoPath: repoOf('probe-fixture-falsegreen-zero-test'),
        features,
      });
      // The report names the miss precisely: feature `tests`, probe
      // `deleting-tests-reddens-gate` (a zero-test pass is this fixture's false green).
      expect(execution.verdicts.get(probeKey({ template: GATED, name: 'tests' }, 'deleting-tests-reddens-gate'))).toBe(
        'missed',
      );
      expect(execution.verdicts.get(probeKey({ template: GATED, name: 'tests' }, 'baseline-test-gate-green'))).toBe(
        'proven',
      );
      // A genuinely failing test IS still caught — the fixture's gate runs real tests.
      expect(execution.verdicts.get(probeKey({ template: GATED, name: 'tests' }, 'failing-test-reddens-gate'))).toBe(
        'caught',
      );
    },
    T,
  );

  test(
    "scenario 3 — mode-3 pair: the parent's probes catch on the parent, miss on the broken child",
    async () => {
      const features = (): Promise<ResolvedFeatureProbes[]> =>
        fixtureFeatures(parentDir, [
          [PARENT, 'tests'],
          [PARENT, 'ci'],
        ]);

      const healthy = await executeProbeMatrix({
        repoPath: repoOf('probe-fixture-parent'),
        features: await features(),
      });
      expect(healthy.verdicts.get(probeKey({ template: PARENT, name: 'tests' }, 'failing-test-reddens-gate'))).toBe(
        'caught',
      );

      const broken = await executeProbeMatrix({
        repoPath: repoOf('probe-fixture-child-broken'),
        features: await features(),
      });
      // The child's LWW overwrite swallows the test exit code: the same probe that
      // caught on the parent now misses.
      expect(broken.verdicts.get(probeKey({ template: PARENT, name: 'tests' }, 'failing-test-reddens-gate'))).toBe(
        'missed',
      );
      // The zero-count check survived the overwrite, so deleting the suite is still caught.
      expect(broken.verdicts.get(probeKey({ template: PARENT, name: 'tests' }, 'deleting-tests-reddens-gate'))).toBe(
        'caught',
      );
    },
    T,
  );

  test(
    'scenario 4 — should keep a red control independently broken without replacing a caught mutation',
    async () => {
      // Same sabotage as the fixture's deleting-tests mutation, but with the
      // attribution carrier stripped: the red coverage control is independently
      // attributed as broken, but it cannot overwrite the mutation child.
      const testsFeature = await customFeature(
        GATED,
        'tests',
        `[{
          name: 'deleting-tests-without-attribution',
          description: 'Deletes the test suite but declares no expected impact.',
          kind: 'mutation',
          run: async (repo) => {
            await repo.remove('tests');
            const result = await repo.exec('bash scripts/test-gate.sh');
            if (result.exitCode === 0) {
              throw new Error('test gate stayed green after the test suite was deleted');
            }
          },
        }]`,
      );
      const [coverageControl] = await fixtureFeatures(gatedDir, [[GATED, 'coverage']]);
      const features = [testsFeature, coverageControl!];
      const execution = await executeProbeMatrix({ repoPath: repoOf('probe-fixture-gated'), features });
      expect(
        execution.verdicts.get(probeKey({ template: GATED, name: 'tests' }, 'deleting-tests-without-attribution')),
      ).toBe('caught');
      expect(
        execution.events.find(
          event =>
            event.probe === 'baseline-coverage-gate-green' &&
            event.attribution?.mutation.probe === 'deleting-tests-without-attribution',
        ),
      ).toMatchObject({
        role: 'control',
        verdict: 'broken',
        attribution: { kind: 'unexpected-control' },
      });
    },
    T,
  );

  test(
    'scenario 5 — should attribute a failing baseline without replacing a passing sibling',
    async () => {
      const phantom = await customFeature(
        GATED,
        'phantom',
        `[{
          name: 'baseline-gate-red',
          description: 'A baseline whose gate is genuinely red on the healthy repo.',
          kind: 'baseline',
          run: async (repo) => {
            const result = await repo.exec('bash scripts/no-such-gate.sh');
            if (result.exitCode !== 0) {
              throw new Error('gate failed: ' + result.stderr);
            }
          },
        }]`,
      );
      const [lintControl] = await fixtureFeatures(gatedDir, [[GATED, 'lint']]);
      const features = [phantom, lintControl!];
      const execution = await executeProbeMatrix({ repoPath: repoOf('probe-fixture-gated'), features });
      expect(execution.verdicts.get(probeKey({ template: GATED, name: 'phantom' }, 'baseline-gate-red'))).toBe(
        'broken',
      );
      // The healthy lint baseline remains independently proven.
      expect(execution.verdicts.get(probeKey({ template: GATED, name: 'lint' }, 'baseline-lint-gate-green'))).toBe(
        'proven',
      );
      expect(execution.events.find(event => event.probe === 'baseline-gate-red')).toMatchObject({
        role: 'baseline',
        outcome: 'author-failed',
        verdict: 'broken',
        exitCode: 12,
      });
    },
    T,
  );

  test(
    'scenario 4b — expectedImpact does NOT attribute a same-named control from a DIFFERENT template',
    async () => {
      // Feature identity is (source template, name). A mutation in template A that
      // declares expectedImpact ['coverage'] must NOT excuse a red `coverage`
      // control that belongs to template B — that same-name feature is a DIFFERENT
      // feature. The cross-template collapse would wrongly report `caught`; the fix
      // keeps the control independently attributable without replacing the mutation.
      const OTHER = 'cyanprint/some-other-template';
      const crossTemplate = await customFeature(
        GATED,
        'tests',
        `[{
          name: 'deleting-tests-attributes-only-own-template',
          description: 'Deletes the test suite, declaring impact on a coverage feature.',
          kind: 'mutation',
          expectedImpact: ['coverage'],
          run: async (repo) => {
            await repo.remove('tests');
            const result = await repo.exec('bash scripts/test-gate.sh');
            if (result.exitCode === 0) {
              throw new Error('test gate stayed green after the test suite was deleted');
            }
          },
        }]`,
      );
      // The red control's coverage feature is declared by a DIFFERENT template than
      // the mutation, so expectedImpact ['coverage'] (template A's) must not match it.
      const [otherCoverage] = await fixtureFeatures(gatedDir, [[OTHER, 'coverage']]);
      const features = [crossTemplate, otherCoverage!];
      const execution = await executeProbeMatrix({ repoPath: repoOf('probe-fixture-gated'), features });
      expect(
        execution.verdicts.get(
          probeKey({ template: GATED, name: 'tests' }, 'deleting-tests-attributes-only-own-template'),
        ),
      ).toBe('caught');
      expect(
        execution.events.find(
          event =>
            event.feature === `${OTHER}#coverage` &&
            event.attribution?.mutation.probe === 'deleting-tests-attributes-only-own-template',
        ),
      ).toMatchObject({ verdict: 'broken', attribution: { kind: 'unexpected-control' } });
    },
    T,
  );

  test(
    'scenario 4c — a control that fails for a NON-author reason is never attributed, even when in expectedImpact',
    async () => {
      // Regression: expectedImpact must attribute ONLY a legitimate
      // author-level red gate. A control that failed for an infrastructure/validity
      // reason — `op-failed`, `engine-failed`, `inapplicable`, `timeout` — proves
      // nothing about legitimate overlap and remains an unexpected child, EVEN when
      // its feature is listed in expectedImpact. Here the coverage control fails with
      // `op-failed` (a sandbox read of a nonexistent path throws ProbeRepoOpError);
      // with expectedImpact ['coverage'] it still remains an unexpected broken
      // child, but it cannot replace the mutation's direct verdict.
      const testsFeature = await customFeature(
        GATED,
        'tests',
        `[{
          name: 'deleting-tests-with-coverage-impact',
          description: 'Deletes the test suite and declares coverage impact.',
          kind: 'mutation',
          expectedImpact: ['coverage'],
          run: async (repo) => {
            await repo.remove('tests');
            const result = await repo.exec('bash scripts/test-gate.sh');
            if (result.exitCode === 0) {
              throw new Error('test gate stayed green after the test suite was deleted');
            }
          },
        }]`,
      );
      // The coverage control's baseline fails with op-failed (nonexistent read),
      // NOT an author red — its feature is nonetheless in the mutation's expectedImpact.
      const coverageOpFailed = await customFeature(
        GATED,
        'coverage',
        `[{
          name: 'baseline-op-failed',
          description: 'Baseline whose sandbox op fails (op-failed, not an author red).',
          kind: 'baseline',
          run: async (repo) => {
            await repo.read('this-file-does-not-exist-in-the-sandbox.txt');
          },
        }, {
          name: 'coverage-gate-marker',
          description: 'Keeps this gate-like feature eligible as a mutation control source.',
          kind: 'mutation',
          run: async () => {},
        }]`,
      );
      const features = [testsFeature, coverageOpFailed];
      const execution = await executeProbeMatrix({ repoPath: repoOf('probe-fixture-gated'), features });
      expect(
        execution.verdicts.get(probeKey({ template: GATED, name: 'tests' }, 'deleting-tests-with-coverage-impact')),
      ).toBe('caught');
      expect(
        execution.events.find(
          event =>
            event.probe === 'baseline-op-failed' &&
            event.attribution?.mutation.probe === 'deleting-tests-with-coverage-impact',
        ),
      ).toMatchObject({
        outcome: 'op-failed',
        verdict: 'broken',
        attribution: { kind: 'unexpected-control' },
      });
    },
    T,
  );

  test(
    'scenario 6 — an inapplicable mutation is `invalid` (asserts nothing)',
    async () => {
      const inapplicable = await customFeature(
        GATED,
        'tests',
        `[{
          name: 'patch-missing-target',
          description: 'Sabotage target does not exist in this repo.',
          kind: 'mutation',
          run: async (repo) => {
            await repo.patch('src/calc.js', { find: 'THIS TEXT DOES NOT EXIST ANYWHERE', replace: 'x' });
          },
        }]`,
      );
      const execution = await executeProbeMatrix({ repoPath: repoOf('probe-fixture-gated'), features: [inapplicable] });
      expect(execution.verdicts.get(probeKey({ template: GATED, name: 'tests' }, 'patch-missing-target'))).toBe(
        'invalid',
      );
    },
    T,
  );
});
