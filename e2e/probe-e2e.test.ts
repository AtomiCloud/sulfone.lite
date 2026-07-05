import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The epic's end-to-end success-criteria gate, driven through the REAL CLI:
// the five false-green modes surface `missed` verdicts on the plan-1 fixtures
// through BOTH entry points (`cyanprint probe` and the `probe: true` test
// tier), with verdict parity between them over full matrices, plus selection,
// retention, the manifest drift gate, `--update-manifest`, coverage-by-proof,
// and probe-free additivity.

const T = 240_000;
const ROOT = process.cwd();
const TEMPLATES = join(ROOT, 'examples/templates');
const GATED = join(TEMPLATES, 'probe-fixture-gated');
const PARENT = join(TEMPLATES, 'probe-fixture-parent');
const CHILD_HEALTHY = join(TEMPLATES, 'probe-fixture-child-healthy');

type CliResult = { exitCode: number; stdout: string; stderr: string };

async function cli(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', 'packages/cli/src/main.ts', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

type ProbeReport = {
  features: Array<{ template: string; name: string; probes: Array<{ name: string; kind: string; verdict: string }> }>;
};

type ProbePayload = {
  mode: 'matrix' | 'selection';
  counts: { proven: number; caught: number; missed: number; invalid: number; broken: number };
  report: ProbeReport;
  snapshotPath?: string;
  sandboxes?: Array<{ runIndex: number; sandboxPath: string }>;
};

function verdictOf(report: ProbeReport, template: string, feature: string, probe: string): string | undefined {
  return report.features
    .find(entry => entry.template === template && entry.name === feature)
    ?.probes.find(entry => entry.name === probe)?.verdict;
}

/** Flat, order-independent verdict set for full-matrix parity comparison. */
function verdictSet(report: ProbeReport): string[] {
  return report.features
    .flatMap(feature =>
      feature.probes.map(probe => `${feature.template}#${feature.name}/${probe.name}=${probe.verdict}`),
    )
    .sort();
}

let workRoot: string;
const repos = new Map<string, string>();

async function materialize(fixture: string): Promise<string> {
  const outDir = join(workRoot, `repo-${fixture}`);
  const created = await cli(['create', join(TEMPLATES, fixture), '--out', outDir, '--headless', '--json']);
  if (created.exitCode !== 0) {
    throw new Error(`create ${fixture} failed: ${created.stderr}`);
  }
  repos.set(fixture, outDir);
  return outDir;
}

function repoOf(fixture: string): string {
  const dir = repos.get(fixture);
  if (!dir) {
    throw new Error(`fixture ${fixture} was not materialized`);
  }
  return dir;
}

async function featuresFile(
  name: string,
  features: Array<string | { template: string; name: string }>,
): Promise<string> {
  const path = join(workRoot, `${name}.json`);
  await Bun.write(path, JSON.stringify(features));
  return path;
}

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-probe-e2e-'));
  for (const fixture of [
    'probe-fixture-gated',
    'probe-fixture-falsegreen-neutered-ci',
    'probe-fixture-falsegreen-vacuous-coverage',
    'probe-fixture-falsegreen-zero-test',
    'probe-fixture-falsegreen-swallowed-exit',
    'probe-fixture-child-healthy',
    'probe-fixture-child-broken',
  ]) {
    await materialize(fixture);
  }
}, T);

afterAll(async () => {
  if (workRoot) {
    await rm(workRoot, { recursive: true, force: true });
  }
});

describe('cyanprint probe — healthy full matrix (AC1)', () => {
  test(
    'the healthy fixture proves every baseline and catches every sabotage, exit 0',
    async () => {
      // Arrange
      const features = await featuresFile('feat-all', ['tests', 'coverage', 'lint', 'ci']);
      // Act
      const run = await cli([
        'probe',
        repoOf('probe-fixture-gated'),
        '--probes',
        GATED,
        '--features',
        features,
        '--json',
      ]);
      // Assert
      expect(run.exitCode).toBe(0);
      const payload = JSON.parse(run.stdout) as ProbePayload;
      expect(payload.mode).toBe('matrix');
      expect(payload.counts).toEqual({ proven: 4, caught: 5, missed: 0, invalid: 0, broken: 0 });
    },
    T,
  );
});

