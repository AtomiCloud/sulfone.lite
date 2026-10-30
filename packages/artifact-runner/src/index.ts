import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
} from 'node:fs/promises';
import { basename, dirname, extname, join, parse, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertRuntimeExportArity, type KindedArtifactRef, type VfsFile } from '@cyanprint/contracts';
import { engineRunPath, makeEngineRunDir } from '@cyanprint/contracts/run-dir';
import { overlayFiles, readVfsFiles, writeVfsFiles } from './fs-utils';
import { createPluginHelper, createProcessorFsHelper } from './helpers';
import type { Plugin, Processor, ResolvedFile, Resolver, ResolverOutput } from './sdk-types';

export type { FileOrigin, ResolvedFile, ResolverInput, ResolverOutput } from './sdk-types';
export { applyFileMode, overlayFiles } from './fs-utils';

const resolverSymbol = Symbol.for('cyanprint.resolver');
const runtimeExportCache = new Map<string, unknown>();

function resolverGlobal(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

// Legacy resolvers register through one process-global symbol, so only one resolver
// module may be mid-import at a time; concurrent first loads would read each other's.
let resolverImportChain: Promise<unknown> = Promise.resolve();

function serializeResolverImport<T>(task: () => Promise<T>): Promise<T> {
  const run = resolverImportChain.then(task, task);
  resolverImportChain = run.catch(() => undefined);
  return run;
}

export async function loadArtifactExport<T>(path: string, exportName: string, cacheKey?: string): Promise<T> {
  const sourcePath = path.startsWith('file:') ? fileURLToPath(path) : path;
  const layout = cacheKey ? await importLayout(sourcePath, cacheKey) : undefined;
  const url = pathToFileURL(layout?.importPath ?? sourcePath);
  const runtimeExportCacheKey = `${url.href}:${exportName}`;
  const load = async (): Promise<T> => {
    // A hit still touches the import dir so another process's sweep sees it as in use.
    if (layout) {
      await touch(layout.targetDir);
    }
    if (runtimeExportCache.has(runtimeExportCacheKey)) {
      return runtimeExportCache.get(runtimeExportCacheKey) as T;
    }
    if (layout) {
      await materializeImportPath(sourcePath, layout, cacheKey as string);
    }
    return await importExport<T>({ path, url, exportName, runtimeExportCacheKey });
  };
  return exportName === 'resolver' ? await serializeResolverImport(load) : await load();
}

async function importExport<T>(args: {
  path: string;
  url: URL;
  exportName: string;
  runtimeExportCacheKey: string;
}): Promise<T> {
  const { path, url, exportName } = args;
  // Only resolver loads are serialized, so only they may touch the shared registration
  // slot; a processor/plugin load must never wipe a resolver that is mid-import.
  if (exportName === 'resolver') {
    delete resolverGlobal()[resolverSymbol];
  }
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
  runtimeExportCache.set(args.runtimeExportCacheKey, exported);
  return exported as T;
}

type ImportLayout = { importsRoot: string; targetDir: string; importPath: string };

async function importLayout(path: string, cacheKey: string): Promise<ImportLayout> {
  const importsRoot = await engineRunPath('cyanprint-artifact-imports');
  const targetDir = join(importsRoot, cacheKey);
  if (isSourceRuntime(path)) {
    return { importsRoot, targetDir, importPath: join(targetDir, 'bundle.js') };
  }
  const parsed = parse(path);
  return { importsRoot, targetDir, importPath: join(targetDir, `${parsed.name}-${cacheKey}${parsed.ext || '.js'}`) };
}

async function touch(dir: string): Promise<void> {
  const now = new Date();
  await utimes(dir, now, now).catch(() => undefined);
}

async function materializeImportPath(path: string, layout: ImportLayout, cacheKey: string): Promise<void> {
  const sourceDir = dirname(path);
  const { importsRoot, targetDir } = layout;
  await cleanStaleImportDirs(importsRoot, cacheKey);
  await mkdir(targetDir, { recursive: true });
  await touch(targetDir);
  if (isSourceRuntime(path)) {
    // Bundle source runtimes into a self-contained file: compiled cyanprint binaries
    // cannot resolve bare imports (node_modules) from external files at runtime, but
    // Bun.build's resolver works everywhere and inlines the dependencies.
    // Always rebuild and atomically replace the bundle — the temp path is predictable,
    // so a pre-existing file there must never be trusted as executable code.
    const result = await Bun.build({ entrypoints: [path], target: 'bun' });
    if (!result.success || !result.outputs[0]) {
      throw new Error(
        `Failed to bundle artifact source runtime ${path}: ${result.logs.map(log => String(log)).join('\n')}`,
      );
    }
    // Unique per call: concurrent loads in one process share the pid.
    const staging = `${layout.importPath}.${process.pid}.${randomUUID()}.tmp`;
    await Bun.write(staging, await result.outputs[0].text());
    await rename(staging, layout.importPath);
    return;
  }
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name === basename(path)) {
      continue;
    }
    await symlink(join(sourceDir, entry.name), join(targetDir, entry.name)).catch(() => undefined);
  }
  const nearestNodeModules = await findNearestNodeModules(sourceDir);
  if (nearestNodeModules) {
    await symlink(nearestNodeModules, join(targetDir, 'node_modules')).catch(() => undefined);
  }
  await mkdir(dirname(layout.importPath), { recursive: true });
  // Stage + rename: the import path is shared, so a concurrent import must never see a
  // half-copied file.
  const staging = `${layout.importPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(path, staging);
    await rename(staging, layout.importPath);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
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
  dependency: KindedArtifactRef;
  runtimeFile: string;
  integrity?: string;
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
    } else if (entry.isFile() && isSourceRuntimeInput(entry.name)) {
      files.push(path);
    }
  }
}

// Lock files count as bundle inputs: the materialized bundle inlines dependencies, so a
// dependency update (lock change without a source change) must produce a new cache key.
const LOCK_FILES = new Set(['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

function isSourceRuntimeInput(name: string): boolean {
  return (
    ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'].includes(extname(name)) ||
    LOCK_FILES.has(name)
  );
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

/**
 * Invoke a resolver once with every variation of one conflicting path. The resolver
 * receives all variations (with origins) in a single call and returns the merged file.
 */
export async function invokeResolver(
  bundle: ArtifactBundleRef,
  input: { config: Record<string, unknown>; files: ResolvedFile[] },
): Promise<ResolverOutput> {
  const cacheKey = await verifyBundleIntegrity(bundle);
  const resolver = await loadArtifactExport<Resolver>(bundle.runtimeFile, 'resolver', cacheKey);
  const first = input.files[0];
  if (!first) {
    throw new Error(`Resolver ${bundle.dependency.name} invoked with no file variations`);
  }
  const output = await resolver({ config: input.config, files: input.files });
  if (!output || typeof output !== 'object' || typeof (output as { content?: unknown }).content !== 'string') {
    throw new Error(`Resolver ${bundle.dependency.name} must return { path, content }`);
  }
  return {
    path: typeof output.path === 'string' && output.path.length > 0 ? output.path : first.path,
    content: output.content,
  };
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
    const output = inheritInputModes(args.files, await readVfsFiles(outputDir));
    return args.options.preservePrevious ? overlayFiles(args.files, output) : output;
  } finally {
    await rm(container, { recursive: true, force: true });
  }
}

/**
 * A processor writes fresh files into `outputDir`, so a script it merely rewrites would lose the
 * executable bit it arrived with. An output at the same path as an executable input keeps that mode
 * unless the processor already marked the output executable itself.
 */
function inheritInputModes(input: VfsFile[], output: VfsFile[]): VfsFile[] {
  const inputModes = new Map(input.filter(file => file.mode !== undefined).map(file => [file.path, file.mode]));
  return output.map(file => {
    const mode = inputModes.get(file.path);
    return file.mode === undefined && mode !== undefined ? { ...file, mode } : file;
  });
}

async function mkTempRoot(prefix: string): Promise<{ container: string; root: string }> {
  const container = await makeEngineRunDir(`${prefix}container`);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
