import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Answers, ProbeFeatureIdentity, ProbeRunReport, Provenance } from '@cyanprint/contracts';
import YAML from 'yaml';
import { createProject } from '../create/create-project';
import { featureIdentityKey } from '../probe/features';
import { checkProbeManifestDrift } from '../probe/manifest';
import { summarizeProbeReport, type ProbeReportSummary } from '../probe/report';
import { runProbeMatrix } from '../probe/run-probes';
import { STATE_FILE, loadGeneratedState } from '../state/generated-state';
import { comparePaths, exists, isRecord, mapWithConcurrency, readText, safeJoin, writeText } from '../util';
import { parseGitignore } from './gitignore';
import { readCommandValidations, runCommandValidations, type CommandValidation } from './command-validations';

/**
 * A probing case's per-verdict counts plus the full run report, attached to the
 * case entry — additive to the existing `{ passed, failed, skipped, cases }`
 * envelope so `cyanprint test --json` surfaces probe outcomes without breaking
 * pre-probe consumers (FR8), and full-matrix verdict parity with `cyanprint
 * probe` stays checkable from the report itself (FR13). The shape is the generic
 * probe-domain `ProbeReportSummary` (`probe/report.ts`) — the test tier just
 * names it in its own vocabulary.
 */
export type TemplateCaseProbeOutcome = ProbeReportSummary;

export type TemplateTestReport = {
  passed: number;
  failed: number;
  skipped: number;
  snapshotUpdated: number;
  cases: Array<{ name: string; status: 'passed' | 'failed'; message?: string; probes?: TemplateCaseProbeOutcome }>;
};

export async function runTemplateTest(args: {
  template: string;
  answers?: string;
  outDir: string;
  snapshot?: string;
  updateSnapshots?: boolean;
  concurrency?: number;
}): Promise<TemplateTestReport> {
  const manifestCases = await loadTemplateTestCases(args.template);
  if (manifestCases.length > 0) {
    return runTemplateManifestTests({ ...args, cases: manifestCases });
  }
  await mkdir(args.outDir, { recursive: true });
  await createProject({
    template: args.template,
    outDir: args.outDir,
    headless: true,
    answers: args.answers ? await readAnswersRecord(args.answers) : {},
  });
  if (args.snapshot) {
    const actual = await readText(join(args.outDir, 'README.md'));
    if (args.updateSnapshots) {
      await writeText(args.snapshot, actual);
      return { passed: 1, failed: 0, skipped: 0, snapshotUpdated: 1, cases: [{ name: 'basic', status: 'passed' }] };
    }
    const expected = await readText(args.snapshot);
    if (actual !== expected) {
      return {
        passed: 0,
        failed: 1,
        skipped: 0,
        snapshotUpdated: 0,
        cases: [{ name: 'basic', status: 'failed', message: 'Snapshot mismatch' }],
      };
    }
    return { passed: 1, failed: 0, skipped: 0, snapshotUpdated: 0, cases: [{ name: 'basic', status: 'passed' }] };
  }
  return {
    passed: 0,
    failed: 1,
    skipped: 0,
    snapshotUpdated: 0,
    cases: [
      {
        name: 'basic',
        status: 'failed',
        message: 'Template tests need cyan.test.yaml with expected output, or a legacy --snapshot path.',
      },
    ],
  };
}

/** A per-path merge-decision assertion: every conflict is intentional. */
type MergeAssertion = {
  path: string;
  decision: 'resolver' | 'lww';
  resolver?: string;
  // Template tests generate in isolation, so sibling collisions can never occur in a case —
  // only the processor and dependency segments are assertable.
  segment?: 'processor' | 'dependency';
};

export type TemplateCase = {
  name: string;
  answers?: string | Answers;
  deterministicState?: string | Record<string, unknown>;
  expected?: string;
  /** Globs excluded from the folder compare (discouraged; document why per entry). */
  ignore: string[];
  merges: MergeAssertion[];
  /** Escape hatch: accept lww-overrides that are not asserted in merges. Discouraged. */
  allowUnassertedLww: boolean;
  validations: CommandValidation[];
  /**
   * Opt-in probe tier (FR8): after validations, run the manifest drift gate and
   * the full probe matrix against this case's generated output. Default false —
   * probe-free cases run byte-identically to pre-probe CyanPrint.
   */
  probe: boolean;
};

