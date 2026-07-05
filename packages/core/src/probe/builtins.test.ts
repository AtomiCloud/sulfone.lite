import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ProbeRunReport } from '@cyanprint/contracts';
import { createProject } from '../create/create-project';
import { resolveProbesForTemplate } from './resolve';
import { runProbeMatrix } from './run-probes';

// AC10 — the probe-less `probe-fixture-builtins` fixture: every declared feature
// resolves to the built-in library, and the built-ins render correct verdicts
// against the REAL generated repo (healthy → proven/caught; neutered → missed).

const T = 300_000;
const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../examples/templates/probe-fixture-builtins',
);
const BUILTINS = 'cyanprint/probe-fixture-builtins';
const FEATURES = ['tests', 'coverage', 'lint', 'ci'].map(name => ({ template: BUILTINS, name }));

let workRoot: string;
let healthyRepo: string;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-builtins-test-'));
  healthyRepo = join(workRoot, 'healthy');
  const result = await createProject({ template: fixtureDir, outDir: healthyRepo, headless: true });
  if (result.status !== 'done') {
    throw new Error('generation of probe-fixture-builtins did not complete');
  }
}, T);

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function verdictOf(report: ProbeRunReport, feature: string, probe: string): string {
  const entry = report.features
    .find(candidate => candidate.name === feature)
    ?.probes.find(candidate => candidate.name === probe);
  return `${feature}/${probe}: ${entry?.verdict}`;
}

describe('built-in probe library (AC10)', () => {
  test('every declared feature resolves to the built-in tier (origin `built-in`)', async () => {
    const resolved = await resolveProbesForTemplate({ templateDir: fixtureDir, features: FEATURES });
    expect(resolved).toHaveLength(4);
    for (const feature of resolved) {
      expect(feature.probes.length).toBeGreaterThanOrEqual(2);
      for (const probe of feature.probes) {
        expect(probe.origin).toEqual({ kind: 'built-in' });
      }
    }
  });

  test(
    'healthy repo: built-ins prove every baseline and catch every sabotage',
    async () => {
      const report = await runProbeMatrix({
        repoPath: healthyRepo,
        probeSources: { mode: 'declaration', templateDir: fixtureDir },
        features: FEATURES,
      });
      expect(verdictOf(report, 'tests', 'builtin-tests-baseline-green')).toContain('proven');
      expect(verdictOf(report, 'tests', 'builtin-deleting-tests-reddens-gate')).toContain('caught');
      expect(verdictOf(report, 'coverage', 'builtin-coverage-baseline-green')).toContain('proven');
      expect(verdictOf(report, 'coverage', 'builtin-corrupting-coverage-ledger-reddens-gate')).toContain('caught');
      expect(verdictOf(report, 'lint', 'builtin-lint-baseline-green')).toContain('proven');
      expect(verdictOf(report, 'lint', 'builtin-lint-error-reddens-gate')).toContain('caught');
      expect(verdictOf(report, 'ci', 'builtin-ci-baseline-green')).toContain('proven');
      expect(verdictOf(report, 'ci', 'builtin-ci-wiring-invokes-gates')).toContain('proven');
      expect(verdictOf(report, 'ci', 'builtin-gate-failure-reddens-ci')).toContain('caught');
    },
    T,
  );

  test(
    'neutered repo: with every gate stubbed to exit 0, the same built-ins report `missed`',
    async () => {
      const neutered = join(workRoot, 'neutered');
      await cp(healthyRepo, neutered, { recursive: true });
      for (const gate of ['tests', 'coverage', 'lint', 'ci']) {
        await writeFile(join(neutered, `scripts/${gate}.sh`), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      }
      const report = await runProbeMatrix({
        repoPath: neutered,
        probeSources: { mode: 'declaration', templateDir: fixtureDir },
        features: FEATURES,
      });
      expect(verdictOf(report, 'tests', 'builtin-deleting-tests-reddens-gate')).toContain('missed');
      expect(verdictOf(report, 'coverage', 'builtin-corrupting-coverage-ledger-reddens-gate')).toContain('missed');
      expect(verdictOf(report, 'lint', 'builtin-lint-error-reddens-gate')).toContain('missed');
      expect(verdictOf(report, 'ci', 'builtin-gate-failure-reddens-ci')).toContain('missed');
    },
    T,
  );

  test(
    'the package.json-scripts gate convention also resolves',
    async () => {
      const scriptedRepo = join(workRoot, 'package-scripts');
      await cp(healthyRepo, scriptedRepo, { recursive: true });
      // Move the tests gate behind a package.json script (no scripts/tests.sh).
      await rm(join(scriptedRepo, 'scripts/tests.sh'));
      await writeFile(
        join(scriptedRepo, 'package.json'),
        `${JSON.stringify({ name: 'probe-builtins-scripted', scripts: { tests: 'bun test tests' } }, null, 2)}\n`,
        'utf8',
      );
      const report = await runProbeMatrix({
        repoPath: scriptedRepo,
        probeSources: { mode: 'declaration', templateDir: fixtureDir },
        features: [{ template: BUILTINS, name: 'tests' }],
      });
      expect(verdictOf(report, 'tests', 'builtin-tests-baseline-green')).toContain('proven');
      expect(verdictOf(report, 'tests', 'builtin-deleting-tests-reddens-gate')).toContain('caught');
    },
    T,
  );
});
