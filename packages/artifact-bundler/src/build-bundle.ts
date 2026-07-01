import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { assertRuntimeExportArity, parseCyanManifest } from '@cyanprint/contracts';

export type BundleResult = {
  runtimeFile: string;
  sha256: string;
  dryRun: boolean;
  temporaryDirectory?: string;
};

const resolverSymbol = Symbol.for('cyanprint.resolver');
const workspaceResolvedPackages = new Set(['@atomicloud/cyan-sdk', 'smob', 'yaml']);
const workspaceFallbackPackages = new Set(['eta']);

function resolverGlobal(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

export async function buildBundle(args: {
  artifactDir: string;
  dryRun?: boolean;
  temporary?: boolean;
}): Promise<BundleResult> {
  const manifestPath = join(args.artifactDir, 'cyan.yaml');
  const manifest = parseCyanManifest(YAML.parse(await readFile(manifestPath, 'utf8'))).manifest;
  const readme = await findReadmePath(args.artifactDir, manifest.readme);
  const entry = join(args.artifactDir, manifest.entry);
  const out = join(args.artifactDir, manifest.bundledEntry);
  await stat(manifestPath);
  await stat(readme);
  await stat(entry);
  const temporaryOutDir =
    args.dryRun || args.temporary ? await mkdtemp(join(tmpdir(), 'cyanprint-bundle-')) : undefined;
  try {
    const runtimeFile = temporaryOutDir ? join(temporaryOutDir, basename(out)) : out;
    await compileRuntimeBundle({ entrypoint: entry, output: runtimeFile, kind: manifest.kind });
    const hash = createHash('sha256');
    hash.update(await readFile(manifestPath));
    hash.update(await readFile(readme));
    hash.update(await readFile(runtimeFile));
    return {
      runtimeFile,
      sha256: hash.digest('hex'),
      dryRun: Boolean(args.dryRun),
      temporaryDirectory: temporaryOutDir,
    };
  } catch (error) {
    if (temporaryOutDir) {
      await rm(temporaryOutDir, { recursive: true, force: true });
    }
    throw error;
  }
}

async function findReadmePath(artifactDir: string, declaredReadme: string): Promise<string> {
  const declared = join(artifactDir, declaredReadme);
  if (await stat(declared).catch(() => undefined)) {
    return declared;
  }
  const match = (await readdir(artifactDir)).find(name => /^readme(?:\.[a-z0-9]+)?$/i.test(name));
  if (match) {
    return join(artifactDir, match);
  }
  return declared;
}

export async function assertRequiredRuntimeExport(runtimeFile: string, kind: string): Promise<void> {
  const exportName = requiredRuntimeExportName(kind);
  if (!exportName) {
    return;
  }

  const url = pathToFileURL(runtimeFile);
  const source = await readFile(runtimeFile, 'utf8');
  url.searchParams.set('cyanprint-validate', createHash('sha256').update(source).digest('hex'));
  delete resolverGlobal()[resolverSymbol];
  const loaded = (await import(url.href)) as Record<string, unknown>;
  const registeredResolver = kind === 'resolver' ? resolverGlobal()[resolverSymbol] : undefined;
  const exported = loaded[exportName] ?? registeredResolver;
  if (typeof exported !== 'function') {
    throw new Error(
      `Artifact build expected ${kind} bundle to export function ${exportName}. ` +
        `Use "export function ${exportName}(input)" instead of a default-exported object.`,
    );
  }
  assertRuntimeExportArity({
    declaredParameterCount: exported.length,
    exportName,
    isRegisteredLegacyResolver: kind === 'resolver' && exported === registeredResolver,
    label: `Artifact build ${kind} bundle`,
  });
}

function requiredRuntimeExportName(kind: string): string | undefined {
  if (kind === 'processor') {
    return 'processor';
  }
  if (kind === 'plugin') {
    return 'plugin';
  }
  if (kind === 'resolver') {
    return 'resolver';
  }
  return undefined;
}

export async function compileRuntimeBundle(args: {
  entrypoint: string;
  output: string;
  kind?: string;
  validateExport?: boolean;
}): Promise<void> {
  await mkdir(dirname(args.output), { recursive: true });
  await rm(args.output, { force: true });
  const tempOut = await mkdtemp(join(tmpdir(), 'cyanprint-bundle-'));
  try {
    const result = await Bun.build({
      entrypoints: [args.entrypoint],
      outdir: tempOut,
      target: 'bun',
      format: 'esm',
      plugins: [
        {
          name: 'cyanprint-workspace-dependency-resolver',
          setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
              if (workspaceResolvedPackages.has(args.path)) {
                return { path: Bun.resolveSync(args.path, import.meta.dir) };
              }
              if (workspaceFallbackPackages.has(args.path) && !canResolveFromImporter(args.path, args.importer)) {
                return { path: Bun.resolveSync(args.path, import.meta.dir) };
              }
              return undefined;
            });
          },
        },
      ],
    });
    if (!result.success) {
      throw new Error(`Artifact build failed: ${result.logs.map(log => log.message).join('\n')}`);
    }
    const emitted = await listJavaScriptFiles(tempOut);
    if (emitted.length !== 1) {
      throw new Error(`Artifact build expected one JavaScript output, got ${emitted.length}.`);
    }
    const emittedFile = emitted[0];
    if (!emittedFile) {
      throw new Error('Artifact build did not emit a JavaScript output.');
    }
    await copyFile(emittedFile, args.output);
    await stripSourceMapComments(args.output);
    if (args.kind && args.validateExport !== false) {
      await assertRequiredRuntimeExport(args.output, args.kind);
    }
  } finally {
    await rm(tempOut, { recursive: true, force: true });
  }
}

async function stripSourceMapComments(path: string): Promise<void> {
  const source = await readFile(path, 'utf8');
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = source.endsWith('\n');
  const lines = source.split(/\r?\n/u);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const finalLine = lines.at(-1)?.trimStart();
  if (!finalLine || !/^\/\/# sourceMappingURL=[^\s]+$/u.test(finalLine)) {
    return;
  }
  lines.pop();
  const stripped = lines.join(lineEnding) + (hadTrailingNewline && lines.length > 0 ? lineEnding : '');
  if (stripped !== source) {
    await writeFile(path, stripped, 'utf8');
  }
}

function canResolveFromImporter(specifier: string, importer: string): boolean {
  try {
    Bun.resolveSync(specifier, importer ? dirname(importer) : process.cwd());
    return true;
  } catch {
    return false;
  }
}

async function listJavaScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJavaScriptFiles(path)));
    } else if (entry.isFile() && extname(entry.name) === '.js') {
      files.push(path);
    }
  }
  return files.sort();
}