async function runTemplateManifestTests(args: {
  template: string;
  answers?: string;
  outDir: string;
  updateSnapshots?: boolean;
  concurrency?: number;
  cases: TemplateCase[];
}): Promise<TemplateTestReport> {
  // Duplicate names would share one output directory and race under concurrency.
  const seenNames = new Set<string>();
  for (const testCase of args.cases) {
    if (seenNames.has(testCase.name)) {
      throw new Error(`cyan.test.yaml has duplicate case name: ${testCase.name}`);
    }
    seenNames.add(testCase.name);
  }
  const perCase = await mapWithConcurrency(args.cases, args.concurrency ?? 1, testCase =>
    runTemplateCase(args, testCase),
  );
  const results = perCase.map(entry => entry.case);
  const coverageFailure = coverageByProofFailure(perCase);
  if (coverageFailure) {
    results.push(coverageFailure);
  }
  return {
    passed: results.filter(testCase => testCase.status === 'passed').length,
    failed: results.filter(testCase => testCase.status === 'failed').length,
    skipped: 0,
    snapshotUpdated: perCase.filter(entry => entry.snapshotUpdated).length,
    cases: results,
  };
}

/**
 * Coverage-by-proof (FR8): every feature that ANY case's generation declared
 * must be PROVEN by at least one passing `probe: true` case — where "proven"
 * (see `featureIsProven`) means the feature's report carries BOTH a `proven`
 * baseline AND a `caught` mutation. A declared feature nobody probes, whose
 * only probing case asserted nothing, or whose probe set never actually catches
 * a sabotage, is exactly the unproven promise the epic exists to kill.
 * Templates declaring no features are untouched (additivity).
 *
 * Exported for the focused coverage keying/adequacy regression tests: the
 * collision and baseline-only holes are subtle enough to warrant asserting the
 * pure decision directly, not only through a full generation.
 */
export function coverageByProofFailure(
  perCase: Array<{ case: TemplateTestReport['cases'][number]; features: ProbeFeatureIdentity[]; probe: boolean }>,
): TemplateTestReport['cases'][number] | undefined {
  const declared = new Map<string, ProbeFeatureIdentity>();
  const proven = new Set<string>();
  for (const entry of perCase) {
    for (const feature of entry.features) {
      // Collision-free identity key: an ad hoc `${template}#${name}` join lets
      // distinct identities collapse into one, so a proof for one feature could
      // satisfy coverage for another. Share `probe/features.ts`'s scheme.
      const key = featureIdentityKey(feature);
      declared.set(key, feature);
      // A passing case is NOT enough: it must have produced a `proven` baseline
      // AND a `caught` mutation for THIS feature (see featureIsProven). A run can
      // pass with only `invalid` verdicts or with a baseline-only probe that never
      // sabotages anything — neither exercises drift detection, so neither
      // satisfies coverage.
      if (entry.probe && entry.case.status === 'passed' && featureIsProven(entry.case.probes?.report, key)) {
        proven.add(key);
      }
    }
  }
  const unproven = [...declared.entries()]
    .filter(([key]) => !proven.has(key))
    .map(([, feature]) => `${feature.template}#${feature.name}`);
  if (declared.size === 0 || unproven.length === 0) {
    return undefined;
  }
  return {
    name: 'coverage-by-proof',
    status: 'failed',
    message:
      `Declared features proven by no probing case: ${unproven.sort().join(', ')}. ` +
      'Every declared feature must be proven by a passing `probe: true` case that produces BOTH a `proven` ' +
      'baseline AND a `caught` mutation for it (FR8) — a baseline-only probe or an all-`invalid` run asserts ' +
      "nothing about drift detection. Add or fix a mutation probe that catches a sabotage of the feature's " +
      'gate, or stop declaring the feature.',
  };
}

/**
 * A declared feature is proven only when its probing case's report carries BOTH:
 *  - a `proven` verdict — a baseline passed, so the healthy gate is green
 *    (`proven` is exclusively a baseline verdict — executor.ts `baselineVerdict`); AND
 *  - a `caught` verdict — a mutation's sabotage was detected, so the gate
 *    actually reddens on drift (`caught` is exclusively a mutation verdict —
 *    executor.ts `mutationVerdict`).
 * Requiring the `caught` closes the baseline-only false green: a feature whose
 * only probe is a baseline (or whose mutations never apply) can pass every case
 * yet never exercise the drift-detection path the probe tier exists to prove.
 * `invalid` / `broken` are not proof either way.
 */
function featureIsProven(report: ProbeRunReport | undefined, key: string): boolean {
  const feature = report?.features.find(entry => featureIdentityKey(entry) === key);
  if (!feature) {
    return false;
  }
  const hasProvenBaseline = feature.probes.some(probe => probe.verdict === 'proven');
  const catchesSabotage = feature.probes.some(probe => probe.verdict === 'caught');
  return hasProvenBaseline && catchesSabotage;
}