describe('the five false-green modes surface `missed` (AC1)', () => {
  const gatedRef = 'cyanprint/probe-fixture-gated';
  const modes: Array<{
    mode: string;
    fixture: string;
    probes: string;
    features: Array<string | { template: string; name: string }>;
    template: string;
    feature: string;
    probe: string;
  }> = [
    {
      mode: 'mode 1 — neutered CI script',
      fixture: 'probe-fixture-falsegreen-neutered-ci',
      probes: GATED,
      features: ['ci'],
      template: gatedRef,
      feature: 'ci',
      probe: 'gate-failure-reddens-ci',
    },
    {
      mode: 'mode 2 — vacuous coverage ledger',
      fixture: 'probe-fixture-falsegreen-vacuous-coverage',
      probes: GATED,
      features: ['coverage'],
      template: gatedRef,
      feature: 'coverage',
      probe: 'edited-ledger-reddens-gate',
    },
    {
      // Composition, broken side (FR3): the child's LWW overwrite neutered the
      // parent's gate — the PARENT's probes prove the parent's promise against
      // the combined repo and catch the miss.
      mode: "mode 3 — child breaks parent's promise",
      fixture: 'probe-fixture-child-broken',
      probes: PARENT,
      features: [{ template: 'cyanprint/probe-fixture-parent', name: 'tests' }],
      template: 'cyanprint/probe-fixture-parent',
      feature: 'tests',
      probe: 'failing-test-reddens-gate',
    },
    {
      mode: 'mode 4 — zero-test pass',
      fixture: 'probe-fixture-falsegreen-zero-test',
      probes: GATED,
      features: ['tests'],
      template: gatedRef,
      feature: 'tests',
      probe: 'deleting-tests-reddens-gate',
    },
    {
      mode: 'mode 5 — swallowed exit code',
      fixture: 'probe-fixture-falsegreen-swallowed-exit',
      probes: GATED,
      features: ['tests'],
      template: gatedRef,
      feature: 'tests',
      probe: 'failing-test-reddens-gate',
    },
  ];

  for (const scenario of modes) {
    test(
      `${scenario.mode}: reports missed for ${scenario.feature}/${scenario.probe}, exit 1`,
      async () => {
        // Arrange
        const features = await featuresFile(`feat-${scenario.fixture}`, scenario.features);
        // Act
        const run = await cli([
          'probe',
          repoOf(scenario.fixture),
          '--probes',
          scenario.probes,
          '--features',
          features,
          '--json',
        ]);
        // Assert
        expect(run.exitCode).toBe(1);
        const payload = JSON.parse(run.stdout) as ProbePayload;
        expect(payload.counts.missed).toBeGreaterThanOrEqual(1);
        // The report names the missed feature AND probe (FR7's attribution).
        expect(verdictOf(payload.report, scenario.template, scenario.feature, scenario.probe)).toBe('missed');
      },
      T,
    );
  }
});

describe('composition and verdict parity (AC2, AC3)', () => {
  let standaloneReport: ProbeReport;

  test(
    'healthy composition: the child proves the parent’s features against the combined repo with zero extra authoring',
    async () => {
      // Arrange
      // Act
      const run = await cli(['probe', repoOf('probe-fixture-child-healthy'), '--template', CHILD_HEALTHY, '--json']);
      // Assert
      expect(run.exitCode).toBe(0);
      const payload = JSON.parse(run.stdout) as ProbePayload;
      expect(payload.counts.missed).toBe(0);
      expect(payload.counts.broken).toBe(0);
      // The child authored ONE docs probe; every other proven/caught verdict is
      // the parent's promise, proven against the final combined repo (FR3).
      expect(
        verdictOf(payload.report, 'cyanprint/probe-fixture-child-healthy', 'docs', 'baseline-usage-doc-present'),
      ).toBe('proven');
      expect(verdictOf(payload.report, 'cyanprint/probe-fixture-gated', 'tests', 'failing-test-reddens-gate')).toBe(
        'caught',
      );
      expect(payload.report.features.filter(entry => entry.template === 'cyanprint/probe-fixture-gated')).toHaveLength(
        4,
      );
      standaloneReport = payload.report;
    },
    T,
  );

  test(
    'verdict parity: `cyanprint test` (probe: true) and `cyanprint probe` agree over the same full matrix (FR13)',
    async () => {
      // Arrange
      // Act
      const run = await cli(['test', CHILD_HEALTHY, '--json']);
      // Assert
      expect(run.exitCode).toBe(0);
      const report = JSON.parse(run.stdout) as {
        failed: number;
        cases: Array<{ name: string; probes?: { report: ProbeReport } }>;
      };
      expect(report.failed).toBe(0);
      const probes = report.cases.find(entry => entry.name === 'basic')?.probes;
      if (!probes) {
        throw new Error('probe-enabled test case carried no probe outcome');
      }
      expect(verdictSet(probes.report)).toEqual(verdictSet(standaloneReport));
    },
    T,
  );
});

