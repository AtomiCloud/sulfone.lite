import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '@cyanprint/core';

// Proves the probe fixtures are a genuine substrate before any probe engine
// exists: each of the five in-scope false-green modes is applied BY HAND to the
// generated repo, and the same sabotage must turn the gate red on the healthy
// fixture (catch) while leaving it green on the matching false-green variant
// (miss). Every scenario also asserts the gate was green before the sabotage,
// so the sabotage — not fixture rot — is what flips the verdict.

const T = 240_000;

const FIXTURES = [
  'probe-fixture-gated',
  'probe-fixture-parent',
  'probe-fixture-child-broken',
  'probe-fixture-falsegreen-neutered-ci',
  'probe-fixture-falsegreen-vacuous-coverage',
  'probe-fixture-falsegreen-zero-test',
  'probe-fixture-falsegreen-swallowed-exit',
] as const;

type FixtureName = (typeof FIXTURES)[number];

type Sabotage = {
  /** What the sabotage simulates. */
  description: string;
  apply(repoDir: string): Promise<void>;
};

type Scenario = {
  mode: string;
  catchFixture: FixtureName;
  missFixture: FixtureName;
  /** The gate command whose exit code renders the verdict. */
  gate: string;
  sabotage: Sabotage;
};

const scenarios: Scenario[] = [
  {
    mode: 'mode 1 — neutered CI script',
    catchFixture: 'probe-fixture-gated',
    missFixture: 'probe-fixture-falsegreen-neutered-ci',
    gate: 'bash scripts/ci.sh',
    sabotage: {
      description: 'introduce a lint violation that a chained gate must catch',
      apply: async repoDir => {
        await appendFile(join(repoDir, 'src/calc.js'), 'var sneaky = 1;\n', 'utf8');
      },
    },
  },
  {
    mode: 'mode 2 — vacuous coverage ledger',
    catchFixture: 'probe-fixture-gated',
    missFixture: 'probe-fixture-falsegreen-vacuous-coverage',
    gate: 'bash scripts/coverage-gate.sh',
    sabotage: {
      description: 'hand-edit the committed coverage ledger',
      apply: async repoDir => {
        await writeFile(join(repoDir, 'coverage/ledger.txt'), '999\n', 'utf8');
      },
    },
  },
  {
    mode: "mode 3 — child breaks parent's promise",
    catchFixture: 'probe-fixture-parent',
    missFixture: 'probe-fixture-child-broken',
    gate: 'bash scripts/ci.sh',
    sabotage: {
      description: 'break the source so a real test fails',
      apply: breakAddFunction,
    },
  },
  {
    mode: 'mode 4 — zero-test pass',
    catchFixture: 'probe-fixture-gated',
    missFixture: 'probe-fixture-falsegreen-zero-test',
    gate: 'bash scripts/test-gate.sh',
    sabotage: {
      description: 'delete the whole test suite',
      apply: async repoDir => {
        await rm(join(repoDir, 'tests'), { recursive: true, force: true });
      },
    },
  },
  {
    mode: 'mode 5 — swallowed exit code',
    catchFixture: 'probe-fixture-gated',
    missFixture: 'probe-fixture-falsegreen-swallowed-exit',
    gate: 'bash scripts/test-gate.sh',
    sabotage: {
      description: 'break the source so a real test fails',
      apply: breakAddFunction,
    },
  },
];

async function breakAddFunction(repoDir: string): Promise<void> {
  const calcPath = join(repoDir, 'src/calc.js');
  const source = await readFile(calcPath, 'utf8');
  if (!source.includes('return left + right;')) {
    throw new Error('sabotage target not found in src/calc.js');
  }
  await writeFile(calcPath, source.replace('return left + right;', 'return left - right;'), 'utf8');
}

let workRoot: string;
const baseRepos = new Map<FixtureName, string>();
let scenarioCounter = 0;

async function runGate(repoDir: string, gate: string): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(['bash', '-c', gate], { cwd: repoDir, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

/** Fresh sabotage-able copy of a fixture's generated repo. */
async function freshRepo(fixture: FixtureName): Promise<string> {
  const base = baseRepos.get(fixture);
  if (!base) {
    throw new Error(`fixture ${fixture} was not generated`);
  }
  scenarioCounter += 1;
  const copy = join(workRoot, `scenario-${scenarioCounter}`);
  await cp(base, copy, { recursive: true });
  return copy;
}

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-probe-fixtures-'));
  for (const fixture of FIXTURES) {
    const outDir = join(workRoot, `base-${fixture}`);
    const result = await createProject({
      template: join(process.cwd(), 'examples/templates', fixture),
      outDir,
      headless: true,
    });
    if (result.status !== 'done') {
      throw new Error(`generation of ${fixture} did not complete: ${result.status}`);
    }
    baseRepos.set(fixture, outDir);
  }
}, T);

afterAll(async () => {
  if (workRoot) {
    await rm(workRoot, { recursive: true, force: true });
  }
});

describe('probe fixture gates (catch/miss per false-green mode)', () => {
  for (const scenario of scenarios) {
    test(
      `${scenario.mode}: ${scenario.catchFixture} catches (${scenario.sabotage.description})`,
      async () => {
        const repo = await freshRepo(scenario.catchFixture);
        const before = await runGate(repo, scenario.gate);
        expect(before.exitCode).toBe(0);
        await scenario.sabotage.apply(repo);
        const after = await runGate(repo, scenario.gate);
        expect(after.exitCode).not.toBe(0);
      },
      T,
    );

    test(
      `${scenario.mode}: ${scenario.missFixture} misses (${scenario.sabotage.description})`,
      async () => {
        const repo = await freshRepo(scenario.missFixture);
        const before = await runGate(repo, scenario.gate);
        expect(before.exitCode).toBe(0);
        await scenario.sabotage.apply(repo);
        const after = await runGate(repo, scenario.gate);
        expect(after.exitCode).toBe(0);
      },
      T,
    );
  }
});
