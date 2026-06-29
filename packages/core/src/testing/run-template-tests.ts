import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { createProject } from '../create/create-project';
import { exists, readText, safeJoin, writeText } from '../util';
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
    answers: args.answers ? (JSON.parse(await readText(args.answers)) as Record<string, unknown>) : {},
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
  }
  return { passed: 1, failed: 0, skipped: 0, snapshotUpdated: 0, cases: [{ name: 'basic', status: 'passed' }] };
}

type TemplateCase = {
  name: string;
  answers?: string;
  expected?: string;
  snapshot?: string;
  commands: CommandValidation[];
};

async function runTemplateManifestTests(args: {
  template: string;
  answers?: string;
  outDir: string;
  snapshot?: string;
  updateSnapshots?: boolean;
  cases: TemplateCase[];
}): Promise<TemplateTestReport> {
  const results: TemplateTestReport['cases'] = [];
  let snapshotUpdated = 0;
  for (const testCase of args.cases) {
    const outDir = args.cases.length === 1 ? args.outDir : join(args.outDir, testCase.name);
    try {
      await rm(outDir, { recursive: true, force: true });
      await mkdir(outDir, { recursive: true });
      const answersPath = testCase.answers ?? args.answers;
      await createProject({
        template: args.template,
        outDir,
        headless: true,
        answers: answersPath ? (JSON.parse(await readText(answersPath)) as Record<string, unknown>) : {},
      });
      const commandFailure = await runCommandValidations(outDir, testCase.commands);
      if (commandFailure) {
        results.push({ name: testCase.name, status: 'failed', message: commandFailure });
        continue;
      }
      if (testCase.expected) {
        const expected = await readFileTree(testCase.expected);
        const actual = await readFileTree(outDir);
        const diff = compareFileTrees(
          expected.filter(file => file.path !== '.cyan_state.yaml'),
          actual.filter(file => file.path !== '.cyan_state.yaml'),
        );
        if (diff) {
          results.push({ name: testCase.name, status: 'failed', message: diff });
          continue;
        }
      }
      const snapshot = testCase.snapshot ?? args.snapshot;
      if (snapshot) {
        const actual = await readText(join(outDir, 'README.md'));
        if (args.updateSnapshots) {
          await writeText(snapshot, actual);
          snapshotUpdated += 1;
        } else {
          const expected = await readText(snapshot);
          if (actual !== expected) {
            results.push({ name: testCase.name, status: 'failed', message: 'Snapshot mismatch' });
            continue;
          }
        }
      }
      results.push({ name: testCase.name, status: 'passed' });
    } catch (error) {
      results.push({ name: testCase.name, status: 'failed', message: String(error) });
    }
  }
  return {
    passed: results.filter(testCase => testCase.status === 'passed').length,
    failed: results.filter(testCase => testCase.status === 'failed').length,
    skipped: 0,
    snapshotUpdated,
    cases: results,
  };
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
  return {
    name: readRequiredString(record.name, `cases[${index}].name`),
    answers: readOptionalPath(template, record.answers),
    expected: readOptionalPath(template, record.expected),
    snapshot: readOptionalPath(template, record.snapshot),
    commands: readCommandValidations(record.commands, `cases[${index}].commands`),
  };
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

async function readFileTree(root: string): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  await walk(root, async path => {
    files.push({ path: path.slice(root.length + 1), content: await readText(path) });
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  if (!(await exists(root))) {
    throw new Error(`Expected directory not found: ${root}`);
  }
  for (const entry of await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: root, onlyFiles: true, dot: true }))) {
    await visit(join(root, entry));
  }
}

function compareFileTrees(
  expected: Array<{ path: string; content: string }>,
  actual: Array<{ path: string; content: string }>,
): string | undefined {
  const expectedMap = new Map(expected.map(file => [file.path, file.content]));
  const actualMap = new Map(actual.map(file => [file.path, file.content]));
  for (const path of [...expectedMap.keys()].sort()) {
    if (!actualMap.has(path)) {
      return `Missing output file: ${path}`;
    }
    if (actualMap.get(path) !== expectedMap.get(path)) {
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