describe('selection and sandbox retention (AC4)', () => {
  test(
    '--probe runs the mutation plus its feature baseline only, labelled selection; --keep-sandbox retains paths',
    async () => {
      // Arrange
      const features = await featuresFile('feat-selection', ['tests', 'coverage', 'lint', 'ci']);
      // Act
      const run = await cli([
        'probe',
        repoOf('probe-fixture-gated'),
        '--probes',
        GATED,
        '--features',
        features,
        '--probe',
        'failing-test-reddens-gate',
        '--keep-sandbox',
        '--json',
      ]);
      // Assert
      expect(run.exitCode).toBe(0);
      const payload = JSON.parse(run.stdout) as ProbePayload;
      try {
        expect(payload.mode).toBe('selection');
        // Only the selected mutation's feature ran: its baseline + the mutation.
        expect(payload.report.features).toHaveLength(1);
        expect(payload.report.features[0]?.probes.map(probe => `${probe.kind}:${probe.name}`)).toEqual([
          'baseline:baseline-test-gate-green',
          'mutation:failing-test-reddens-gate',
        ]);
        expect(payload.counts).toEqual({ proven: 1, caught: 1, missed: 0, invalid: 0, broken: 0 });
        // Retention: the snapshot and per-run sandboxes are on disk, paths reported.
        expect(payload.snapshotPath).toBeDefined();
        expect(await Bun.file(join(payload.snapshotPath as string, 'src/calc.js')).exists()).toBe(true);
        expect(payload.sandboxes?.length).toBeGreaterThanOrEqual(1);
      } finally {
        if (payload.snapshotPath) {
          await rm(dirname(payload.snapshotPath), { recursive: true, force: true });
        }
      }
    },
    T,
  );
});