async function runTemplateCase(
  args: { template: string; answers?: string; outDir: string; updateSnapshots?: boolean; cases: TemplateCase[] },
  testCase: TemplateCase,
): Promise<{
  case: TemplateTestReport['cases'][number];
  snapshotUpdated: boolean;
  /** Features this case's generation declared — the coverage-by-proof input. */
  features: ProbeFeatureIdentity[];
  probe: boolean;
}> {
  // safeJoin: the case name comes from cyan.test.yaml and is immediately rm -rf'd — a name
  // like "../../x" must never resolve outside the test output directory.
  const outDir = args.cases.length === 1 ? args.outDir : safeJoin(args.outDir, testCase.name);
  let features: ProbeFeatureIdentity[] = [];
  const finish = (
    entry: TemplateTestReport['cases'][number],
    snapshotUpdated = false,
  ): {
    case: TemplateTestReport['cases'][number];
    snapshotUpdated: boolean;
    features: ProbeFeatureIdentity[];
    probe: boolean;
  } => ({
    case: entry,
    snapshotUpdated,
    features,
    probe: testCase.probe,
  });
  try {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const answers = await readCaseRecord<Answers>(testCase.answers ?? args.answers, 'answers');
    const deterministicState = await readCaseRecord<Record<string, unknown>>(
      testCase.deterministicState,
      'deterministicState',
    );
    const created = await createProject({
      template: args.template,
      outDir,
      headless: true,
      answers,
      deterministicState,
    });
    features = created.features;

    const mergeFailure = await checkMergeAssertions(outDir, testCase);
    if (mergeFailure) {
      return finish({ name: testCase.name, status: 'failed', message: mergeFailure });
    }

    if (!testCase.expected) {
      return finish({ name: testCase.name, status: 'failed', message: 'Test case needs expected output.' });
    }
    const excluded = await buildExclusionFilter(outDir, testCase.ignore);
    const actual = await readFileTree(outDir, excluded);
    if (!args.updateSnapshots) {
      const diff = compareFileTrees(await readFileTree(testCase.expected, excluded), actual);
      if (diff) {
        return finish({ name: testCase.name, status: 'failed', message: diff });
      }
    }
    const validationFailure = await runCommandValidations(outDir, testCase.validations);
    if (validationFailure) {
      return finish({ name: testCase.name, status: 'failed', message: validationFailure });
    }
    let probeOutcome: TemplateCaseProbeOutcome | undefined;
    if (testCase.probe) {
      const tier = await runProbeTierForCase(args.template, outDir, features);
      probeOutcome = tier.outcome;
      if (tier.failure) {
        return finish({ name: testCase.name, status: 'failed', message: tier.failure, probes: probeOutcome });
      }
    }
    if (args.updateSnapshots) {
      await writeFileTree(testCase.expected, actual);
      return finish({ name: testCase.name, status: 'passed', probes: probeOutcome }, true);
    }
    return finish({ name: testCase.name, status: 'passed', probes: probeOutcome });
  } catch (error) {
    return finish({ name: testCase.name, status: 'failed', message: String(error) });
  }
}

/**
 * The opt-in probe tier (FR8), layered on top of the untouched validation tier:
 * first the manifest drift gate — the SAME rule as `cyanprint probe` in
 * declaration mode (FR6: a feature-declaring template must carry a committed,
 * drift-free probes.yaml; the two entry points must never disagree) — then the
 * full probe matrix against the case's generated output through the shared
 * `runProbeMatrix` engine (FR13). Any `missed`/`broken` verdict fails the case
 * with the offending probes named.
 */
async function runProbeTierForCase(
  template: string,
  outDir: string,
  features: ProbeFeatureIdentity[],
): Promise<{ failure?: string; outcome?: TemplateCaseProbeOutcome }> {
  if (features.length === 0) {
    // Nothing declared — nothing to gate or prove; probing is a no-op.
    return {};
  }
  // Throws with the drift diff on a drifted or missing manifest; runTemplateCase's
  // catch turns that into the case failure (FR6's "fails the gate").
  await checkProbeManifestDrift(template);
  const { report } = await runProbeMatrix({
    repoPath: outDir,
    probeSources: { mode: 'declaration', templateDir: template },
    features,
  });
  const outcome = summarizeProbeReport(report);
  const offenders: string[] = [];
  for (const feature of report.features) {
    for (const probe of feature.probes) {
      if (probe.verdict === 'missed' || probe.verdict === 'broken') {
        offenders.push(`${feature.template}#${feature.name}/${probe.name}=${probe.verdict}`);
      }
    }
  }
  if (offenders.length > 0) {
    return { failure: `probe verdicts: ${offenders.join(', ')}`, outcome };
  }
  return { outcome };
}

