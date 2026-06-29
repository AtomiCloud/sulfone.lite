import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import YAML from 'yaml';
import { compileRuntimeBundle } from '@cyanprint/artifact-bundler';
import { invokePlugin, invokeProcessor, invokeResolver, type ArtifactBundleRef } from '@cyanprint/artifact-runner';
import type { ArtifactKind, CyanManifest, VfsFile } from '@cyanprint/contracts';
import { loadManifest } from '../manifest/load-manifest';
import { exists, readText, safeJoin, sha256, writeText } from '../util';
import { readCommandValidations, runCommandValidations, type CommandValidation } from './command-validations';

type ArtifactTestCase = {
  name: string;
  status: 'passed' | 'failed';
  message?: string;
};

type TestValidation = {
  path?: string;
  exists?: boolean;
  equals?: string;
  contains?: string;
  notContains?: string;
};

type FileArtifactCase = {
  name: string;
  input: string;
  expected?: string;
  config?: unknown;
  configFile?: string;
  validations: TestValidation[];
  commands: CommandValidation[];
};

type ResolverArtifactCase = {
  name: string;
  prior?: string;
  current?: string;
  target?: string;
  resolverInputs?: Array<{ path: string; origin: { template: string; layer: number } }>;
  expected?: string;
  config?: unknown;
  configFile?: string;
  validations: TestValidation[];
  commands: CommandValidation[];
};

type ArtifactCase = FileArtifactCase | ResolverArtifactCase;

export type ArtifactTestReport = {
  kind: Extract<ArtifactKind, 'processor' | 'plugin' | 'resolver'>;
  passed: number;
  failed: number;
  skipped: number;
  snapshotUpdated: number;
  cases: ArtifactTestCase[];
};