describe('manifest drift gate and --update-manifest (AC5b)', () => {
  test(
    'a hand-drifted probes.yaml fails both entry points; --update-manifest regenerates byte-exactly and clears it',
    async () => {
      // Arrange
      const copy = join(workRoot, 'gated-copy');
      await cp(GATED, copy, { recursive: true });
      await appendFile(join(copy, 'probes.yaml'), '# hand drift\n', 'utf8');

      // Act
      // Entry point 1: cyanprint probe (declaration mode) — exit 1 with the diff printed.
      const drifted = await cli(['probe', repoOf('probe-fixture-gated'), '--template', copy]);
      // Assert
      expect(drifted.exitCode).toBe(1);
      expect(drifted.stderr).toContain('drifted');
      expect(drifted.stderr).toContain('+++');
      expect(drifted.stderr).toContain('--update-manifest');

      // Act
      // Entry point 2: the probe-enabled test case fails on the same rule.
      const testRun = await cli(['test', copy, '--json']);
      // Assert
      expect(testRun.exitCode).toBe(1);
      const report = JSON.parse(testRun.stdout) as { failed: number; cases: Array<{ name: string; message?: string }> };
      expect(report.failed).toBeGreaterThanOrEqual(1);
      expect(report.cases.find(entry => entry.name === 'basic')?.message).toContain('drifted');

      // Act
      // --update-manifest writes a manifest matching plan-2's generator byte-for-byte.
      const update = await cli(['probe', '--template', copy, '--update-manifest', '--json']);
      // Assert
      expect(update.exitCode).toBe(0);
      expect(await Bun.file(join(copy, 'probes.yaml')).text()).toBe(await Bun.file(join(GATED, 'probes.yaml')).text());

      // Act
      // The gate clears: the same declaration-mode run now completes green.
      const clean = await cli(['probe', repoOf('probe-fixture-gated'), '--template', copy, '--json']);
      // Assert
      expect(clean.exitCode).toBe(0);
      const payload = JSON.parse(clean.stdout) as ProbePayload;
      expect(payload.counts).toEqual({ proven: 4, caught: 5, missed: 0, invalid: 0, broken: 0 });
    },
    T,
  );

  test(
    '--update-manifest combined with a run under --json emits a single valid JSON run payload (no human summary corrupting stdout)',
    async () => {
      // Arrange
      const copy = join(workRoot, 'gated-combined-json');
      await cp(GATED, copy, { recursive: true });
      await appendFile(join(copy, 'probes.yaml'), '# hand drift\n', 'utf8');

      // Act
      // Regenerate the manifest AND probe the repo in one invocation, with --json.
      // The manifest-update summary must not precede the JSON payload — stdout must
      // parse as a single JSON object, and the just-satisfied drift gate must not
      // fail the run.
      const combined = await cli([
        'probe',
        repoOf('probe-fixture-gated'),
        '--template',
        copy,
        '--update-manifest',
        '--json',
      ]);
      // Assert
      expect(combined.exitCode).toBe(0);
      // Whole stdout is exactly one JSON document — no leading `[ok] wrote ...` lines.
      const payload = JSON.parse(combined.stdout) as ProbePayload;
      expect(payload.mode).toBe('matrix');
      expect(payload.counts).toEqual({ proven: 4, caught: 5, missed: 0, invalid: 0, broken: 0 });
      // The drift was actually repaired on disk in the same run.
      expect(await Bun.file(join(copy, 'probes.yaml')).text()).toBe(await Bun.file(join(GATED, 'probes.yaml')).text());
    },
    T,
  );
});

describe('coverage-by-proof through the CLI (AC5)', () => {
  test(
    'a fixture profile declaring features that no probing profile proves is rejected with the features named',
    async () => {
      // Arrange
      const copy = join(workRoot, 'gated-uncovered');
      await cp(GATED, copy, { recursive: true });
      // Same profiles, but nobody probes: drop the probe: true opt-in.
      const manifest = await Bun.file(join(copy, 'cyan.test.yaml')).text();
      await Bun.write(join(copy, 'cyan.test.yaml'), manifest.replace('    probe: true\n', ''));

      // Act
      const run = await cli(['test', copy, '--json']);
      // Assert
      expect(run.exitCode).toBe(1);
      const report = JSON.parse(run.stdout) as { failed: number; cases: Array<{ name: string; message?: string }> };
      const coverage = report.cases.find(entry => entry.name === 'coverage-by-proof');
      expect(coverage?.message).toContain('cyanprint/probe-fixture-gated#tests');
      expect(coverage?.message).toContain('probe: true');
    },
    T,
  );
});

