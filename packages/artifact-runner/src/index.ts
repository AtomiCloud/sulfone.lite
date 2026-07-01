import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, parse, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertRuntimeExportArity, type ArtifactDependency, type VfsFile } from '@cyanprint/contracts';
import { overlayFiles, readVfsFiles, safeJoin, writeVfsFiles } from './fs-utils';
import { createPluginHelper, createProcessorFsHelper } from './helpers';
import { foldResolverCandidates } from './resolver-fold';
import { assertResolverCommutative } from './testing';
import type { Plugin, Processor, ResolvedFile, Resolver } from './sdk-types';

type MaybePromise<T> = T | Promise<T>;

/** Candidate file passed by the runtime into a resolver merge. */
export type ResolverFile = {
  path: string;
  content: string;
  origin: {
    template: string;
    layer: number;
  };
  files?: VfsFile[];
};

// Legacy (api: 1) folder-fold resolver shapes. New resolvers use the SDK two-file API.
type LegacyResolverFolderInput = {
  inputDirs: Array<{
    dir: string;
    origin: {
      template: string;
      layer: number;
    };
  }>;
  outputDir: string;
  files: ResolverFile[];
  config?: unknown;
};

type LegacyResolverOutput = void | string | { path?: string; content: string };

type LegacyResolver = (input: LegacyResolverFolderInput) => MaybePromise<LegacyResolverOutput>;

const resolverSymbol = Symbol.for('cyanprint.resolver');
const runtimeExportCache = new Map<string, unknown>();
const legacyResolverExports = new WeakSet<Function>();

