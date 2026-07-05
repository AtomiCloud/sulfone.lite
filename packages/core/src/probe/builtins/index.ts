import type { Probe, ProbeDefinition, ProbeRepo } from '@cyanprint/contracts';
import { PROBE_CONTRACT_VERSION, probeInapplicable } from '@cyanprint/contracts';

/**
 * The engine-shipped built-in probe library (FR18): the third resolution tier,
 * serving universally named gate-category features. Every built-in is written
 * against the SAME contract as author probes — `ProbeRepo` in, throw on the
 * wrong outcome, `probeInapplicable` when the repo has no matching substrate —
 * no privileged APIs.
 *
 * Gate discovery convention (v1): a feature named `<name>` is gated by
 * `scripts/<name>.sh` (run via bash) or, failing that, a `package.json` script
 * of the same name (run via `bun run`). A repo exposing neither makes the
 * experiment inapplicable, never a silent pass.
 */
export function builtInProbeDefinition(featureName: string): ProbeDefinition | undefined {
  const definition = BUILT_INS[featureName];
  return definition ? { contractVersion: PROBE_CONTRACT_VERSION, probes: definition } : undefined;
}

async function gateCommand(repo: ProbeRepo, name: string): Promise<string> {
  if ((await repo.glob(`scripts/${name}.sh`)).length > 0) {
    return `bash scripts/${name}.sh`;
  }
  const packageJson = await readPackageScripts(repo);
  if (typeof packageJson?.[name] === 'string') {
    return `bun run ${name}`;
  }
  throw probeInapplicable(`no "${name}" gate found: expected scripts/${name}.sh or a package.json "${name}" script`);
}

async function readPackageScripts(repo: ProbeRepo): Promise<Record<string, unknown> | undefined> {
  if ((await repo.glob('package.json')).length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await repo.read('package.json')) as { scripts?: Record<string, unknown> };
    return parsed.scripts;
  } catch {
    return undefined;
  }
}

function baselineGreen(name: string): Probe {
  return {
    name: `builtin-${name}-baseline-green`,
    description: `The untouched repo passes its ${name} gate.`,
    kind: 'baseline',
    async run(repo) {
      const command = await gateCommand(repo, name);
      const result = await repo.exec(command);
      if (result.exitCode !== 0) {
        throw new Error(`${name} gate failed on the healthy repo: ${result.stderr || result.stdout}`);
      }
    },
  };
}

async function expectGateRed(repo: ProbeRepo, name: string, sabotage: string): Promise<void> {
  const command = await gateCommand(repo, name);
  const result = await repo.exec(command);
  if (result.exitCode === 0) {
    throw new Error(`${name} gate stayed green after ${sabotage}`);
  }
}

const TEST_FILE_GLOBS = ['tests/**', 'test/**', '**/*.test.*', '**/*.spec.*'];

async function findTestFiles(repo: ProbeRepo): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of TEST_FILE_GLOBS) {
    for (const path of await repo.glob(pattern)) {
      if (!path.startsWith('node_modules/') && !path.includes('/node_modules/')) {
        files.add(path);
      }
    }
  }
  return [...files].sort();
}

/** Append a construct common lint setups reject (a `var` binding) to a source file. */
async function sabotageLint(repo: ProbeRepo): Promise<string> {
  const sources = (await repo.glob('src/**/*.{js,jsx,ts,tsx,mjs,cjs}')).filter(path => !path.includes('node_modules/'));
  const target = sources[0];
  if (!target) {
    throw probeInapplicable('no source files under src/ to plant a lint violation in');
  }
  const content = await repo.read(target);
  await repo.write(target, `${content}var cyanprint_probe_lint_violation = 1;\n`);
  return target;
}

const BUILT_INS: Record<string, Probe[]> = {
  tests: [
    baselineGreen('tests'),
    {
      name: 'builtin-deleting-tests-reddens-gate',
      description: 'Emptying the whole test set must turn the tests gate red (zero-test pass is the false green).',
      kind: 'mutation',
      expectedImpact: ['coverage', 'ci'],
      async run(repo) {
        const files = await findTestFiles(repo);
        if (files.length === 0) {
          throw probeInapplicable('no test files found to delete');
        }
        for (const file of files) {
          await repo.remove(file);
        }
        await expectGateRed(repo, 'tests', 'the test set was emptied');
      },
    },
  ],
  coverage: [
    baselineGreen('coverage'),
    {
      name: 'builtin-corrupting-coverage-ledger-reddens-gate',
      description: 'Corrupting the committed coverage ledger must turn the coverage gate red.',
      kind: 'mutation',
      expectedImpact: ['ci'],
      async run(repo) {
        const ledgers = await repo.glob('coverage/**');
        if (ledgers.length === 0) {
          throw probeInapplicable('no committed coverage ledger found under coverage/');
        }
        for (const ledger of ledgers) {
          await repo.write(ledger, '999999\n');
        }
        await expectGateRed(repo, 'coverage', 'the coverage ledger was corrupted');
      },
    },
  ],
  lint: [
    baselineGreen('lint'),
    {
      name: 'builtin-lint-error-reddens-gate',
      description: 'Introducing a forbidden construct in src/ must turn the lint gate red.',
      kind: 'mutation',
      expectedImpact: ['ci'],
      async run(repo) {
        await sabotageLint(repo);
        await expectGateRed(repo, 'lint', 'a lint violation was introduced');
      },
    },
  ],
  ci: [
    baselineGreen('ci'),
    {
      name: 'builtin-ci-wiring-invokes-gates',
      description: 'The CI entrypoint must statically reference at least one other quality gate.',
      kind: 'baseline',
      async run(repo) {
        const source =
          (await repo.glob('scripts/ci.sh')).length > 0
            ? await repo.read('scripts/ci.sh')
            : String((await readPackageScripts(repo))?.ci ?? '');
        if (!source) {
          throw probeInapplicable('no ci gate wiring found to inspect');
        }
        const referenced = ['tests', 'test', 'coverage', 'lint'].some(gate => source.includes(gate));
        if (!referenced) {
          throw new Error('the ci entrypoint references no other quality gate — the chain is vacuous');
        }
      },
    },
    {
      name: 'builtin-gate-failure-reddens-ci',
      description: 'A sabotage a chained gate catches (a lint violation) must turn the ci gate red.',
      kind: 'mutation',
      expectedImpact: ['lint'],
      async run(repo) {
        await sabotageLint(repo);
        await expectGateRed(repo, 'ci', 'a chained gate should have failed');
      },
    },
  ],
};