describe('declaration-mode does not probe a feature-off repo against the template union', () => {
  test(
    'a feature-gated template’s feature-OFF profile omits the features key yet probes nothing (re-derived from answers); the ON profile keeps the feature',
    async () => {
      // Arrange
      // A minimal feature-GATED template: the `gate` feature is declared only when the
      // `enableGate` answer is true. (No processors — an empty generated tree is enough;
      // the probe surface only reads the persisted feature union from state.)
      const tmpl = join(workRoot, 'gatecond-tmpl');
      await Bun.write(
        join(tmpl, 'cyan.yaml'),
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: probe-fixture-gatecond\nbundledEntry: cyan.ts\n',
      );
      await Bun.write(
        join(tmpl, 'cyan.ts'),
        "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
          'export default async function cyan(prompt: CyanPrompter) {\n' +
          "  const enableGate = await prompt.confirm('enableGate', 'Enable the gate?', { default: true });\n" +
          "  return { features: enableGate ? ['gate'] : [] };\n" +
          '}\n',
      );

      const offAnswers = join(workRoot, 'gatecond-off.json');
      await Bun.write(offAnswers, JSON.stringify({ enableGate: false }));
      const offRepo = join(workRoot, 'repo-gatecond-off');
      // Act
      const offCreate = await cli(['create', tmpl, '--out', offRepo, '--headless', '--answers', offAnswers, '--json']);
      // Assert
      expect(offCreate.exitCode).toBe(0);
      // The feature-off repo OMITS the `features` key entirely (spec.md:103–107) — the state
      // file is byte-identical to a legacy repo, preserving additivity. The feature-off repo
      // is NOT distinguished from legacy by the state file; declaration-mode probing re-derives
      // from the repo's own answers instead.
      const offState = await Bun.file(join(offRepo, '.cyan_state.yaml')).text();
      expect(offState).not.toContain('features:');

      // Declaration-mode probe of the feature-off repo finds NOTHING to probe — it re-derives
      // the (empty) feature set from the repo's own answers rather than falling back to the
      // template's profile union and surfacing a spurious `missed`.
      // --report must produce the run-report artifact at parity with --json even on this
      // no-feature path: automation requesting a report file must not
      // be silently short-changed just because nothing was probed.
      const offReport = join(workRoot, 'gatecond-off-report.json');
      // Act
      const offProbe = await cli(['probe', offRepo, '--template', tmpl, '--json', '--report', offReport]);
      // Assert
      expect(offProbe.exitCode).toBe(0);
      const offPayload = JSON.parse(offProbe.stdout) as ProbePayload & { note?: string; report: ProbeReport };
      expect(offPayload.counts).toEqual({ proven: 0, caught: 0, missed: 0, invalid: 0, broken: 0 });
      expect(offPayload.report.features).toHaveLength(0);
      // The written report file matches the --json payload byte-for-byte on this path.
      const offReportFile = JSON.parse(await Bun.file(offReport).text()) as ProbePayload & {
        note?: string;
        report: ProbeReport;
      };
      expect(offReportFile.counts).toEqual({ proven: 0, caught: 0, missed: 0, invalid: 0, broken: 0 });
      expect(offReportFile.report.features).toHaveLength(0);
      expect(offReportFile.note).toBe('no declared features to probe');

      // The feature-ON profile genuinely declares the feature — proving the gating is real,
      // not that probing was globally disabled.
      const onAnswers = join(workRoot, 'gatecond-on.json');
      await Bun.write(onAnswers, JSON.stringify({ enableGate: true }));
      const onRepo = join(workRoot, 'repo-gatecond-on');
      // Act
      const onCreate = await cli(['create', tmpl, '--out', onRepo, '--headless', '--answers', onAnswers, '--json']);
      // Assert
      expect(onCreate.exitCode).toBe(0);
      const onState = await Bun.file(join(onRepo, '.cyan_state.yaml')).text();
      expect(onState).toContain('template: cyanprint/probe-fixture-gatecond');
      expect(onState).toContain('name: gate');
    },
    T,
  );
});

describe('declaration-mode drift guard', () => {
  test(
    'a template that stops declaring a persisted feature fails loudly — never a green empty matrix',
    async () => {
      // Arrange
      // The false-green scenario: generate a repo while the template declares a
      // feature, then edit the template so its derivation returns nothing. The
      // repo's own `.cyan_state.yaml` still records the promise; declaration mode
      // must refuse to silently drop it (and with it the manifest gate) rather
      // than exit 0 having proven nothing.
      const tmpl = join(workRoot, 'declfeat-drift-tmpl');
      await Bun.write(
        join(tmpl, 'cyan.yaml'),
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: probe-fixture-declfeat-drift\nbundledEntry: cyan.ts\n',
      );
      // Keep the prompt across both variants so the repo's recorded answers
      // always replay cleanly — only the declared feature set changes.
      const cyanScript = (featuresExpr: string): string =>
        "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
        'export default async function cyan(prompt: CyanPrompter) {\n' +
        "  const enableGate = await prompt.confirm('enableGate', 'Enable the gate?', { default: true });\n" +
        `  return { features: ${featuresExpr} };\n` +
        '}\n';
      await Bun.write(join(tmpl, 'cyan.ts'), cyanScript("enableGate ? ['gate'] : []"));

      const repo = join(workRoot, 'repo-declfeat-drift');
      // Act
      const created = await cli(['create', tmpl, '--out', repo, '--headless', '--json']);
      // Assert
      expect(created.exitCode).toBe(0);
      // Non-vacuity: the persisted union really records the promise about to drift away.
      const state = await Bun.file(join(repo, '.cyan_state.yaml')).text();
      expect(state).toContain('name: gate');

      // Drift: the template no longer declares ANY feature.
      await Bun.write(join(tmpl, 'cyan.ts'), cyanScript('[]'));

      // Act
      const run = await cli(['probe', repo, '--template', tmpl, '--json']);
      // Assert
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('probe_declared_feature_drift');
      // The failure names the exact recorded promise the run would have stopped proving.
      expect(run.stderr).toContain('cyanprint/probe-fixture-declfeat-drift#gate');
      // No success payload reaches stdout — the old behavior was a green empty run.
      expect(run.stdout).not.toContain('"counts"');
    },
    T,
  );
});