function resolverGlobal(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

export async function loadArtifactExport<T>(path: string, exportName: string, cacheKey?: string): Promise<T> {
  const sourcePath = path.startsWith('file:') ? fileURLToPath(path) : path;
  const importPath = cacheKey ? await materializeImportPath(sourcePath, cacheKey) : sourcePath;
  const url = pathToFileURL(importPath);
  const runtimeExportCacheKey = `${url.href}:${exportName}`;
  if (runtimeExportCache.has(runtimeExportCacheKey)) {
    return runtimeExportCache.get(runtimeExportCacheKey) as T;
  }
  delete resolverGlobal()[resolverSymbol];
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(url.href)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to load artifact bundle ${path}: ${errorMessage(error)}`);
  }
  const registeredResolver = exportName === 'resolver' ? resolverGlobal()[resolverSymbol] : undefined;
  const exported = loaded[exportName] ?? registeredResolver;
  if (!exported) {
    throw new Error(`Artifact bundle ${path} has no ${exportName} export`);
  }
  if (typeof exported !== 'function') {
    throw new Error(
      `Artifact bundle ${path} expected ${exportName} to be a function. ` +
        `Use "export function ${exportName}(input)".`,
    );
  }
  const isRegisteredLegacyResolver = exportName === 'resolver' && exported === registeredResolver;
  assertRuntimeExportArity({
    declaredParameterCount: exported.length,
    exportName,
    isRegisteredLegacyResolver,
    label: `Artifact bundle ${path}`,
  });
  if (isRegisteredLegacyResolver) {
    legacyResolverExports.add(exported);
  }
  runtimeExportCache.set(runtimeExportCacheKey, exported);
  return exported as T;
}

async function materializeImportPath(path: string, cacheKey: string): Promise<string> {
  const sourceDir = dirname(path);
  const importsRoot = join(tmpdir(), 'cyanprint-artifact-imports');
  const targetDir = join(importsRoot, cacheKey);
  await cleanStaleImportDirs(importsRoot, cacheKey);
  await mkdir(targetDir, { recursive: true });
  if (isSourceRuntime(path)) {
    const sourceRoot = await findSourceRuntimeRoot(path);
    await copySourceRuntimeFiles(sourceRoot, targetDir);
  } else {
    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
      if (entry.name === basename(path)) {
        continue;
      }
      await symlink(join(sourceDir, entry.name), join(targetDir, entry.name)).catch(() => undefined);
    }
  }
  const nearestNodeModules = await findNearestNodeModules(sourceDir);
  if (nearestNodeModules) {
    await symlink(nearestNodeModules, join(targetDir, 'node_modules')).catch(() => undefined);
  }
  const parsed = parse(path);
  const target = isSourceRuntime(path)
    ? join(targetDir, relative(await findSourceRuntimeRoot(path), path))
    : join(targetDir, `${parsed.name}-${cacheKey}${parsed.ext || '.js'}`);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(path, target);
  return target;
}

// Materialized import dirs are content-hash keyed and never reused after the artifact changes,
// so they accrete for the life of the OS temp dir. Sweep entries untouched for a day.
const STALE_IMPORT_DIR_MS = 24 * 60 * 60 * 1000;

async function cleanStaleImportDirs(importsRoot: string, keepKey: string): Promise<void> {
  const entries = await readdir(importsRoot, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - STALE_IMPORT_DIR_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepKey) {
      continue;
    }
    const dir = join(importsRoot, entry.name);
    const info = await stat(dir).catch(() => undefined);
    if (info && info.mtimeMs < cutoff) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function copySourceRuntimeFiles(sourceRoot: string, targetRoot: string): Promise<void> {
  for (const path of await listSourceRuntimeFiles(sourceRoot)) {
    const target = join(targetRoot, relative(sourceRoot, path));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(path, target);
  }
}

async function findNearestNodeModules(start: string): Promise<string | undefined> {
  let current = start;
  while (true) {
    const candidate = join(current, 'node_modules');
    if ((await stat(candidate).catch(() => undefined))?.isDirectory()) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export type ArtifactBundleRef = {
  dependency: ArtifactDependency;
  runtimeFile: string;
  integrity?: string;
  /** Resolver runtime API version: 1 = legacy folder-fold (default), 2 = two-file merge. */
  api?: 1 | 2;
};

async function verifyBundleIntegrity(bundle: ArtifactBundleRef): Promise<string> {
  const entryHash = createHash('sha256')
    .update(await readFile(bundle.runtimeFile))
    .digest('hex');
  if (bundle.integrity && entryHash !== bundle.integrity) {
    throw new Error(`Bundle integrity mismatch for ${bundle.dependency.kind}:${bundle.dependency.name}`);
  }
  return isSourceRuntime(bundle.runtimeFile) ? await sourceRuntimeCacheKey(bundle.runtimeFile, entryHash) : entryHash;
}

function isSourceRuntime(path: string): boolean {
  return extname(path) === '.ts' || extname(path) === '.tsx';
}

async function sourceRuntimeCacheKey(entrypoint: string, entryHash: string): Promise<string> {
  const sourceRoot = await findSourceRuntimeRoot(entrypoint);
  const hash = createHash('sha256');
  hash.update(entrypoint);
  hash.update('\0');
  hash.update(entryHash);
  for (const path of await listSourceRuntimeFiles(sourceRoot)) {
    hash.update('\0');
    hash.update(relative(sourceRoot, path));
    hash.update('\0');
    hash.update(await readFile(path));
  }
  return hash.digest('hex');
}

async function findSourceRuntimeRoot(entrypoint: string): Promise<string> {
  let current = dirname(entrypoint);
  while (true) {
    if ((await stat(join(current, 'cyan.yaml')).catch(() => undefined))?.isFile()) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return dirname(entrypoint);
    }
    current = parent;
  }
}

async function listSourceRuntimeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await collectSourceRuntimeFiles(root, files);
  return files.sort();
}

async function collectSourceRuntimeFiles(root: string, files: string[]): Promise<void> {
  const info = await stat(root).catch(() => undefined);
  if (!info?.isDirectory()) {
    return;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectSourceRuntimeFiles(path, files);
    } else if (entry.isFile() && ['.ts', '.tsx', '.js', '.mjs', '.json'].includes(extname(entry.name))) {
      files.push(path);
    }
  }
}

export async function invokeProcessor(
  bundle: ArtifactBundleRef,
  files: VfsFile[],
  config?: unknown,
  options: { preservePrevious?: boolean } = {},
): Promise<VfsFile[]> {
  const cacheKey = await verifyBundleIntegrity(bundle);
  const processor = await loadArtifactExport<Processor>(bundle.runtimeFile, 'processor', cacheKey);
  return await invokeFolderArtifact({
    files,
    options,
    tempPrefix: 'cyanprint-processor-',
    invoke: async ({ inputDir, outputDir }) => {
      const helper = createProcessorFsHelper({ inputDir, outputDir, config });
      await processor({ inputDir, outputDir, config }, helper);
    },
  });
}

export async function invokePlugin(
  bundle: ArtifactBundleRef,
  files: VfsFile[],
  config?: unknown,
  options: { preservePrevious?: boolean } = {},
): Promise<VfsFile[]> {
  const cacheKey = await verifyBundleIntegrity(bundle);
  const plugin = await loadArtifactExport<Plugin>(bundle.runtimeFile, 'plugin', cacheKey);
  return await invokeFolderArtifact({
    files,
    options,
    tempPrefix: 'cyanprint-plugin-',
    seedOutput: true,
    invoke: async ({ inputDir, outputDir }) => {
      const helper = createPluginHelper({ inputDir, outputDir, dir: outputDir, config });
      await plugin({ inputDir, outputDir, dir: outputDir, config }, helper);
    },
  });
}

export async function invokeResolver(
  bundle: ArtifactBundleRef,
  input: { files: ResolverFile[]; config?: unknown },
): Promise<string> {
  const cacheKey = await verifyBundleIntegrity(bundle);
  if ((bundle.api ?? 1) === 2) {
    return await invokeTwoFileResolver(bundle, input, cacheKey);
  }
  return await invokeLegacyFolderResolver(bundle, input, cacheKey);
}

async function invokeTwoFileResolver(
  bundle: ArtifactBundleRef,
  input: { files: ResolverFile[]; config?: unknown },
  cacheKey: string,
): Promise<string> {
  const resolver = await loadArtifactExport<Resolver>(bundle.runtimeFile, 'resolver', cacheKey);
  const candidates: ResolvedFile[] = input.files.map(file => ({
    path: file.path,
    content: file.content,
    origin: file.origin,
  }));
  const output = await foldResolverCandidates(resolver, {
    path: readConfigPath(input.config),
    config: readConfigRecord(input.config),
    candidates,
  });
  return output.content;
}

/**
 * Enforce a resolver's declared commutativity (api: 2 only). Loads the resolver and
 * verifies that merging every candidate pair is order-independent. Throws on divergence.
 */
export async function assertResolverCommutativity(
  bundle: ArtifactBundleRef,
  args: { path: string; config: Record<string, unknown>; candidates: ResolvedFile[] },
): Promise<void> {
  const cacheKey = await verifyBundleIntegrity(bundle);
  const resolver = await loadArtifactExport<Resolver>(bundle.runtimeFile, 'resolver', cacheKey);
  await assertResolverCommutative(resolver, args);
}

async function invokeLegacyFolderResolver(
  bundle: ArtifactBundleRef,
  input: { files: ResolverFile[]; config?: unknown },
  cacheKey: string,
): Promise<string> {
  const resolver = await loadArtifactExport<LegacyResolver>(bundle.runtimeFile, 'resolver', cacheKey);
  const { container, root } = await mkTempRoot('cyanprint-resolver-');
  const containerGuard = await captureTempRoot(container);
  const rootGuard = await captureTempRoot(root);
  try {
    const inputDirs = [];
    for (const [index, file] of input.files.entries()) {
      const dir = join(root, `input-${index}`);
      await writeVfsFiles(dir, file.files ?? [{ path: file.path, content: file.content }]);
      inputDirs.push({ dir, origin: file.origin });
    }
    const outputDir = join(root, 'output');
    await mkdir(outputDir, { recursive: true });
    const result = await resolver({ inputDirs, outputDir, files: input.files, config: input.config });
    const acceptsLegacyReturn = legacyResolverExports.has(resolver);
    if (typeof result === 'string') {
      if (!acceptsLegacyReturn) {
        throw new Error(`Resolver ${bundle.dependency.name} must write output files instead of returning content`);
      }
      await assertResolverSandbox({ containerGuard, rootGuard, container, root, outputDir });
      return result;
    }
    if (result && typeof result === 'object' && 'content' in result && typeof result.content === 'string') {
      if (!acceptsLegacyReturn) {
        throw new Error(`Resolver ${bundle.dependency.name} must write output files instead of returning content`);
      }
      await assertResolverSandbox({ containerGuard, rootGuard, container, root, outputDir });
      return result.content;
    }
    const path = readConfigPath(input.config);
    await assertResolverSandbox({ containerGuard, rootGuard, container, root, outputDir });
    const outputPath = safeJoin(outputDir, path);
    const bytes = await readFile(outputPath).catch(() => undefined);
    if (!bytes) {
      throw new Error(`Resolver ${bundle.dependency.name} did not write output file: ${path}`);
    }
    return new TextDecoder().decode(bytes);
  } finally {
    await rm(container, { recursive: true, force: true });
  }
}

async function assertResolverSandbox(args: {
  containerGuard: TempRootGuard;
  rootGuard: TempRootGuard;
  container: string;
  root: string;
  outputDir: string;
}): Promise<void> {
  await assertTempRoot(args.containerGuard);
  await assertTempRoot(args.rootGuard);
  await assertNoSandboxEscapes(args.container, entryName => entryName === 'work');
  await assertNoSandboxEscapes(args.root, entryName => entryName === 'output' || /^input-\d+$/.test(entryName));
  await assertManagedDirectory(args.root, args.outputDir, 'output');
}

async function invokeFolderArtifact(args: {
  files: VfsFile[];
  options: { preservePrevious?: boolean };
  tempPrefix: string;
  seedOutput?: boolean;
  invoke: (dirs: { inputDir: string; outputDir: string }) => Promise<void>;
}): Promise<VfsFile[]> {
  const { container, root } = await mkTempRoot(args.tempPrefix);
  const containerGuard = await captureTempRoot(container);
  const rootGuard = await captureTempRoot(root);
  try {
    const inputDir = join(root, 'input');
    const outputDir = join(root, 'output');
    await writeVfsFiles(inputDir, args.files);
    if (args.seedOutput) {
      await writeVfsFiles(outputDir, args.files);
    } else {
      await mkdir(outputDir, { recursive: true });
    }
    await args.invoke({ inputDir, outputDir });
    await assertTempRoot(containerGuard);
    await assertTempRoot(rootGuard);
    await assertNoSandboxEscapes(container, entryName => entryName === 'work');
    await assertNoSandboxEscapes(root, entryName => entryName === 'input' || entryName === 'output');
    await assertManagedDirectory(root, inputDir, 'input');
    await assertManagedDirectory(root, outputDir, 'output');
    const output = await readVfsFiles(outputDir);
    return args.options.preservePrevious ? overlayFiles(args.files, output) : output;
  } finally {
    await rm(container, { recursive: true, force: true });
  }
}

async function mkTempRoot(prefix: string): Promise<{ container: string; root: string }> {
  const container = await mkdtemp(join(tmpdir(), `${prefix}container-`));
  const root = join(container, 'work');
  await mkdir(root);
  return { container, root };
}

type TempRootGuard = {
  root: string;
  real: string;
  dev: number;
  ino: number;
};

async function captureTempRoot(root: string): Promise<TempRootGuard> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('unsafe temp root');
  }
  return { root, real: await realpath(root), dev: info.dev, ino: info.ino };
}

async function assertTempRoot(guard: TempRootGuard): Promise<void> {
  const info = await lstat(guard.root).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink() || info.dev !== guard.dev || info.ino !== guard.ino) {
    throw new Error('unsafe temp root');
  }
  if ((await realpath(guard.root)) !== guard.real) {
    throw new Error('unsafe temp root');
  }
}

async function assertNoSandboxEscapes(root: string, allow: (entryName: string) => boolean): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!allow(entry.name)) {
      throw new Error(`unsafe output path: ${entry.name}`);
    }
  }
}

async function assertManagedDirectory(root: string, path: string, label: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`unsafe ${label} directory`);
  }
  const [resolvedRoot, resolvedPath] = await Promise.all([realpath(root), realpath(path)]);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith('..') || rel === '' || rel.split(/[\\/]+/).includes('..')) {
    throw new Error(`unsafe ${label} directory`);
  }
}

function readConfigPath(config: unknown): string {
  if (
    config &&
    typeof config === 'object' &&
    !Array.isArray(config) &&
    typeof (config as { path?: unknown }).path === 'string'
  ) {
    return (config as { path: string }).path;
  }
  return 'output.txt';
}

function readConfigRecord(config: unknown): Record<string, unknown> {
  return config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