export async function runArtifactTests(args: {
  artifactDir: string;
  testsDir?: string;
  updateSnapshots?: boolean;
}): Promise<ArtifactTestReport> {
  const { manifest } = await loadManifest(args.artifactDir);
  if (!isRuntimeArtifact(manifest.kind)) {
    throw new Error(`artifact tests require processor, plugin, or resolver; got ${manifest.kind}`);
  }

  const testCases = await loadArtifactTestCases(args.artifactDir, manifest.kind, args.testsDir);
  const runtimeDir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-test-'));
  try {
    const runtimeFile = await buildRuntime(args.artifactDir, manifest, runtimeDir);
    const bundle = await artifactBundle(manifest, runtimeFile);
    const cases: ArtifactTestCase[] = [];
    let snapshotUpdated = 0;

    for (const testCase of testCases) {
      const result =
        manifest.kind === 'resolver'
          ? await runResolverCase(bundle, testCase as ResolverArtifactCase, Boolean(args.updateSnapshots))
          : await runFileArtifactCase(
              bundle,
              manifest.kind,
              testCase as FileArtifactCase,
              Boolean(args.updateSnapshots),
            );
      if (result.snapshotUpdated) {
        snapshotUpdated += 1;
      }
      cases.push(result.case);
    }

    return {
      kind: manifest.kind,
      passed: cases.filter(testCase => testCase.status === 'passed').length,
      failed: cases.filter(testCase => testCase.status === 'failed').length,
      skipped: 0,
      snapshotUpdated,
      cases,
    };
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

function isRuntimeArtifact(kind: ArtifactKind): kind is ArtifactTestReport['kind'] {
  return kind === 'processor' || kind === 'plugin' || kind === 'resolver';
}

async function listCaseNames(testsDir: string): Promise<string[]> {
  if (!(await exists(testsDir))) {
    throw new Error(`Artifact tests directory not found: ${testsDir}`);
  }
  const entries = await readdir(testsDir, { withFileTypes: true });
  const cases = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  if (cases.length === 0) {
    throw new Error(`Artifact tests directory has no case folders: ${testsDir}`);
  }
  return cases;
}

async function loadArtifactTestCases(
  artifactDir: string,
  kind: ArtifactTestReport['kind'],
  testsDirOverride?: string,
): Promise<ArtifactCase[]> {
  const testManifestPath = join(artifactDir, 'cyan.test.yaml');
  if (!testsDirOverride && (await exists(testManifestPath))) {
    const manifest = YAML.parse(await readText(testManifestPath)) as unknown;
    return parseTestManifest(artifactDir, kind, manifest);
  }
  const ketoneTestManifestPath = join(artifactDir, 'test.cyan.yaml');
  if (!testsDirOverride && kind === 'resolver' && (await exists(ketoneTestManifestPath))) {
    const manifest = YAML.parse(await readText(ketoneTestManifestPath)) as unknown;
    return parseKetoneResolverTestManifest(artifactDir, manifest);
  }

  const testsDir = testsDirOverride ?? join(artifactDir, 'tests');
  const caseNames = await listCaseNames(testsDir);
  return caseNames.map(name => {
    const caseDir = join(testsDir, name);
    return kind === 'resolver'
      ? ({
          name,
          prior: join(caseDir, 'prior.txt'),
          current: join(caseDir, 'current.txt'),
          target: join(caseDir, 'target.txt'),
          expected: join(caseDir, 'expected.txt'),
          configFile: join(caseDir, 'config.json'),
          validations: [],
          commands: [],
        } satisfies ResolverArtifactCase)
      : ({
          name,
          input: join(caseDir, 'input'),
          expected: join(caseDir, 'expected'),
          configFile: join(caseDir, 'config.json'),
          validations: [],
          commands: [],
        } satisfies FileArtifactCase);
  });
}

function parseTestManifest(artifactDir: string, kind: ArtifactTestReport['kind'], input: unknown): ArtifactCase[] {
  if (!input || typeof input !== 'object') {
    throw new Error('cyan.test.yaml must contain a mapping.');
  }
  const rawCases = (input as { cases?: unknown }).cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error('cyan.test.yaml must contain at least one case.');
  }
  return rawCases.map((rawCase, index) => parseManifestCase(artifactDir, kind, rawCase, index));
}

function parseKetoneResolverTestManifest(artifactDir: string, input: unknown): ResolverArtifactCase[] {
  if (!input || typeof input !== 'object') {
    throw new Error('test.cyan.yaml must contain a mapping.');
  }
  const rawCases = (input as { tests?: unknown }).tests;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error('test.cyan.yaml must contain at least one test.');
  }
  return rawCases.map((rawCase, index) => {
    if (!rawCase || typeof rawCase !== 'object') {
      throw new Error(`test.cyan.yaml tests[${index}] must be a mapping.`);
    }
    const record = rawCase as Record<string, unknown>;
    const expected = readKetoneExpectedPath(artifactDir, record.expected, `tests[${index}].expected`);
    const rawInputs = record.resolver_inputs;
    if (!Array.isArray(rawInputs) || rawInputs.length === 0) {
      throw new Error(`tests[${index}].resolver_inputs must be a non-empty array.`);
    }
    return {
      name: readRequiredString(record.name, `tests[${index}].name`),
      expected,
      config: record.config,
      resolverInputs: rawInputs.map((rawInput, inputIndex) =>
        readKetoneResolverInput(artifactDir, rawInput, `tests[${index}].resolver_inputs[${inputIndex}]`),
      ),
      validations: [],
      commands: [],
    };
  });
}

function readKetoneExpectedPath(root: string, value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} must be a mapping.`);
  }
  const record = value as Record<string, unknown>;
  const nested = record.value;
  if (!nested || typeof nested !== 'object') {
    throw new Error(`${label}.value must be a mapping.`);
  }
  return readOptionalPath(root, (nested as Record<string, unknown>).path);
}

function readKetoneResolverInput(
  root: string,
  value: unknown,
  label: string,
): { path: string; origin: { template: string; layer: number } } {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} must be a mapping.`);
  }
  const record = value as Record<string, unknown>;
  const origin = record.origin;
  if (!origin || typeof origin !== 'object') {
    throw new Error(`${label}.origin must be a mapping.`);
  }
  const originRecord = origin as Record<string, unknown>;
  const layer = originRecord.layer;
  if (typeof layer !== 'number' || !Number.isInteger(layer)) {
    throw new Error(`${label}.origin.layer must be an integer.`);
  }
  return {
    path: readOptionalPath(root, record.path) ?? '',
    origin: {
      template: readRequiredString(originRecord.template, `${label}.origin.template`),
      layer,
    },
  };
}