describe('multi-install dependency drift in declaration mode', () => {
  test(
    'a dependency that stops declaring a recorded feature fails loudly even when the repo is multi-install',
    async () => {
      // Arrange
      // The false green this guards against: a repo whose
      // probed template composes a feature-declaring DEPENDENCY, plus an
      // unrelated second root install (multi-install). The dependency then
      // drifts to declare nothing. Under flat-union intersection scoping the
      // dropped `dep#gate` was indistinguishable from the sibling's feature —
      // `{"features": [], "counts": {"missed": 0}}`, exit 0. Per-install
      // attribution recorded on the parent's history entry makes the drop
      // attributable, so the run now exits 1 naming the dependency's promise.
      //
      // Each template-tree VERSION lives under its own `examples/templates`
      // root: composition resolution scans up from the probed --template dir,
      // so probing the v2 parent resolves the v2 (drifted) dep — genuine
      // cross-process drift, no in-place rewrite.
      const depYaml =
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: probe-fixture-depdrift-dep\nbundledEntry: cyan.ts\n';
      const parentYaml =
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: probe-fixture-depdrift-parent\nbundledEntry: cyan.ts\n' +
        'templates:\n' +
        '  cyanprint/probe-fixture-depdrift-dep:\n';
      const emptyCyan =
        "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
        'export default async function cyan(_prompt: CyanPrompter) {\n' +
        '  return { features: [] };\n' +
        '}\n';
      const depCyan = (featuresExpr: string): string =>
        "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
        'export default async function cyan(_prompt: CyanPrompter) {\n' +
        `  return { features: ${featuresExpr} };\n` +
        '}\n';
      const tree = async (variant: string, depFeaturesExpr: string): Promise<string> => {
        const root = join(workRoot, 'depdrift', variant, 'examples', 'templates');
        await Bun.write(join(root, 'probe-fixture-depdrift-dep', 'cyan.yaml'), depYaml);
        await Bun.write(join(root, 'probe-fixture-depdrift-dep', 'cyan.ts'), depCyan(depFeaturesExpr));
        await Bun.write(join(root, 'probe-fixture-depdrift-parent', 'cyan.yaml'), parentYaml);
        await Bun.write(join(root, 'probe-fixture-depdrift-parent', 'cyan.ts'), emptyCyan);
        return join(root, 'probe-fixture-depdrift-parent');
      };

      const parentV1 = await tree('v1', "['gate']");
      const repo = join(workRoot, 'repo-depdrift-multi');
      // Act
      const first = await cli(['create', parentV1, '--out', repo, '--headless', '--json']);
      // Assert
      expect(first.exitCode).toBe(0);

      // The unrelated second root install that made the legacy heuristic blind.
      const sidecarTmpl = join(workRoot, 'depdrift', 'sidecar-tmpl');
      await Bun.write(
        join(sidecarTmpl, 'cyan.yaml'),
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: probe-fixture-depdrift-sidecar\nbundledEntry: cyan.ts\n',
      );
      await Bun.write(join(sidecarTmpl, 'cyan.ts'), depCyan("['side']"));
      // Act
      const second = await cli(['create', sidecarTmpl, '--out', repo, '--headless', '--json']);
      // Assert
      expect(second.exitCode).toBe(0);

      // Non-vacuity: the repo's own state still records the dependency's promise
      // (both in the flat union and on the parent install's history entry).
      const state = await Bun.file(join(repo, '.cyan_state.yaml')).text();
      expect(state).toContain('template: cyanprint/probe-fixture-depdrift-dep');
      expect(state).toContain('name: gate');

      // Drift: the dependency stops declaring the feature.
      const parentV2 = await tree('v2', '[]');
      // Act
      const run = await cli(['probe', repo, '--template', parentV2, '--json']);
      // Assert
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('probe_declared_feature_drift');
      expect(run.stderr).toContain('cyanprint/probe-fixture-depdrift-dep#gate');
      // The old behavior was a green "no declared features to probe" payload.
      expect(run.stdout).not.toContain('"counts"');
    },
    T,
  );
});

