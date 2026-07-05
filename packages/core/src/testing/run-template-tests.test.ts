import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProbeRunReport } from '@cyanprint/contracts';
import YAML from 'yaml';
import { writeProbeManifest } from '../probe/manifest';
import { STATE_FILE } from '../state/generated-state';
import { readText, writeText } from '../util';
import { coverageByProofFailure, runTemplateTest } from './run-template-tests';

// FR8 — the opt-in test-flow probe tier: coverage-by-proof enforcement (every
// declared feature proven by ≥1 probing case), the manifest drift gate firing
// inside a `probe: true` case, missed verdicts failing the case, and full
// additivity for probe-free templates.

const T = 240_000;

let workRoot: string;
let templatesRoot: string;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-probe-tier-test-'));
  templatesRoot = join(workRoot, 'examples/templates');
  await mkdir(templatesRoot, { recursive: true });
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function baselineProbe(name: string): string {
  return (
    `const definition = { contractVersion: 1, probes: [` +
    `{ name: ${JSON.stringify(name)}, description: 'Trivial baseline for the tier tests.', kind: 'baseline', run: () => {} }` +
    `] };\nexport default definition;\n`
  );
}

/**
 * A probe that ACTUALLY proves its feature: a passing baseline (→ `proven`)
 * plus a mutation whose `run()` completes (→ `caught` — executor.ts
 * `mutationVerdict`: a mutation that returns without throwing means the sabotage
 * reddened the gate). This is the ONLY shape that satisfies coverage-by-proof —
 * a baseline alone does not (it never exercises drift detection).
 */
function caughtMutationProbe(name: string): string {
  return (
    `const definition = { contractVersion: 1, probes: [` +
    `{ name: '${name}-baseline', description: 'Trivial baseline for the tier tests.', kind: 'baseline', run: () => {} },` +
    `{ name: ${JSON.stringify(name)}, description: 'A sabotage the gate catches.', kind: 'mutation', run: () => {} }` +
    `] };\nexport default definition;\n`
  );
}

function missingMutationProbe(name: string): string {
  return (
    `const definition = { contractVersion: 1, probes: [` +
    `{ name: '${name}-baseline', description: 'Trivial baseline for the tier tests.', kind: 'baseline', run: () => {} },` +
    `{ name: ${JSON.stringify(name)}, description: 'A sabotage the gate never notices (always misses).', kind: 'mutation', ` +
    `run: () => { throw new Error('gate stayed green'); } }` +
    `] };\nexport default definition;\n`
  );
}

/**
 * A probe with a mutation but NO baseline whose sabotage can never apply — the
 * patch targets a file the generation never produced, so `repo.patch` fails the
 * sandbox op and the mutation resolves to `invalid`. The run therefore PASSES
 * (invalid is not missed/broken) yet proves nothing — the exact shape that must
 * not satisfy coverage-by-proof.
 */
function invalidOnlyMutationProbe(name: string): string {
  return (
    `const definition = { contractVersion: 1, probes: [` +
    `{ name: ${JSON.stringify(name)}, description: 'A sabotage that can never be applied (always invalid).', kind: 'mutation', ` +
    `run: async (repo) => { await repo.patch('never-generated.txt', { find: 'absent', replace: 'x' }); } }` +
    `] };\nexport default definition;\n`
  );
}

async function writeSynthetic(
  name: string,
  spec: { features: string[]; probes?: Record<string, string>; cases: Array<Record<string, unknown>> },
): Promise<string> {
  const dir = join(templatesRoot, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'expected'), { recursive: true });
  await writeFile(
    join(dir, 'cyan.yaml'),
    YAML.stringify({ cyanprint: 4, kind: 'template', owner: 'cyanprint', name, bundledEntry: 'cyan.ts' }),
    'utf8',
  );
  await writeFile(
    join(dir, 'cyan.ts'),
    `export default function cyan() {\n  return { features: ${JSON.stringify(spec.features)} };\n}\n`,
    'utf8',
  );
  await writeCases(dir, spec.cases);
  for (const [feature, source] of Object.entries(spec.probes ?? {})) {
    await writeText(join(dir, `probes/${feature}.ts`), source);
  }
  return dir;
}