function parseManifestCase(
  artifactDir: string,
  kind: ArtifactTestReport['kind'],
  rawCase: unknown,
  index: number,
): ArtifactCase {
  if (!rawCase || typeof rawCase !== 'object') {
    throw new Error(`cyan.test.yaml case ${index + 1} must be a mapping.`);
  }
  const record = rawCase as Record<string, unknown>;
  const name = readRequiredString(record.name, `cases[${index}].name`);
  const validations = readValidations(record.validations, `cases[${index}].validations`);
  const commands = readCommandValidations(record.commands, `cases[${index}].commands`);
  if (kind === 'resolver') {
    return {
      name,
      prior: readOptionalPath(artifactDir, record.prior),
      current: readOptionalPath(artifactDir, record.current),
      target: readOptionalPath(artifactDir, record.target),
      expected: readOptionalPath(artifactDir, record.expected),
      config: record.config,
      configFile: readOptionalPath(artifactDir, record.configFile),
      validations,
      commands,
    };
  }
  return {
    name,
    input: readOptionalPath(artifactDir, record.input) ?? safeJoin(artifactDir, `tests/${name}/input`),
    expected: readOptionalPath(artifactDir, record.expected),
    config: record.config,
    configFile: readOptionalPath(artifactDir, record.configFile),
    validations,
    commands,
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

function readValidations(value: unknown, label: string): TestValidation[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((rawValidation, index) => {
    if (!rawValidation || typeof rawValidation !== 'object') {
      throw new Error(`${label}[${index}] must be a mapping.`);
    }
    const record = rawValidation as Record<string, unknown>;
    return {
      path: readOptionalString(record.path, `${label}[${index}].path`),
      exists: readOptionalBoolean(record.exists, `${label}[${index}].exists`),
      equals: readOptionalString(record.equals, `${label}[${index}].equals`),
      contains: readOptionalString(record.contains, `${label}[${index}].contains`),
      notContains: readOptionalString(record.notContains, `${label}[${index}].notContains`),
    };
  });
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function artifactBundle(manifest: CyanManifest, runtimeFile: string): Promise<ArtifactBundleRef> {
  return {
    dependency: {
      kind: manifest.kind,
      owner: manifest.owner,
      name: manifest.name,
      version: manifest.version ?? 'local',
    },
    runtimeFile,
    integrity: sha256(await readText(runtimeFile)),
  };
}

async function buildRuntime(artifactDir: string, manifest: CyanManifest, runtimeDir: string): Promise<string> {
  const runtimeFile = join(runtimeDir, manifest.bundledEntry);
  await compileRuntimeBundle({
    entrypoint: join(artifactDir, manifest.entry),
    output: runtimeFile,
    kind: manifest.kind,
  });
  return runtimeFile;
}

async function runFileArtifactCase(
  bundle: ArtifactBundleRef,
  kind: 'processor' | 'plugin',
  testCase: FileArtifactCase,
  updateSnapshots: boolean,
): Promise<{ case: ArtifactTestCase; snapshotUpdated: boolean }> {
  try {
    const config = await readCaseConfig(testCase);
    const input = await readFileTree(testCase.input);
    const actual =
      kind === 'processor' ? await invokeProcessor(bundle, input, config) : await invokePlugin(bundle, input, config);
    const commandFailure = await runCommandsAgainstFiles(actual, testCase.commands);
    if (commandFailure) {
      return { case: { name: testCase.name, status: 'failed', message: commandFailure }, snapshotUpdated: false };
    }
    const validationFailure = validateFileOutput(actual, testCase.validations);
    if (validationFailure) {
      return { case: { name: testCase.name, status: 'failed', message: validationFailure }, snapshotUpdated: false };
    }

    if (updateSnapshots && testCase.expected) {
      await writeFileTree(testCase.expected, actual);
      return { case: { name: testCase.name, status: 'passed' }, snapshotUpdated: true };
    }

    if (testCase.expected) {
      const expected = await readFileTree(testCase.expected);
      const diff = compareFileTrees(expected, actual);
      if (diff) {
        return { case: { name: testCase.name, status: 'failed', message: diff }, snapshotUpdated: false };
      }
    } else if (testCase.validations.length === 0 && testCase.commands.length === 0) {
      return {
        case: { name: testCase.name, status: 'failed', message: 'Test case needs expected output or validations.' },
        snapshotUpdated: false,
      };
    }
    return { case: { name: testCase.name, status: 'passed' }, snapshotUpdated: false };
  } catch (error) {
    return { case: { name: testCase.name, status: 'failed', message: String(error) }, snapshotUpdated: false };
  }
}

async function runResolverCase(
  bundle: ArtifactBundleRef,
  testCase: ResolverArtifactCase,
  updateSnapshots: boolean,
): Promise<{ case: ArtifactTestCase; snapshotUpdated: boolean }> {
  try {
    if (testCase.resolverInputs) {
      return await runResolverFoldCase(bundle, testCase, updateSnapshots);
    }
    if (await isFolderResolverCase(testCase)) {
      return await runResolverFolderCase(bundle, testCase, updateSnapshots);
    }
    const config = await readCaseConfig(testCase);
    const path = isRecord(config) && typeof config.path === 'string' ? config.path : 'output.txt';
    const input = {
      files: [
        ...(testCase.prior && (await exists(testCase.prior))
          ? [{ path, content: await readText(testCase.prior), origin: { template: 'prior', layer: 0 } }]
          : []),
        ...(testCase.current && (await exists(testCase.current))
          ? [{ path, content: await readText(testCase.current), origin: { template: 'current', layer: 1 } }]
          : []),
        ...(testCase.target && (await exists(testCase.target))
          ? [{ path, content: await readText(testCase.target), origin: { template: 'target', layer: 2 } }]
          : []),
      ],
      config,
    };
    const actual = await invokeResolver(bundle, input);
    const commandFailure = await runCommandsAgainstText(actual, testCase.commands);
    if (commandFailure) {
      return { case: { name: testCase.name, status: 'failed', message: commandFailure }, snapshotUpdated: false };
    }
    const validationFailure = validateTextOutput(actual, testCase.validations);
    if (validationFailure) {
      return { case: { name: testCase.name, status: 'failed', message: validationFailure }, snapshotUpdated: false };
    }

    if (updateSnapshots && testCase.expected) {
      await writeText(testCase.expected, actual);
      return { case: { name: testCase.name, status: 'passed' }, snapshotUpdated: true };
    }

    if (testCase.expected) {
      const expected = await readText(testCase.expected);
      if (!fileContentsEqual(path, expected, actual)) {
        return {
          case: { name: testCase.name, status: 'failed', message: `Resolver output mismatch for ${testCase.name}` },
          snapshotUpdated: false,
        };
      }
    } else if (testCase.validations.length === 0 && testCase.commands.length === 0) {
      return {
        case: { name: testCase.name, status: 'failed', message: 'Test case needs expected output or validations.' },
        snapshotUpdated: false,
      };
    }
    return { case: { name: testCase.name, status: 'passed' }, snapshotUpdated: false };
  } catch (error) {
    return { case: { name: testCase.name, status: 'failed', message: String(error) }, snapshotUpdated: false };
  }
}

async function runResolverFoldCase(
  bundle: ArtifactBundleRef,
  testCase: ResolverArtifactCase,
  updateSnapshots: boolean,
): Promise<{ case: ArtifactTestCase; snapshotUpdated: boolean }> {
  const config = await readCaseConfig(testCase);
  const groups = new Map<
    string,
    Array<{ path: string; content: string; origin: { template: string; layer: number } }>
  >();
  for (const input of testCase.resolverInputs ?? []) {
    const files = await readResolverInputFiles(input.path);
    for (const file of files) {
      const current = groups.get(file.path) ?? [];
      current.push({ path: file.path, content: file.content ?? '', origin: input.origin });
      groups.set(file.path, current);
    }
  }
  const actual: VfsFile[] = [];
  for (const [path, files] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    actual.push({
      path,
      content: await invokeResolver(bundle, {
        files,
        config: { path, ...(isRecord(config) ? config : {}) },
      }),
    });
  }
  const commandFailure = await runCommandsAgainstFiles(actual, testCase.commands);
  if (commandFailure) {
    return { case: { name: testCase.name, status: 'failed', message: commandFailure }, snapshotUpdated: false };
  }
  const validationFailure = validateFileOutput(actual, testCase.validations);
  if (validationFailure) {
    return { case: { name: testCase.name, status: 'failed', message: validationFailure }, snapshotUpdated: false };
  }
  if (updateSnapshots && testCase.expected) {
    await writeFileTree(testCase.expected, actual);
    return { case: { name: testCase.name, status: 'passed' }, snapshotUpdated: true };
  }
  if (testCase.expected) {
    const expected = await readFileTree(testCase.expected);
    const diff = compareFileTrees(expected, actual);
    if (diff) {
      return { case: { name: testCase.name, status: 'failed', message: diff }, snapshotUpdated: false };
    }
  } else if (testCase.validations.length === 0 && testCase.commands.length === 0) {
    return {
      case: { name: testCase.name, status: 'failed', message: 'Test case needs expected output or validations.' },
      snapshotUpdated: false,
    };
  }
  return { case: { name: testCase.name, status: 'passed' }, snapshotUpdated: false };
}

async function readResolverInputFiles(path: string): Promise<VfsFile[]> {
  if (await isDirectory(path)) {
    return await readFileTree(path);
  }
  return [{ path: basename(path), content: await readText(path) }];
}

async function runResolverFolderCase(
  bundle: ArtifactBundleRef,
  testCase: ResolverArtifactCase,
  updateSnapshots: boolean,
): Promise<{ case: ArtifactTestCase; snapshotUpdated: boolean }> {
  const config = await readCaseConfig(testCase);
  const prior = testCase.prior && (await isDirectory(testCase.prior)) ? await readFileTree(testCase.prior) : [];
  const current = testCase.current && (await isDirectory(testCase.current)) ? await readFileTree(testCase.current) : [];
  const target = testCase.target && (await isDirectory(testCase.target)) ? await readFileTree(testCase.target) : [];
  const priorMap = new Map(prior.map(file => [file.path, file.content ?? '']));
  const currentMap = new Map(current.map(file => [file.path, file.content ?? '']));
  const targetMap = new Map(target.map(file => [file.path, file.content ?? '']));
  const paths = [...new Set([...priorMap.keys(), ...currentMap.keys(), ...targetMap.keys()])].sort();
  const actual: VfsFile[] = [];
  for (const path of paths) {
    const files = [
      ...(priorMap.has(path)
        ? [{ path, content: priorMap.get(path) ?? '', origin: { template: 'prior', layer: 0 } }]
        : []),
      ...(currentMap.has(path)
        ? [{ path, content: currentMap.get(path) ?? '', origin: { template: 'current', layer: 1 } }]
        : []),
      ...(targetMap.has(path)
        ? [{ path, content: targetMap.get(path) ?? '', origin: { template: 'target', layer: 2 } }]
        : []),
    ];
    actual.push({
      path,
      content: await invokeResolver(bundle, {
        files,
        config: { path, ...(isRecord(config) ? config : {}) },
      }),
    });
  }
  const commandFailure = await runCommandsAgainstFiles(actual, testCase.commands);
  if (commandFailure) {
    return { case: { name: testCase.name, status: 'failed', message: commandFailure }, snapshotUpdated: false };
  }
  const validationFailure = validateFileOutput(actual, testCase.validations);
  if (validationFailure) {
    return { case: { name: testCase.name, status: 'failed', message: validationFailure }, snapshotUpdated: false };
  }
  if (updateSnapshots && testCase.expected) {
    await writeFileTree(testCase.expected, actual);
    return { case: { name: testCase.name, status: 'passed' }, snapshotUpdated: true };
  }
  if (testCase.expected) {
    const expected = await readFileTree(testCase.expected);
    const diff = compareFileTrees(expected, actual);
    if (diff) {
      return { case: { name: testCase.name, status: 'failed', message: diff }, snapshotUpdated: false };
    }
  } else if (testCase.validations.length === 0 && testCase.commands.length === 0) {
    return {
      case: { name: testCase.name, status: 'failed', message: 'Test case needs expected output or validations.' },
      snapshotUpdated: false,
    };
  }
  return { case: { name: testCase.name, status: 'passed' }, snapshotUpdated: false };
}

async function isFolderResolverCase(testCase: ResolverArtifactCase): Promise<boolean> {
  return Boolean(
    (testCase.prior && (await isDirectory(testCase.prior))) ||
    (testCase.current && (await isDirectory(testCase.current))) ||
    (testCase.target && (await isDirectory(testCase.target))) ||
    (testCase.expected && (await isDirectory(testCase.expected))),
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

async function readCaseConfig(testCase: { config?: unknown; configFile?: string }): Promise<unknown> {
  if (testCase.config !== undefined && testCase.configFile) {
    throw new Error('Use either config or configFile, not both.');
  }
  if (testCase.config !== undefined) {
    return testCase.config;
  }
  if (!testCase.configFile || !(await exists(testCase.configFile))) {
    return undefined;
  }
  const raw = await readText(testCase.configFile);
  if (testCase.configFile.endsWith('.yaml') || testCase.configFile.endsWith('.yml')) {
    return YAML.parse(raw) as unknown;
  }
  return JSON.parse(raw) as unknown;
}

async function runCommandsAgainstFiles(files: VfsFile[], commands: CommandValidation[]): Promise<string | undefined> {
  if (commands.length === 0) {
    return undefined;
  }
  const root = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-command-'));
  try {
    await writeFileTree(root, files);
    return await runCommandValidations(root, commands);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCommandsAgainstText(output: string, commands: CommandValidation[]): Promise<string | undefined> {
  if (commands.length === 0) {
    return undefined;
  }
  const root = await mkdtemp(join(tmpdir(), 'cyanprint-resolver-command-'));
  try {
    await writeText(join(root, 'output.txt'), output);
    return await runCommandValidations(root, commands);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function validateFileOutput(files: VfsFile[], validations: TestValidation[]): string | undefined {
  const fileMap = new Map(files.map(file => [file.path, file.content ?? '']));
  for (const validation of validations) {
    if (!validation.path) {
      return 'File output validations require path.';
    }
    const content = fileMap.get(validation.path);
    const message = validateTextContent(content, validation, validation.path);
    if (message) {
      return message;
    }
  }
  return undefined;
}

function validateTextOutput(output: string, validations: TestValidation[]): string | undefined {
  for (const validation of validations) {
    if (validation.path) {
      return 'Resolver validations do not support path.';
    }
    const message = validateTextContent(output, validation, 'resolver output');
    if (message) {
      return message;
    }
  }
  return undefined;
}

function validateTextContent(
  content: string | undefined,
  validation: TestValidation,
  label: string,
): string | undefined {
  if (validation.exists === false && content !== undefined) {
    return `${label} exists but should not.`;
  }
  if (validation.exists !== false && content === undefined) {
    return `${label} does not exist.`;
  }
  if (content === undefined) {
    return undefined;
  }
  if (validation.equals !== undefined && content !== validation.equals) {
    return `${label} did not equal expected text.`;
  }
  if (validation.contains !== undefined && !content.includes(validation.contains)) {
    return `${label} did not contain expected text.`;
  }
  if (validation.notContains !== undefined && content.includes(validation.notContains)) {
    return `${label} contained forbidden text.`;
  }
  return undefined;
}

async function readFileTree(root: string): Promise<VfsFile[]> {
  const files: VfsFile[] = [];
  await walk(root, async path => {
    files.push({
      path: relative(root, path),
      content: await readText(path),
    });
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeFileTree(root: string, files: VfsFile[]): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const file of files) {
    await mkdir(dirname(safeJoin(root, file.path)), { recursive: true });
    await writeText(safeJoin(root, file.path), file.content ?? '');
  }
}

async function walk(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  if (!(await exists(root))) {
    throw new Error(`Expected directory not found: ${root}`);
  }
  const stats = await stat(root);
  if (!stats.isDirectory()) {
    throw new Error(`Expected directory: ${root}`);
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    }
  }
}

function compareFileTrees(expected: VfsFile[], actual: VfsFile[]): string | undefined {
  const expectedMap = new Map(expected.map(file => [file.path, file.content ?? '']));
  const actualMap = new Map(actual.map(file => [file.path, file.content ?? '']));
  for (const path of [...expectedMap.keys()].sort()) {
    if (!actualMap.has(path)) {
      return `Missing output file: ${path}`;
    }
    if (!fileContentsEqual(path, expectedMap.get(path) ?? '', actualMap.get(path) ?? '')) {
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

function fileContentsEqual(path: string, expected: string, actual: string): boolean {
  if (path.endsWith('.json')) {
    const expectedJson = parseJson(expected);
    const actualJson = parseJson(actual);
    if (expectedJson !== undefined && actualJson !== undefined) {
      return canonicalJson(expectedJson) === canonicalJson(actualJson);
    }
  }
  return normalizeSnapshotText(expected) === normalizeSnapshotText(actual);
}

function parseJson(content: string): unknown | undefined {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeSnapshotText(content: string): string {
  return content.replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
}