describe('multi-install sibling scoping in declaration mode', () => {
  test(
    'probing one --template of a multi-install repo proves only that template’s features, not a sibling install’s',
    async () => {
      // Arrange
      // A minimal SECOND feature-declaring template, independent of gated (no
      // composition between them). Its `sidecar` feature is unrelated to gated's
      // gate features and emits a disjoint file so the create-into-existing merge
      // never conflicts.
      const sidecarTmpl = join(workRoot, 'sidecar-tmpl');
      await Bun.write(
        join(sidecarTmpl, 'cyan.yaml'),
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: probe-fixture-sidecar\nbundledEntry: cyan.ts\n',
      );
      await Bun.write(
        join(sidecarTmpl, 'cyan.ts'),
        "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
          'export default async function cyan(_prompt: CyanPrompter) {\n' +
          "  return { features: ['sidecar'] };\n" +
          '}\n',
      );

      // Install gated FIRST into a fresh dir, then install the sidecar template
      // into the SAME dir (create-into-existing → a genuine multi-install repo
      // whose persisted `.cyan_state.yaml` union spans BOTH templates' features).
      const multi = join(workRoot, 'repo-multi-install');
      // Act
      const first = await cli(['create', GATED, '--out', multi, '--headless', '--json']);
      // Assert
      expect(first.exitCode).toBe(0);
      // Act
      const second = await cli(['create', sidecarTmpl, '--out', multi, '--headless', '--json']);
      // Assert
      expect(second.exitCode).toBe(0);

      // The persisted union really does carry the sibling feature — otherwise the
      // scoping below would be vacuous.
      const state = await Bun.file(join(multi, '.cyan_state.yaml')).text();
      expect(state).toContain('name: sidecar');
      expect(state).toContain('name: ci');

      // Declaration-mode probing of gated must scope the persisted union down to
      // gated's OWN composition graph. Without that scoping this exited 1 with
      // `probe_resolution_failed` on the sidecar feature (it belongs to a template
      // outside gated's graph); after the fix the sidecar feature is filtered out
      // and gated's promises are proven cleanly.
      // Act
      const run = await cli(['probe', multi, '--template', GATED, '--json']);
      // Assert
      expect(run.stderr).not.toContain('probe_resolution_failed');
      expect(run.exitCode).toBe(0);
      const payload = JSON.parse(run.stdout) as ProbePayload;
      expect(payload.counts).toEqual({ proven: 4, caught: 5, missed: 0, invalid: 0, broken: 0 });
      // Only gated's four features are in scope; the sibling install's feature is not probed here.
      expect(payload.report.features.map(feature => `${feature.template}#${feature.name}`).sort()).toEqual([
        'cyanprint/probe-fixture-gated#ci',
        'cyanprint/probe-fixture-gated#coverage',
        'cyanprint/probe-fixture-gated#lint',
        'cyanprint/probe-fixture-gated#tests',
      ]);
      expect(payload.report.features.some(feature => feature.name === 'sidecar')).toBe(false);
    },
    T,
  );
});

