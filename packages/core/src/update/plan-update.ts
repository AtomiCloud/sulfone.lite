import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Answers, GeneratedState, PromptAdapter, VfsFile } from '@cyanprint/contracts';
import { invokeResolver, type ArtifactBundleRef, type ResolverFile } from '@cyanprint/artifact-runner';
import { createProject } from '../create/create-project';
import { loadManifest } from '../manifest/load-manifest';
import { loadGeneratedState, writeGeneratedState } from '../state/generated-state';
import { withTempSession } from '../sessions/temp-session';
import { comparePaths, exists, readText, remove, safeJoin, sha256, writeText } from '../util';

export type UpdatePlanResult =
  | { status: 'done'; reusedAnswers: string[]; outputPath: string; conflicts: [] }
  | {
      status: 'conflict';
      reusedAnswers: string[];
      outputPath: string;
      conflicts: Array<{ path: string; reason: string }>;
    };

export async function updateProject(args: {
  projectDir: string;
  template: string;
  answers?: Answers;
  headless?: boolean;
  localFallback?: boolean;
  promptAdapter?: PromptAdapter;
}): Promise<UpdatePlanResult> {
  const prior = await loadGeneratedState(args.projectDir);
  const answers = { ...prior.answers, ...(args.answers ?? {}) };
  const conflicts: Array<{ path: string; reason: string }> = [];
  const pendingWrites: Array<{ path: string; file: StateFile }> = [];
  const pendingRemovals: string[] = [];
  // Conflict `.target` files are deferred like every other write: nothing lands in the project
  // during planning, and a conflict-free update clears any stale .cyan_conflicts/ leftovers.
  const pendingConflictWrites: Array<{ path: string; file: StateFile }> = [];
  const { manifest: targetManifest } = await loadManifest(args.template);

  await withTempSession(async session => {
    const targetResult = await createProject({
      template: args.template,
      outDir: session.path,
      answers,
      deterministicState: prior.deterministicState,
      headless: args.headless ?? true,
      json: true,
      localFallback: args.localFallback,
      promptAdapter: args.promptAdapter,
    });
    const target = await loadGeneratedState(session.path);
    const priorFiles = stateFilesToVfs(prior.files);
    const targetFiles = stateFilesToVfs(target.files);
    const currentFiles = await readProjectVfsFiles(args.projectDir);
    const targetArtifactBundles = new Map<string, ArtifactBundleRef>();
    for (const bundle of targetResult.artifactBundles) {
      targetArtifactBundles.set(artifactKey(bundle.dependency, targetManifest.owner), bundle);
      targetArtifactBundles.set(
        artifactKey({ ...bundle.dependency, version: undefined }, targetManifest.owner),
        bundle,
      );
    }

    const paths = new Set([...prior.files.map(file => file.path), ...target.files.map(file => file.path)]);
    for (const path of paths) {
      const targetFile = target.files.find(file => file.path === path);
      const targetContent = targetFile?.content ?? '';
      const priorFile = prior.files.find(file => file.path === path);
      const projectPath = safeJoin(args.projectDir, path);
      const currentStats = await stat(projectPath).catch(() => undefined);
      const currentExists = Boolean(currentStats);
      const currentIsFile = currentStats?.isFile() ?? false;
      const currentBytes = currentIsFile ? await readFile(projectPath) : undefined;
      const currentContent =
        currentBytes && !isBinaryStateFile(priorFile) && !isBinaryStateFile(targetFile)
          ? decodeText(currentBytes)
          : undefined;

      if (priorFile && targetFile && priorFile.sha256 === targetFile.sha256) {
        continue;
      }

      const resolverRefsForPath = targetResult.artifactUses.resolvers.filter(ref =>
        resolverAppliesToPath(ref.config, path),
      );

      if (!targetFile) {
        if (priorFile && currentBytes && sha256(currentBytes) === priorFile.sha256) {
          pendingRemovals.push(projectPath);
        } else if (priorFile && currentExists) {
          conflicts.push({ path, reason: 'user_edit_and_target_deleted' });
        }
        continue;
      }

      if (currentExists && !currentIsFile) {
        conflicts.push({ path, reason: 'user_replaced_file_with_directory' });
        pendingConflictWrites.push({
          path: safeJoin(args.projectDir, join('.cyan_conflicts', `${path}.target`)),
          file: targetFile,
        });
        continue;
      }

      if (priorFile && !currentExists) {
        conflicts.push({ path, reason: 'user_deleted_and_target_changed' });
        pendingConflictWrites.push({
          path: safeJoin(args.projectDir, join('.cyan_conflicts', `${path}.target`)),
          file: targetFile,
        });
        continue;
      }

      if (
        !currentExists ||
        (priorFile && currentBytes && sha256(currentBytes) === priorFile.sha256) ||
        (currentBytes && sha256(currentBytes) === targetFile.sha256) ||
        currentContent === targetContent
      ) {
        pendingWrites.push({ path: projectPath, file: targetFile });
        continue;
      }

      let resolvedByResolver = false;
      const canUseTextResolver =
        currentContent !== undefined && !isBinaryStateFile(priorFile) && !isBinaryStateFile(targetFile);
      const uniqueResolverRefs = uniqueResolverUses(resolverRefsForPath, targetManifest.owner);
      for (const resolverRef of canUseTextResolver && uniqueResolverRefs.length === 1 ? uniqueResolverRefs : []) {
        const currentText = currentContent;
        if (currentText === undefined) {
          continue;
        }
        const resolverFiles: ResolverFile[] = [];
        if (priorFile?.content !== undefined) {
          resolverFiles.push({
            path,
            content: priorFile.content,
            origin: { template: 'prior', layer: 0 },
            files: priorFiles,
          });
        }
        resolverFiles.push({
          path,
          content: currentText,
          origin: { template: 'current', layer: 1 },
          files: currentFiles,
        });
        resolverFiles.push({
          path,
          content: targetFile.content ?? '',
          origin: { template: 'target', layer: 2 },
          files: targetFiles,
        });
        const bundle = await resolveTargetResolverBundle({
          targetArtifactBundles,
          dependency: { ...resolverRef, kind: resolverRef.kind ?? 'resolver' },
          defaultOwner: targetManifest.owner,
        });
        const resolved = await invokeResolver(bundle, {
          files: resolverFiles,
          config: { ...(isRecord(resolverRef.config) ? resolverRef.config : {}), path },
        });
        if (targetFile) {
          targetFile.content = resolved;
          targetFile.bytesBase64 = undefined;
          targetFile.sha256 = sha256(resolved);
        }
        pendingWrites.push({ path: projectPath, file: targetFile });
        resolvedByResolver = true;
        break;
      }
      if (resolvedByResolver) {
        continue;
      }

      conflicts.push({
        path,
        reason:
          canUseTextResolver && uniqueResolverRefs.length > 1
            ? 'user_edit_and_target_changed_ambiguous_resolver'
            : 'user_edit_and_target_changed',
      });
      pendingConflictWrites.push({
        path: safeJoin(args.projectDir, join('.cyan_conflicts', `${path}.target`)),
        file: targetFile,
      });
    }

    if (conflicts.length === 0) {
      for (const path of pendingRemovals) {
        await remove(path);
      }
      for (const write of pendingWrites) {
        await writeStateFile(write.path, write.file);
      }
      await remove(join(args.projectDir, '.cyan_conflicts'));
      await writeGeneratedState(args.projectDir, target);
    } else {
      for (const write of pendingConflictWrites) {
        await writeStateFile(write.path, write.file);
      }
    }
  });

  return conflicts.length > 0
    ? { status: 'conflict', reusedAnswers: Object.keys(prior.answers), outputPath: args.projectDir, conflicts }
    : { status: 'done', reusedAnswers: Object.keys(prior.answers), outputPath: args.projectDir, conflicts: [] };
}

