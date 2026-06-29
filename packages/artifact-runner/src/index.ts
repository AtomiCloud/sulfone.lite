import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportedFunctionParameterCount, type ArtifactDependency, type VfsFile } from '@cyanprint/contracts';

export type ProcessorInput = {
  files: Record<string, string>;
  config?: unknown;
};

export type Processor = (input: ProcessorInput) => Promise<Record<string, string>> | Record<string, string>;

export type PluginInput = {
  files: Record<string, string>;
  config?: unknown;
};

export type Plugin = (input: PluginInput) => Promise<Record<string, string>> | Record<string, string>;

export type ResolverFile = {
  path: string;
  content: string;
  origin: {
    template: string;
    layer: number;
  };
};

export type ResolverInput = {
  files: ResolverFile[];
  config?: unknown;
};

export type ResolverOutput = string | { path?: string; content: string };

export type Resolver = (input: ResolverInput) => Promise<ResolverOutput> | ResolverOutput;

const resolverSymbol = Symbol.for('cyanprint.resolver');
const runtimeExportCache = new Map<string, unknown>();

function resolverGlobal(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

export async function loadArtifactExport<T>(path: string, exportName: string, cacheKey?: string): Promise<T> {
  const importPath = cacheKey ? await materializeImportPath(path, cacheKey) : path;
  const url = importPath.startsWith('file:') ? new URL(importPath) : pathToFileURL(importPath);
  const runtimeExportCacheKey = `${url.href}:${exportName}`;
  if (runtimeExportCache.has(runtimeExportCacheKey)) {
    return runtimeExportCache.get(runtimeExportCacheKey) as T;
  }
  const source = await readFile(url, 'utf8');
  delete resolverGlobal()[resolverSymbol];
  const loaded = (await import(url.href)) as Record<string, unknown>;
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
  const parameterCount = exportedFunctionParameterCount(source, exportName);
  if (parameterCount === undefined && exportName === 'resolver' && exported === registeredResolver) {
    runtimeExportCache.set(runtimeExportCacheKey, exported);
    return exported as T;
  }
  if (parameterCount === undefined) {
    throw new Error(
      `Artifact bundle ${path} expected ${exportName} to be declared as "export function ${exportName}(input)". ` +
        'Exported const/function-expression artifacts are not supported.',
    );
  }
  if (parameterCount !== 1) {
    throw new Error(
      `Artifact bundle ${path} expected ${exportName} to take one input object. ` +
        `Use "export function ${exportName}(input)".`,
    );
  }
  runtimeExportCache.set(runtimeExportCacheKey, exported);
  return exported as T;
}

async function materializeImportPath(path: string, cacheKey: string): Promise<string> {
  const ext = extname(path) || '.js';
  const target = join(tmpdir(), 'cyanprint-artifact-imports', `${cacheKey}${ext}`);
  await mkdir(join(tmpdir(), 'cyanprint-artifact-imports'), { recursive: true });
  await writeFile(target, await readFile(path), 'utf8');
  return target;
}

export type ArtifactBundleRef = {
  dependency: ArtifactDependency;
  runtimeFile: string;
  integrity?: string;
};

async function verifyBundleIntegrity(bundle: ArtifactBundleRef): Promise<string> {
  const actual = createHash('sha256')
    .update(await readFile(bundle.runtimeFile))
    .digest('hex');
  if (bundle.integrity && actual !== bundle.integrity) {
    throw new Error(`Bundle integrity mismatch for ${bundle.dependency.kind}:${bundle.dependency.name}`);
  }
  return actual;
}

export function filesToRecord(files: VfsFile[]): Record<string, string> {
  return Object.fromEntries(
    files.filter(file => file.bytesBase64 === undefined).map(file => [file.path, file.content ?? '']),
  );
}

export function recordToFiles(
  record: Record<string, string>,
  previous: VfsFile[],
  options: { preservePrevious?: boolean } = {},
): VfsFile[] {
  const files = new Map(options.preservePrevious === false ? [] : previous.map(file => [file.path, file]));
  for (const [path, content] of Object.entries(record)) {
    files.set(path, {
      path,
      content,
      mode: previous.find(file => file.path === path)?.mode,
    });
  }
  return [...files.values()];
}

export async function invokeProcessor(
  bundle: ArtifactBundleRef,
  files: VfsFile[],
  config?: unknown,
  options: { preservePrevious?: boolean } = {},
): Promise<VfsFile[]> {
  const cacheKey = await verifyBundleIntegrity(bundle);
  const processor = await loadArtifactExport<Processor>(bundle.runtimeFile, 'processor', cacheKey);
  return recordToFiles(await processor({ files: filesToRecord(files), config }), files, options);
}

export async function invokePlugin(
  bundle: ArtifactBundleRef,
  files: VfsFile[],
  config?: unknown,
  options: { preservePrevious?: boolean } = {},
): Promise<VfsFile[]> {
  const cacheKey = await verifyBundleIntegrity(bundle);
  const plugin = await loadArtifactExport<Plugin>(bundle.runtimeFile, 'plugin', cacheKey);
  return recordToFiles(await plugin({ files: filesToRecord(files), config }), files, options);
}

export async function invokeResolver(bundle: ArtifactBundleRef, input: ResolverInput): Promise<string> {
  const cacheKey = await verifyBundleIntegrity(bundle);
  const resolver = await loadArtifactExport<Resolver>(bundle.runtimeFile, 'resolver', cacheKey);
  const result = await resolver(input);
  return typeof result === 'string' ? result : result.content;
}