/**
 * Assert the generation's persisted merge decisions (spec: strict by default). Every
 * `merges:` entry must match a recorded decision, and every `lww-override` in the
 * persisted provenance must be asserted — an unasserted LWW fails the test unless the
 * discouraged per-case `allowUnassertedLww` escape hatch is set.
 */
async function checkMergeAssertions(outDir: string, testCase: TemplateCase): Promise<string | undefined> {
  const state = await loadGeneratedState(outDir);
  const events = state.provenance.filter(event => event.decision !== 'added');
  for (const assertion of testCase.merges) {
    if (!events.some(event => assertionMatches(assertion, event))) {
      return (
        `merges assertion not satisfied: ${assertion.path} expected ${assertion.decision}` +
        `${assertion.resolver ? ` via ${assertion.resolver}` : ''}${assertion.segment ? ` in ${assertion.segment}` : ''}`
      );
    }
  }
  if (!testCase.allowUnassertedLww) {
    const unasserted = events.filter(
      event =>
        event.decision === 'lww-override' && !testCase.merges.some(assertion => assertionMatches(assertion, event)),
    );
    if (unasserted.length > 0) {
      const first = unasserted[0];
      return (
        `unasserted lww-override on ${first?.path} (segment: ${first?.segment ?? 'unknown'}). ` +
        'Attach a resolver or assert the LWW in merges: — every conflict must be intentional.'
      );
    }
  }
  return undefined;
}

function assertionMatches(assertion: MergeAssertion, event: Provenance): boolean {
  if (assertion.path !== event.path) {
    return false;
  }
  const expectedDecision = assertion.decision === 'resolver' ? 'resolver-merged' : 'lww-override';
  if (event.decision !== expectedDecision) {
    return false;
  }
  if (assertion.segment && event.segment !== assertion.segment) {
    return false;
  }
  if (assertion.resolver) {
    const actual = event.resolver ?? '';
    if (actual !== assertion.resolver && !actual.startsWith(`${assertion.resolver}@`)) {
      return false;
    }
  }
  return true;
}

/** Exclusion filter: `ignore:` globs plus the output's own root `.gitignore`. */
async function buildExclusionFilter(outDir: string, ignore: string[]): Promise<(path: string) => boolean> {
  const ignoreGlobs = ignore.map(pattern => new Bun.Glob(pattern));
  const gitignorePath = join(outDir, '.gitignore');
  const gitignore = (await exists(gitignorePath)) ? parseGitignore(await readText(gitignorePath)) : () => false;
  return (path: string): boolean => ignoreGlobs.some(glob => glob.match(path)) || gitignore(path);
}

async function readAnswersRecord(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readText(path)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Answers file must contain a JSON object of answers: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Load a template's curated test profiles from cyan.test.yaml. Exported for the
 * probe engine, whose manifest derivation runs the same profiles headlessly.
 */
export async function loadTemplateTestCases(template: string): Promise<TemplateCase[]> {
  const testManifestPath = join(template, 'cyan.test.yaml');
  if (!(await exists(testManifestPath))) {
    return [];
  }
  const manifest = YAML.parse(await readText(testManifestPath)) as unknown;
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('cyan.test.yaml must contain a mapping.');
  }
  const rawCases = (manifest as { cases?: unknown }).cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error('cyan.test.yaml must contain at least one case.');
  }
  return rawCases.map((rawCase, index) => parseTemplateCase(template, rawCase, index));
}

function parseTemplateCase(template: string, rawCase: unknown, index: number): TemplateCase {
  if (!rawCase || typeof rawCase !== 'object') {
    throw new Error(`cyan.test.yaml case ${index + 1} must be a mapping.`);
  }
  const record = rawCase as Record<string, unknown>;
  rejectRemovedTestField(record, 'commands', `cases[${index}].commands`);
  rejectRemovedTestField(record, 'snapshot', `cases[${index}].snapshot`);
  return {
    name: readRequiredString(record.name, `cases[${index}].name`),
    answers: readOptionalPathOrRecord(template, record.answers, `cases[${index}].answers`),
    deterministicState: readOptionalPathOrRecord(
      template,
      record.deterministicState,
      `cases[${index}].deterministicState`,
    ),
    expected: readOptionalPath(template, record.expected),
    ignore: readStringList(record.ignore, `cases[${index}].ignore`),
    merges: readMergeAssertions(record.merges, `cases[${index}].merges`),
    allowUnassertedLww: record.allowUnassertedLww === true,
    validations: readCommandValidations(record.validations, `cases[${index}].validations`),
    probe: readOptionalBoolean(record.probe, `cases[${index}].probe`),
  };
}

function readOptionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function readStringList(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${label} must be a list of non-empty strings.`);
  }
  return value as string[];
}

function readMergeAssertions(value: unknown, label: string): MergeAssertion[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a list.`);
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`${label}[${index}] must be a mapping.`);
    }
    const record = raw as Record<string, unknown>;
    const path = readRequiredString(record.path, `${label}[${index}].path`);
    const decision = record.decision;
    if (decision !== 'resolver' && decision !== 'lww') {
      throw new Error(`${label}[${index}].decision must be "resolver" or "lww".`);
    }
    const segment = record.segment;
    if (segment !== undefined && segment !== 'processor' && segment !== 'dependency') {
      throw new Error(
        `${label}[${index}].segment must be processor or dependency (template tests generate in isolation, so sibling merges cannot occur).`,
      );
    }
    const resolver = record.resolver;
    if (resolver !== undefined && (typeof resolver !== 'string' || resolver.length === 0)) {
      throw new Error(`${label}[${index}].resolver must be a non-empty string.`);
    }
    return {
      path,
      decision,
      resolver: resolver as string | undefined,
      segment: segment as MergeAssertion['segment'],
    };
  });
}

function rejectRemovedTestField(record: Record<string, unknown>, field: string, label: string): void {
  if (record[field] !== undefined) {
    throw new Error(`${label} is no longer supported. Use validations with an expected output directory.`);
  }
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function readOptionalPath(root: string, value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Test paths must be non-empty strings.');
  }
  return safeJoin(root, value);
}

function readOptionalPathOrRecord(
  root: string,
  value: unknown,
  label: string,
): string | Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return readOptionalPath(root, value);
  }
  if (isRecord(value)) {
    return structuredClone(value);
  }
  throw new Error(`${label} must be a path string or mapping.`);
}

/** Resolve a test case's inline record / JSON-file path to the record itself. */
export async function readCaseRecord<T extends Record<string, unknown>>(
  value: string | Record<string, unknown> | undefined,
  label: string,
): Promise<T> {
  if (value === undefined) {
    return {} as T;
  }
  if (typeof value === 'string') {
    const parsed = JSON.parse(await readText(value)) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`${label} file must contain a JSON object.`);
    }
    return parsed as T;
  }
  return structuredClone(value) as T;
}

type TemplateTestFile = {
  path: string;
  bytes: Uint8Array;
};

async function readFileTree(root: string, excluded?: (path: string) => boolean): Promise<TemplateTestFile[]> {
  const files: TemplateTestFile[] = [];
  await walk(root, async path => {
    const relativePath = path.slice(root.length + 1);
    if (relativePath === STATE_FILE || excluded?.(relativePath)) {
      return;
    }
    files.push({ path: relativePath, bytes: new Uint8Array(await Bun.file(path).arrayBuffer()) });
  });
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

async function writeFileTree(root: string, files: TemplateTestFile[]): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const file of files) {
    const target = safeJoin(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, file.bytes);
  }
}

async function walk(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  if (!(await exists(root))) {
    throw new Error(`Expected directory not found: ${root}`);
  }
  for (const entry of await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: root, onlyFiles: true, dot: true }))) {
    await visit(join(root, entry));
  }
}

// Byte-for-byte compare: tree shape AND exact bytes (text and binary).
function compareFileTrees(expected: TemplateTestFile[], actual: TemplateTestFile[]): string | undefined {
  const expectedMap = new Map(expected.map(file => [file.path, file.bytes]));
  const actualMap = new Map(actual.map(file => [file.path, file.bytes]));
  for (const path of [...expectedMap.keys()].sort()) {
    if (!actualMap.has(path)) {
      return `Missing output file: ${path}`;
    }
    const expectedBytes = expectedMap.get(path) ?? new Uint8Array();
    const actualBytes = actualMap.get(path) ?? new Uint8Array();
    if (!bytesEqual(actualBytes, expectedBytes)) {
      return `Output mismatch: ${path}`;
    }
  }
  for (const path of [...actualMap.keys()].sort()) {
    if (!expectedMap.has(path)) {
      return `Unexpected output file: ${path}`;
    }
  }
  return undefined;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return left.every((byte, index) => byte === right[index]);
}
