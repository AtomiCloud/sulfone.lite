import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Answers, Provenance } from '@cyanprint/contracts';
import YAML from 'yaml';
import { createProject } from '../create/create-project';
import { STATE_FILE, loadGeneratedState } from '../state/generated-state';
import { comparePaths, exists, isRecord, mapWithConcurrency, readText, safeJoin, writeText } from '../util';
import { parseGitignore } from './gitignore';
import { readCommandValidations, runCommandValidations, type CommandValidation } from './command-validations';

export type TemplateTestReport = {
  passed: number;
  failed: number;
  skipped: number;
  snapshotUpdated: number;
  cases: Array<{ name: string; status: 'passed' | 'failed'; message?: string }>;
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
  segment?: 'processor' | 'dependency' | 'sibling';
};

type TemplateCase = {
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
  return {
    passed: results.filter(testCase => testCase.status === 'passed').length,
    failed: results.filter(testCase => testCase.status === 'failed').length,
    skipped: 0,
    snapshotUpdated: perCase.filter(entry => entry.snapshotUpdated).length,
    cases: results,
  };
}

async function runTemplateCase(
  args: { template: string; answers?: string; outDir: string; updateSnapshots?: boolean; cases: TemplateCase[] },
  testCase: TemplateCase,
): Promise<{ case: TemplateTestReport['cases'][number]; snapshotUpdated: boolean }> {
  // safeJoin: the case name comes from cyan.test.yaml and is immediately rm -rf'd — a name
  // like "../../x" must never resolve outside the test output directory.
  const outDir = args.cases.length === 1 ? args.outDir : safeJoin(args.outDir, testCase.name);
  try {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const answers = await readCaseRecord<Answers>(testCase.answers ?? args.answers, 'answers');
    const deterministicState = await readCaseRecord<Record<string, unknown>>(
      testCase.deterministicState,
      'deterministicState',
    );
    await createProject({ template: args.template, outDir, headless: true, answers, deterministicState });

    const mergeFailure = await checkMergeAssertions(outDir, testCase);
    if (mergeFailure) {
      return { case: { name: testCase.name, status: 'failed', message: mergeFailure }, snapshotUpdated: false };
    }

    if (!testCase.expected) {
      return {
        case: { name: testCase.name, status: 'failed', message: 'Test case needs expected output.' },
        snapshotUpdated: false,
      };
    }
    const excluded = await buildExclusionFilter(outDir, testCase.ignore);
    const actual = await readFileTree(outDir, excluded);
    if (!args.updateSnapshots) {
      const diff = compareFileTrees(await readFileTree(testCase.expected, excluded), actual);
      if (diff) {
        return { case: { name: testCase.name, status: 'failed', message: diff }, snapshotUpdated: false };
      }
    }
    const validationFailure = await runCommandValidations(outDir, testCase.validations);
    if (validationFailure) {
      return { case: { name: testCase.name, status: 'failed', message: validationFailure }, snapshotUpdated: false };
    }
    if (args.updateSnapshots) {
      await writeFileTree(testCase.expected, actual);
      return { case: { name: testCase.name, status: 'passed' }, snapshotUpdated: true };
    }
    return { case: { name: testCase.name, status: 'passed' }, snapshotUpdated: false };
  } catch (error) {
    return { case: { name: testCase.name, status: 'failed', message: String(error) }, snapshotUpdated: false };
  }
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

async function loadTemplateTestCases(template: string): Promise<TemplateCase[]> {
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
  };
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
    if (segment !== undefined && segment !== 'processor' && segment !== 'dependency' && segment !== 'sibling') {
      throw new Error(`${label}[${index}].segment must be processor, dependency, or sibling.`);
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

async function readCaseRecord<T extends Record<string, unknown>>(
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