type StateFile = GeneratedState['files'][number];

function isBinaryStateFile(file: StateFile | undefined): boolean {
  return file?.bytesBase64 !== undefined;
}

function decodeText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

function stateFilesToVfs(files: GeneratedState['files']): VfsFile[] {
  return files
    .map(file =>
      file.bytesBase64 !== undefined
        ? { path: file.path, bytesBase64: file.bytesBase64 }
        : { path: file.path, content: file.content ?? '' },
    )
    .sort((left, right) => comparePaths(left.path, right.path));
}

async function readProjectVfsFiles(projectDir: string): Promise<VfsFile[]> {
  const files: VfsFile[] = [];
  await walkProjectFiles(projectDir, async path => {
    const relativePath = relative(projectDir, path)
      .split(/[\\/]+/)
      .join('/');
    if (relativePath === '.cyan_state.yaml' || relativePath.startsWith('.cyan_conflicts/')) {
      return;
    }
    const bytes = await readFile(path);
    const content = decodeText(bytes);
    files.push(
      content === undefined
        ? { path: relativePath, bytesBase64: Buffer.from(bytes).toString('base64') }
        : { path: relativePath, content },
    );
  });
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

async function walkProjectFiles(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory()) {
    return;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const entryInfo = await lstat(path);
    if (entryInfo.isDirectory()) {
      await walkProjectFiles(path, visit);
    } else if (entryInfo.isFile()) {
      await visit(path);
    }
  }
}

async function writeStateFile(path: string, file: StateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (file.bytesBase64 !== undefined) {
    await writeFile(path, Buffer.from(file.bytesBase64, 'base64'));
    return;
  }
  await writeText(path, file.content ?? '');
}

function resolverAppliesToPath(config: unknown, path: string): boolean {
  if (!isRecord(config) || !Array.isArray(config.paths)) {
    return true;
  }
  return config.paths.includes(path);
}

function uniqueResolverUses<
  T extends { kind?: string; owner?: string; name: string; version?: string; config?: unknown },
>(refs: T[], defaultOwner: string): T[] {
  const unique = new Map<string, T>();
  for (const ref of refs) {
    unique.set(resolverUseKey(ref, defaultOwner), ref);
  }
  return [...unique.values()];
}

function resolverUseKey(
  ref: { kind?: string; owner?: string; name: string; version?: string; config?: unknown },
  defaultOwner: string,
): string {
  return `${ref.kind ?? 'resolver'}:${ref.owner ?? defaultOwner}:${ref.name}:${ref.version ?? ''}:${stableConfig(ref.config)}`;
}

function stableConfig(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableConfig).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableConfig(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ArtifactLookupRef = {
  kind: string;
  owner?: string;
  name: string;
  version?: string;
};

async function resolveTargetResolverBundle(args: {
  targetArtifactBundles: Map<string, ArtifactBundleRef>;
  dependency: ArtifactLookupRef;
  defaultOwner: string;
}): Promise<ArtifactBundleRef> {
  const key = artifactKey(args.dependency, args.defaultOwner);
  const bundle = args.targetArtifactBundles.get(key);
  if (!bundle) {
    throw new Error(
      `Generated target did not record resolver bundle ${args.dependency.kind}:${args.dependency.owner ?? args.defaultOwner}:${args.dependency.name}`,
    );
  }
  return bundle;
}

function artifactKey(dependency: ArtifactLookupRef, defaultOwner: string): string {
  return `${dependency.kind}:${dependency.owner ?? defaultOwner}:${dependency.name}:${dependency.version ?? ''}`;
}
