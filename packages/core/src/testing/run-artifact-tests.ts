import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import YAML from 'yaml';
import { compileRuntimeBundle } from '@cyanprint/artifact-bundler';
import {
  invokePlugin,
  invokeProcessor,
  invokeResolver,
  type ArtifactBundleRef,
  type ResolvedFile,
} from '@cyanprint/artifact-runner';
import type { ArtifactKind, CyanManifest, FileOrigin, VfsFile } from '@cyanprint/contracts';
import { loadManifest } from '../manifest/load-manifest';
import { comparePaths, exists, isRecord, mapWithConcurrency, readText, safeJoin, sha256, writeText } from '../util';
import { readCommandValidations, runCommandValidations, type CommandValidation } from './command-validations';

type ArtifactTestCase = {
  name: string;
  status: 'passed' | 'failed';
  message?: string;
};

type FileArtifactCase = {
  name: string;
  input: string;
  expected?: string;
  config?: unknown;
  configFile?: string;
  validations: CommandValidation[];
};

/** A resolver variation: one contributor's file (or folder of files) plus its origin. */
type ResolverVariation = {
  path: string;
  origin: FileOrigin;
};

/**
 * Resolver tests use the global input shape: a list of variations with origins, all
 * passed to the resolver in one call per path.
 */
type ResolverArtifactCase = {
  name: string;
  variations?: ResolverVariation[];
  expected?: string;
  config?: unknown;
  configFile?: string;
  validations: CommandValidation[];
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
  concurrency?: number;
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
    const update = Boolean(args.updateSnapshots);
    const results = await mapWithConcurrency(testCases, args.concurrency ?? 1, testCase =>
      manifest.kind === 'resolver'
        ? runResolverCase(bundle, testCase as ResolverArtifactCase, update)
        : runFileArtifactCase(bundle, manifest.kind as 'processor' | 'plugin', testCase as FileArtifactCase, update),
    );
    const cases = results.map(result => result.case);

    return {
      kind: manifest.kind,
      passed: cases.filter(testCase => testCase.status === 'passed').length,
      failed: cases.filter(testCase => testCase.status === 'failed').length,
      skipped: 0,
      snapshotUpdated: results.filter(result => result.snapshotUpdated).length,
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
  const cases: ArtifactCase[] = [];
  for (const name of caseNames) {
    const caseDir = join(testsDir, name);
    if (kind === 'resolver') {
      cases.push({
        name,
        variations: await conventionResolverVariations(caseDir),
        expected: join(caseDir, 'expected'),
        configFile: join(caseDir, 'config.json'),
        validations: [],
      } satisfies ResolverArtifactCase);
    } else {
      cases.push({
        name,
        input: join(caseDir, 'input'),
        expected: join(caseDir, 'expected'),
        configFile: join(caseDir, 'config.json'),
        validations: [],
      } satisfies FileArtifactCase);
    }
  }
  return cases;
}

/** Convention resolver case: `input-<n>` file/folder variations, layered by `n`. */
async function conventionResolverVariations(caseDir: string): Promise<ResolverVariation[]> {
  const entries = await readdir(caseDir, { withFileTypes: true }).catch(() => []);
  const inputs = entries
    .map(entry => entry.name)
    .filter(name => /^input-\d+(\.\w+)?$/.test(name))
    .sort();
  return inputs.map((name, index) => ({
    path: join(caseDir, name),
    origin: { template: name.replace(/\.\w+$/, ''), layer: index },
  }));
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
      variations: rawInputs.map((rawInput, inputIndex) =>
        readResolverVariation(artifactDir, rawInput, `tests[${index}].resolver_inputs[${inputIndex}]`),
      ),
      validations: [],
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

function readResolverVariation(root: string, value: unknown, label: string): ResolverVariation {
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
  const processor = originRecord.processor;
  let processorOrigin: FileOrigin['processor'];
  if (processor !== undefined) {
    if (!isRecord(processor) || typeof processor.ref !== 'string' || typeof processor.invocation !== 'number') {
      throw new Error(`${label}.origin.processor must be { ref, invocation }.`);
    }
    processorOrigin = { ref: processor.ref, invocation: processor.invocation };
  }
  return {
    path: readOptionalPath(root, record.path) ?? '',
    origin: {
      template: readRequiredString(originRecord.template, `${label}.origin.template`),
      layer,
      ...(processorOrigin ? { processor: processorOrigin } : {}),
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
  rejectRemovedTestField(record, 'commands', `cases[${index}].commands`);
  rejectRemovedTestField(record, 'snapshot', `cases[${index}].snapshot`);
  const name = readRequiredString(record.name, `cases[${index}].name`);
  const validations = readCommandValidations(record.validations, `cases[${index}].validations`);
  if (kind === 'resolver') {
    for (const removed of ['prior', 'current', 'target'] as const) {
      if (record[removed] !== undefined) {
        throw new Error(
          `cases[${index}].${removed} is no longer supported. Resolver tests use variations: a list of { path, origin } entries — all variations reach the resolver in one call.`,
        );
      }
    }
    const variations = Array.isArray(record.variations)
      ? record.variations.map((input, inputIndex) =>
          readResolverVariation(artifactDir, input, `cases[${index}].variations[${inputIndex}]`),
        )
      : undefined;
    return {
      name,
      variations,
      expected: readOptionalPath(artifactDir, record.expected),
      config: record.config,
      configFile: readOptionalPath(artifactDir, record.configFile),
      validations,
    };
  }
  return {
    name,
    input: readOptionalPath(artifactDir, record.input) ?? safeJoin(artifactDir, `tests/${name}/input`),
    expected: readOptionalPath(artifactDir, record.expected),
    config: record.config,
    configFile: readOptionalPath(artifactDir, record.configFile),
    validations,
  };
}

function rejectRemovedTestField(record: Record<string, unknown>, field: string, label: string): void {
  if (record[field] !== undefined) {
    throw new Error(`${label} is no longer supported. Use validations instead.`);
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
    validateExport: false,
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

    if (!testCase.expected) {
      return {
        case: { name: testCase.name, status: 'failed', message: 'Test case needs expected output.' },
        snapshotUpdated: false,
      };
    }
    if (!updateSnapshots) {
      const expected = await readFileTree(testCase.expected);
      const diff = compareFileTrees(expected, actual);
      if (diff) {
        return { case: { name: testCase.name, status: 'failed', message: diff }, snapshotUpdated: false };
      }
    }

    const validationFailure = await runCommandsAgainstFiles(actual, testCase.validations);
    if (validationFailure) {
      return { case: { name: testCase.name, status: 'failed', message: validationFailure }, snapshotUpdated: false };
    }
    if (updateSnapshots && testCase.expected) {
      await writeFileTree(testCase.expected, actual);
    }
    return {
      case: { name: testCase.name, status: 'passed' },
      snapshotUpdated: Boolean(updateSnapshots && testCase.expected),
    };
  } catch (error) {
    return { case: { name: testCase.name, status: 'failed', message: String(error) }, snapshotUpdated: false };
  }
}

/**
 * Run a resolver case with the global input shape: variations are grouped per path and
 * the resolver receives every variation of a path in a single call.
 */
async function runResolverCase(
  bundle: ArtifactBundleRef,
  testCase: ResolverArtifactCase,
  updateSnapshots: boolean,
): Promise<{ case: ArtifactTestCase; snapshotUpdated: boolean }> {
  try {
    if (!testCase.variations || testCase.variations.length === 0) {
      return {
        case: {
          name: testCase.name,
          status: 'failed',
          message: 'Resolver test case needs variations: a list of { path, origin } entries.',
        },
        snapshotUpdated: false,
      };
    }
    const config = await readCaseConfig(testCase);
    const configRecord = isRecord(config) ? config : {};
    const groups = new Map<string, ResolvedFile[]>();
    for (const variation of testCase.variations) {
      const files = await readResolverVariationFiles(variation.path);
      for (const file of files) {
        const current = groups.get(file.path) ?? [];
        current.push({ path: file.path, content: file.content ?? '', origin: variation.origin });
        groups.set(file.path, current);
      }
    }
    const actual: VfsFile[] = [];
    for (const [path, files] of [...groups.entries()].sort(([left], [right]) => comparePaths(left, right))) {
      const output = await invokeResolver(bundle, { config: configRecord, files });
      actual.push({ path, content: output.content });
    }

    if (!testCase.expected) {
      return {
        case: { name: testCase.name, status: 'failed', message: 'Test case needs expected output.' },
        snapshotUpdated: false,
      };
    }
    const expectedIsDir = await isDirectory(testCase.expected);
    if (!updateSnapshots) {
      if (expectedIsDir || actual.length > 1) {
        const expected = await readFileTree(testCase.expected);
        const diff = compareFileTrees(expected, actual);
        if (diff) {
          return { case: { name: testCase.name, status: 'failed', message: diff }, snapshotUpdated: false };
        }
      } else {
        const expected = await readText(testCase.expected);
        if (expected !== (actual[0]?.content ?? '')) {
          return {
            case: { name: testCase.name, status: 'failed', message: `Resolver output mismatch for ${testCase.name}` },
            snapshotUpdated: false,
          };
        }
      }
    }
    const validationFailure = await runCommandsAgainstFiles(actual, testCase.validations);
    if (validationFailure) {
      return { case: { name: testCase.name, status: 'failed', message: validationFailure }, snapshotUpdated: false };
    }
    if (updateSnapshots && testCase.expected) {
      if (expectedIsDir || actual.length > 1) {
        await writeFileTree(testCase.expected, actual);
      } else {
        await writeText(testCase.expected, actual[0]?.content ?? '');
      }
    }
    return {
      case: { name: testCase.name, status: 'passed' },
      snapshotUpdated: Boolean(updateSnapshots && testCase.expected),
    };
  } catch (error) {
    return { case: { name: testCase.name, status: 'failed', message: String(error) }, snapshotUpdated: false };
  }
}

async function readResolverVariationFiles(path: string): Promise<VfsFile[]> {
  if (await isDirectory(path)) {
    return await readFileTree(path);
  }
  return [{ path: basename(path), content: await readText(path) }];
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

async function readFileTree(root: string): Promise<VfsFile[]> {
  const files: VfsFile[] = [];
  await walk(root, async path => {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const encodedContent = new TextEncoder().encode(content);
    files.push({
      path: relative(root, path),
      ...(bytesEqual(bytes, encodedContent) ? { content } : { bytesBase64: Buffer.from(bytes).toString('base64') }),
    });
  });
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

async function writeFileTree(root: string, files: VfsFile[]): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const file of files) {
    const target = safeJoin(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, fileToBytes(file));
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
  const expectedMap = new Map(expected.map(file => [file.path, fileToBytes(file)]));
  const actualMap = new Map(actual.map(file => [file.path, fileToBytes(file)]));
  for (const path of [...expectedMap.keys()].sort()) {
    if (!actualMap.has(path)) {
      return `Missing output file: ${path}`;
    }
    if (!bytesEqual(expectedMap.get(path) ?? new Uint8Array(), actualMap.get(path) ?? new Uint8Array())) {
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

function fileToBytes(file: VfsFile): Uint8Array {
  if (file.bytesBase64 !== undefined) {
    return Buffer.from(file.bytesBase64, 'base64');
  }
  return new TextEncoder().encode(file.content ?? '');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return left.every((byte, index) => byte === right[index]);
}