async function writeCases(dir: string, cases: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(join(dir, 'cyan.test.yaml'), YAML.stringify({ cases }), 'utf8');
}

describe('test-flow probe tier (FR8)', () => {
  test(
    'coverage-by-proof: a declared feature no probing case proves fails the run; adding one clears it',
    async () => {
      // Arrange
      const dir = await writeSynthetic('synth-coverage', {
        features: ['gate'],
        probes: { gate: caughtMutationProbe('gate-sabotage-caught') },
        cases: [{ name: 'basic', expected: 'expected' }],
      });
      await writeProbeManifest(dir);

      // Act
      // No probing case → the declared feature is an unproven promise → fail.
      const unproven = await runTemplateTest({ template: dir, outDir: join(workRoot, 'out-coverage-unproven') });
      // Assert
      expect(unproven).toMatchObject({ passed: 1, failed: 1 });
      const coverage = unproven.cases.find(entry => entry.name === 'coverage-by-proof');
      expect(coverage?.status).toBe('failed');
      expect(coverage?.message).toContain('cyanprint/synth-coverage#gate');
      expect(coverage?.message).toContain('caught');

      // Arrange
      // A probing case whose generation declares the feature — and whose probe
      // set produces both a proven baseline AND a caught mutation — clears it.
      await writeCases(dir, [
        { name: 'basic', expected: 'expected' },
        { name: 'probing', expected: 'expected', probe: true },
      ]);
      // Act
      const proven = await runTemplateTest({ template: dir, outDir: join(workRoot, 'out-coverage-proven') });
      // Assert
      expect(proven).toMatchObject({ passed: 2, failed: 0 });
      const probing = proven.cases.find(entry => entry.name === 'probing');
      expect(probing?.probes).toMatchObject({ proven: 1, caught: 1, missed: 0, invalid: 0, broken: 0 });
    },
    T,
  );

  test(
    'coverage-by-proof: a baseline-only probe (no mutation) does NOT satisfy coverage — the drift-detection path is never exercised',
    async () => {
      // Arrange
      // Regression — baseline-only coverage hole: a feature whose only probe is a
      // passing baseline produces `proven` but never `caught`. The baseline
      // proves the healthy gate is green, but nothing proves the gate reddens
      // on drift — so the false-green mode the probe tier exists to catch is
      // itself untested. Coverage must still FAIL.
      const dir = await writeSynthetic('synth-baseline-only', {
        features: ['gate'],
        probes: { gate: baselineProbe('gate-baseline-green') },
        cases: [{ name: 'probing', expected: 'expected', probe: true }],
      });
      await writeProbeManifest(dir);

      // Act
      const report = await runTemplateTest({ template: dir, outDir: join(workRoot, 'out-baseline-only') });
      // Assert
      // The probing case itself PASSES — a lone `proven` baseline is not a
      // missed/broken failure...
      const probing = report.cases.find(entry => entry.name === 'probing');
      expect(probing?.status).toBe('passed');
      expect(probing?.probes).toMatchObject({ proven: 1, caught: 0, missed: 0, invalid: 0, broken: 0 });
      // ...but coverage-by-proof FAILS: no `caught` mutation, so nothing proved
      // the gate detects drift.
      const coverage = report.cases.find(entry => entry.name === 'coverage-by-proof');
      expect(coverage?.status).toBe('failed');
      expect(coverage?.message).toContain('cyanprint/synth-baseline-only#gate');
      expect(report.failed).toBeGreaterThanOrEqual(1);
    },
    T,
  );

  test(
    'coverage-by-proof: a passing probing case that only ever produces `invalid` verdicts does NOT satisfy coverage',
    async () => {
      // Arrange
      const dir = await writeSynthetic('synth-coverage-invalid', {
        features: ['gate'],
        probes: { gate: invalidOnlyMutationProbe('sabotage-never-applies') },
        cases: [{ name: 'probing', expected: 'expected', probe: true }],
      });
      await writeProbeManifest(dir);

      // Act
      const report = await runTemplateTest({ template: dir, outDir: join(workRoot, 'out-coverage-invalid') });
      // Assert
      // The probing case itself PASSES — an `invalid` verdict is not a missed/broken failure...
      const probing = report.cases.find(entry => entry.name === 'probing');
      expect(probing?.status).toBe('passed');
      expect(probing?.probes).toMatchObject({ proven: 0, caught: 0, missed: 0, invalid: 1, broken: 0 });
      // ...but coverage-by-proof still FAILS: no `proven` baseline for the declared feature,
      // so the case proved nothing. A passing case is not enough.
      const coverage = report.cases.find(entry => entry.name === 'coverage-by-proof');
      expect(coverage?.status).toBe('failed');
      expect(coverage?.message).toContain('cyanprint/synth-coverage-invalid#gate');
      expect(coverage?.message).toContain('invalid');
      expect(report.failed).toBeGreaterThanOrEqual(1);
    },
    T,
  );

  test(
    'manifest drift gate: a probing case fails on a hand-drifted probes.yaml and recovers after regeneration',
    async () => {
      // Arrange
      const dir = await writeSynthetic('synth-drift', {
        features: ['gate'],
        probes: { gate: caughtMutationProbe('gate-sabotage-caught') },
        cases: [{ name: 'probing', expected: 'expected', probe: true }],
      });
      await writeProbeManifest(dir);
      const committed = await readText(join(dir, 'probes.yaml'));
      await writeText(join(dir, 'probes.yaml'), `${committed}# drifted\n`);

      // Act
      const drifted = await runTemplateTest({ template: dir, outDir: join(workRoot, 'out-drift') });
      // Assert
      expect(drifted).toMatchObject({ passed: 0 });
      const driftedCase = drifted.cases.find(entry => entry.name === 'probing');
      expect(driftedCase?.status).toBe('failed');
      expect(driftedCase?.message).toContain('drifted');

      // Arrange
      await writeText(join(dir, 'probes.yaml'), committed);
      // Act
      const clean = await runTemplateTest({ template: dir, outDir: join(workRoot, 'out-drift-clean') });
      // Assert
      expect(clean).toMatchObject({ passed: 1, failed: 0 });
    },
    T,
  );

  test(
    'a missed mutation fails the probing case with the offending probe named',
    async () => {
      // Arrange
      const dir = await writeSynthetic('synth-missed', {
        features: ['gate'],
        probes: { gate: missingMutationProbe('sabotage-goes-unnoticed') },
        cases: [{ name: 'probing', expected: 'expected', probe: true }],
      });
      await writeProbeManifest(dir);

      // Act
      const report = await runTemplateTest({ template: dir, outDir: join(workRoot, 'out-missed') });
      // Assert
      const probing = report.cases.find(entry => entry.name === 'probing');
      expect(probing?.status).toBe('failed');
      expect(probing?.message).toContain('cyanprint/synth-missed#gate/sabotage-goes-unnoticed=missed');
      expect(probing?.probes).toMatchObject({ proven: 1, missed: 1 });
    },
    T,
  );

  test(
    'coverage-by-proof: a proven+caught probe set satisfies coverage but a lone caught (no proven baseline) does not',
    async () => {
      // Arrange
      // The `caught` requirement is ANDed with `proven`, not a replacement: a
      // feature must show BOTH. This keeps the all-`invalid` guarantee
      // (an invalid run has neither) while closing the baseline-only hole.
      const dir = await writeSynthetic('synth-coverage-both', {
        features: ['gate'],
        probes: { gate: caughtMutationProbe('gate-sabotage-caught') },
        cases: [{ name: 'probing', expected: 'expected', probe: true }],
      });
      await writeProbeManifest(dir);

      // Act
      const report = await runTemplateTest({ template: dir, outDir: join(workRoot, 'out-coverage-both') });
      // Assert
      expect(report).toMatchObject({ passed: 1, failed: 0 });
      const probing = report.cases.find(entry => entry.name === 'probing');
      expect(probing?.probes).toMatchObject({ proven: 1, caught: 1 });
      expect(report.cases.some(entry => entry.name === 'coverage-by-proof')).toBe(false);
    },
    T,
  );

  test(
    'additivity (FR3/FR8): a probe-free template passes unchanged, omits the empty features union from state, and probe: true is a no-op',
    async () => {
      // Arrange
      const dir = await writeSynthetic('synth-plain', {
        features: [],
        cases: [{ name: 'basic', expected: 'expected' }],
      });
      const outDir = join(workRoot, 'out-plain');
      // Act
      const report = await runTemplateTest({ template: dir, outDir });
      // Assert
      expect(report).toMatchObject({ passed: 1, failed: 0 });
      expect(report.cases.some(entry => entry.name === 'coverage-by-proof')).toBe(false);
      expect(report.cases[0]?.probes).toBeUndefined();
      // A zero-feature generation OMITS the `features` key entirely (spec.md:103–107),
      // so the state file is byte-identical to a pre-feature (legacy) repo — additivity
      // holds for every reader of the state file, not just the test byte compare (which
      // excludes .cyan_state.yaml). Declaration-mode `cyanprint probe` still treats such
      // a repo as "nothing to probe": `declaredFeatureSetForRepo()` returns `[]` directly
      // for a modern repo whose probed install declared zero features, so it is never
      // probed against the template's profile union.
      const plainState = YAML.parse(await readText(join(outDir, STATE_FILE))) as { features?: unknown };
      expect(plainState.features).toBeUndefined();

      // Arrange
      // probe: true on a feature-less template is a no-op green (nothing to gate or prove).
      await writeCases(dir, [{ name: 'probing', expected: 'expected', probe: true }]);
      // Act
      const probed = await runTemplateTest({ template: dir, outDir: join(workRoot, 'out-plain-probed') });
      // Assert
      expect(probed).toMatchObject({ passed: 1, failed: 0 });
    },
    T,
  );
});