describe('same-ref sibling/dependency collision in declaration mode', () => {
  test(
    'probing --template of the consumer proves only what its generation declared, even when the same dep ref is ALSO a sibling install with feature-enabling answers',
    async () => {
      // Arrange
      // The refined edge case within multi-install scoping: the SAME
      // template ref appears both as an independent sibling install (feature ON)
      // and as a dependency of the probed template (feature OFF). Graph-membership
      // scoping cannot tell the two apart — the ref IS in the consumer's graph —
      // so the sibling's feature leaked into the consumer's `--template` run and
      // surfaced a spurious `probe_resolution_failed`/`broken`. Re-deriving the
      // feature set from the consumer install's OWN answers fixes it.
      //
      // The templates live under a temp `examples/templates` root so composition
      // resolution (which scans up for that dir) finds the dep from the consumer.
      const roots = join(workRoot, 'sameref', 'examples', 'templates');
      const dep = join(roots, 'probe-fixture-sameref-dep');
      const consumer = join(roots, 'probe-fixture-sameref-consumer');

      // The dep declares its `gate` feature only when enableGate is true (default).
      await Bun.write(
        join(dep, 'cyan.yaml'),
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: probe-fixture-sameref-dep\nbundledEntry: cyan.ts\n',
      );
      await Bun.write(
        join(dep, 'cyan.ts'),
        "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
          'export default async function cyan(prompt: CyanPrompter) {\n' +
          "  const enableGate = await prompt.confirm('enableGate', 'Enable the gate?', { default: true });\n" +
          "  return { features: enableGate ? ['gate'] : [] };\n" +
          '}\n',
      );

      // The consumer composes the dep with enableGate FALSE and declares nothing
      // itself — so the consumer's generation of the dep declares ZERO features.
      await Bun.write(
        join(consumer, 'cyan.yaml'),
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: probe-fixture-sameref-consumer\nbundledEntry: cyan.ts\n' +
          'templates:\n' +
          '  cyanprint/probe-fixture-sameref-dep:\n' +
          '    answers:\n' +
          '      enableGate: false\n',
      );
      await Bun.write(
        join(consumer, 'cyan.ts'),
        "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
          'export default async function cyan(_prompt: CyanPrompter) {\n' +
          '  return { features: [] };\n' +
          '}\n',
      );

      // Install the dep DIRECTLY (enableGate defaults true → declares gate), then
      // install the consumer into the SAME dir (create-into-existing). The consumer
      // composes the same dep ref with enableGate false. The persisted union now
      // carries the SIBLING dep's `gate`, but the consumer generation declared none.
      const repo = join(workRoot, 'repo-sameref-collision');
      // Act
      const first = await cli(['create', dep, '--out', repo, '--headless', '--json']);
      // Assert
      expect(first.exitCode).toBe(0);
      // Act
      const second = await cli(['create', consumer, '--out', repo, '--headless', '--json']);
      // Assert
      expect(second.exitCode).toBe(0);

      // Non-vacuity: the persisted union really does carry the sibling dep's gate
      // feature — otherwise the scoping below would prove nothing anyway.
      const state = await Bun.file(join(repo, '.cyan_state.yaml')).text();
      expect(state).toContain('name: gate');
      expect(state).toContain('template: cyanprint/probe-fixture-sameref-dep');

      // Probing --template consumer must derive ZERO features (its generation of
      // the dep set enableGate false), not the sibling's leaked gate. Before the
      // fix this exited 1 with probe_resolution_failed on the sibling gate.
      const report = join(workRoot, 'sameref-report.json');
      // Act
      const run = await cli(['probe', repo, '--template', consumer, '--json', '--report', report]);
      // Assert
      expect(run.stderr).not.toContain('probe_resolution_failed');
      expect(run.exitCode).toBe(0);
      const payload = JSON.parse(run.stdout) as ProbePayload & { note?: string; report: ProbeReport };
      expect(payload.counts).toEqual({ proven: 0, caught: 0, missed: 0, invalid: 0, broken: 0 });
      expect(payload.report.features).toHaveLength(0);
      expect(payload.report.features.some(feature => feature.name === 'gate')).toBe(false);
    },
    T,
  );
});

describe('additivity (AC6)', () => {
  test(
    'a probe-free template runs cyanprint test unchanged',
    async () => {
      // Arrange
      // Act
      const run = await cli(['test', join(TEMPLATES, 'hello'), '--json']);
      // Assert
      expect(run.exitCode).toBe(0);
      const report = JSON.parse(run.stdout) as {
        failed: number;
        cases: Array<{ name: string; probes?: unknown }>;
      };
      expect(report.failed).toBe(0);
      expect(report.cases.some(entry => entry.name === 'coverage-by-proof')).toBe(false);
      expect(report.cases.every(entry => entry.probes === undefined)).toBe(true);
    },
    T,
  );
});