// Focused regression for the coverage-by-proof identity keying.
// Driving two colliding identities through real generation would need
// a `#` in a template/owner name AND composition; the keying decision is pure,
// so assert it directly against the exported reducer.
describe('coverage-by-proof identity keying', () => {
  function provenReport(template: string, name: string): ProbeRunReport {
    return {
      contractVersion: 1,
      features: [
        {
          template,
          name,
          probes: [
            {
              name: 'baseline',
              description: 'baseline',
              kind: 'baseline',
              origin: { kind: 'local' },
              verdict: 'proven',
            },
            {
              name: 'mutation',
              description: 'mutation',
              kind: 'mutation',
              origin: { kind: 'local' },
              verdict: 'caught',
            },
          ],
        },
      ],
    };
  }

  test('distinct identities that collide under a `#` join do not cross-satisfy coverage', () => {
    // Arrange
    // Both identities collapse to `acme/base#gate#linux` under the old
    // `${template}#${name}` join, yet are genuinely distinct. Feature B is
    // proven; feature A is declared but never probed. Under the old keying, B's
    // proof would have marked A's colliding key proven — a false green.
    const provenB = provenReport('acme/base#gate', 'linux');
    // Act
    const failure = coverageByProofFailure([
      {
        probe: true,
        features: [{ template: 'acme/base#gate', name: 'linux' }],
        case: {
          name: 'proves-b',
          status: 'passed',
          probes: { proven: 1, caught: 1, missed: 0, invalid: 0, broken: 0, report: provenB },
        },
      },
      {
        probe: false,
        features: [{ template: 'acme/base', name: 'gate#linux' }],
        case: { name: 'declares-a', status: 'passed' },
      },
    ]);
    // Assert
    // Feature A stays unproven — coverage FAILS (old keying returned undefined).
    expect(failure?.status).toBe('failed');
    expect(failure?.message).toContain('acme/base#gate#linux');
  });

  test('a feature proven under its own identity clears coverage (no false failure)', () => {
    // Arrange
    const provenA = provenReport('acme/base', 'gate#linux');
    // Act
    const failure = coverageByProofFailure([
      {
        probe: true,
        features: [{ template: 'acme/base', name: 'gate#linux' }],
        case: {
          name: 'proves-a',
          status: 'passed',
          probes: { proven: 1, caught: 1, missed: 0, invalid: 0, broken: 0, report: provenA },
        },
      },
    ]);
    // Assert
    expect(failure).toBeUndefined();
  });
});
