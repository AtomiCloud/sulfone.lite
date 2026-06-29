import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  invokePlugin,
  invokeProcessor,
  invokeResolver,
  type ArtifactBundleRef,
  type ResolverFile,
} from '@cyanprint/artifact-runner';
import type {
  Answers,
  ArtifactDependency,
  CompatibilityWarning,
  CyanArtifactUse,
  CyanFileGlob,
  CyanManifest,
  PromptAdapter,
  VfsFile,
} from '@cyanprint/contracts';
import { CyanError, declaredDependencyKeys, problem } from '@cyanprint/contracts';
import { loadManifest } from '../manifest/load-manifest';
import { resolveDevArtifactBundle } from '../artifacts/dev-artifact-resolver';
import { executeCyanScript, globTemplateFiles } from '../scripts/load-cyan-script';
import { buildGeneratedState, writeGeneratedState } from '../state/generated-state';
import { safeJoin, sha256, writeText } from '../util';

export type CreateProjectOptions = {
  template: string;
  outDir: string;
  answers?: Answers;
  headless?: boolean;
  json?: boolean;
  localFallback?: boolean;
  promptAdapter?: PromptAdapter;
};

export type CreateProjectResult = {
  status: 'done';
  outputPath: string;
  files: VfsFile[];
  artifactBundles: ArtifactBundleRef[];
  artifactUses: {
    processors: CyanArtifactUse[];
    plugins: CyanArtifactUse[];
    resolvers: CyanArtifactUse[];
    templates: CyanArtifactUse[];
  };
  docker: false;
  daemon: false;
  remoteExecution: false;
};

type ArtifactKind = 'processor' | 'plugin' | 'resolver' | 'template';
type NormalizedArtifactUse = CyanArtifactUse & { kind: ArtifactKind };

function assertDeclaredArtifacts(
  uses: NormalizedArtifactUse[] | undefined,
  declared: Set<string>,
  owner: string,
): void {
  for (const use of uses ?? []) {
    const key = `${use.kind}:${use.owner ?? owner}:${use.name}`;
    const declaredKey = use.version ? `${key}@${use.version}` : key;
    if (!declared.has(declaredKey)) {
      throw new CyanError(
        problem(
          'validation',
          'undeclared_artifact',
          `cyan.ts returned ${declaredKey}, but cyan.yaml does not declare it.`,
          { key: declaredKey },
        ),
      );
    }
  }
}

function declaredDependencyVersions(manifest: CyanManifest): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  const refs = [...manifest.templates, ...manifest.processors, ...manifest.plugins, ...manifest.resolvers];
  for (const ref of refs) {
    if (!ref.version) {
      continue;
    }
    const key = `${ref.kind}:${ref.owner ?? manifest.owner}:${ref.name}`;
    const refVersions = versions.get(key) ?? new Set<string>();
    refVersions.add(ref.version);
    versions.set(key, refVersions);
  }
  return versions;
}

function applyDeclaredArtifactVersions(
  uses: NormalizedArtifactUse[] | undefined,
  versions: Map<string, Set<string>>,
  owner: string,
): void {
  for (const use of uses ?? []) {
    if (use.version) {
      continue;
    }
    const key = `${use.kind}:${use.owner ?? owner}:${use.name}`;
    const declaredVersions = versions.get(key);
    if (declaredVersions?.size === 1) {
      use.version = [...declaredVersions][0];
    }
  }
}

type GenerationContext = {
  answers: Answers;
  deterministicState: Record<string, unknown>;
  interactive: boolean;
  artifactBundles: Map<string, ArtifactBundleRef>;
  warnings: CompatibilityWarning[];
  localFallback?: boolean;
  promptAdapter?: PromptAdapter;
};

type GeneratedTemplate = {
  manifest: CyanManifest;
  files: VfsFile[];
  fileResolvers: Map<string, NormalizedArtifactUse[]>;
  resolverInputs: Map<string, ResolverFile[]>;
  conflicts: Array<{ path: string; reason: string }>;
  commands: NonNullable<Awaited<ReturnType<typeof executeCyanScript>>['commands']>;
  artifactUses: CreateProjectResult['artifactUses'];
};

export async function createProject(options: CreateProjectOptions): Promise<CreateProjectResult> {
  const answers = { ...(options.answers ?? {}) };
  const deterministicState: Record<string, unknown> = {};
  const context: GenerationContext = {
    answers,
    deterministicState,
    interactive: options.headless === false,
    artifactBundles: new Map(),
    warnings: [],
    localFallback: options.localFallback,
    promptAdapter: options.promptAdapter,
  };
  const generated = await generateTemplate(options.template, context, new Set());
  const { manifest, files } = generated;
  const existingOutputFiles = await readOutputFilePathsIfExists(options.outDir);
  const generatedPaths = new Set(files.map(file => file.path));

  await mkdir(options.outDir, { recursive: true });
  for (const file of files) {
    await writeVfsFile(options.outDir, file);
  }

  for (const command of generated.commands) {
    const { runPostGenerationCommand } = await import('../commands/post-generation-command');
    const result = await runPostGenerationCommand({ ...command, cwd: options.outDir });
    if (result.allowed && result.exitCode !== 0) {
      throw new CyanError(
        problem('execution', 'post_generation_command_failed', `Post-generation command failed: ${command.command}`, {
          result,
        }),
      );
    }
  }

  const finalFiles = (await readOutputFiles(options.outDir)).filter(
    file => generatedPaths.has(file.path) || !existingOutputFiles.has(file.path),
  );
  await writeGeneratedState(
    options.outDir,
    buildGeneratedState({
      manifest,
      source: options.template,
      answers,
      deterministicState,
      files: finalFiles,
      artifacts: [...context.artifactBundles.values()].map(bundle => ({
        kind: bundle.dependency.kind,
        owner: bundle.dependency.owner ?? manifest.owner,
        name: bundle.dependency.name,
        version: bundle.dependency.version,
        integrity: bundle.integrity,
      })),
      conflicts: generated.conflicts,
    }),
  );

  if (context.warnings.length > 0 && !options.json) {
    for (const warning of context.warnings) {
      console.warn(`${warning.code}: ${warning.message}`);
    }
  }

  return {
    status: 'done',
    outputPath: options.outDir,
    files: finalFiles,
    artifactBundles: [...context.artifactBundles.values()],
    artifactUses: generated.artifactUses,
    docker: false,
    daemon: false,
    remoteExecution: false,
  };
}

async function generateTemplate(
  templateDir: string,
  context: GenerationContext,
  stack: Set<string>,
): Promise<GeneratedTemplate> {
  const { manifest, warnings } = await loadManifest(templateDir);
  context.warnings.push(...warnings);
  const stackKey = `${manifest.kind}:${manifest.owner}:${manifest.name}:${resolve(templateDir)}`;
  if (stack.has(stackKey)) {
    throw new CyanError(problem('validation', 'template_cycle', `Template dependency cycle detected: ${stackKey}`));
  }
  stack.add(stackKey);

  const templateBundle = await templateBundleRef(templateDir, manifest);
  context.artifactBundles.set(artifactKey(templateBundle.dependency, manifest.owner), templateBundle);

  const declared = declaredDependencyKeys(manifest);
  let files: VfsFile[] = [];
  const fileResolvers = new Map<string, NormalizedArtifactUse[]>();
  const resolverInputs = new Map<string, ResolverFile[]>();
  const conflicts: Array<{ path: string; reason: string }> = [];
  const artifactUses: CreateProjectResult['artifactUses'] = {
    processors: [],
    plugins: [],
    resolvers: [],
    templates: [],
  };
  const commands: GeneratedTemplate['commands'] = [];

  for (const childTemplate of manifest.templates) {
    const child = await executeChildTemplate(
      templateDir,
      childTemplate,
      manifest.owner,
      context,
      stack,
      dependencyPresetAnswers(manifest, childTemplate),
    );
    files = await mergeLayerFiles({
      current: files,
      currentResolvers: fileResolvers,
      currentResolverInputs: resolverInputs,
      next: child.files,
      nextResolvers: child.fileResolvers,
      nextResolverInputs: child.resolverInputs,
      fallbackNextResolvers: child.artifactUses.resolvers.map(use => normalizeArtifactUse(use, manifest.owner)),
      context,
      defaultOwner: manifest.owner,
      conflicts,
    });
    commands.push(...child.commands);
    conflicts.push(...child.conflicts);
    mergeArtifactUses(artifactUses, child.artifactUses);
  }

  const scriptPath = safeJoin(templateDir, manifest.bundledEntry);
  const cyan = await executeCyanScript(
    scriptPath,
    context.answers,
    context.deterministicState,
    context.interactive,
    context.promptAdapter,
  );

  const cyanProcessors = normalizeReturnedArtifactUses(cyan.processors, 'processor', manifest.owner);
  const cyanPlugins = normalizeReturnedArtifactUses(cyan.plugins, 'plugin', manifest.owner);
  const cyanResolvers = normalizeReturnedArtifactUses(cyan.resolvers, 'resolver', manifest.owner);
  const cyanTemplates = normalizeReturnedArtifactUses(cyan.templates, 'template', manifest.owner);
  const declaredVersions = declaredDependencyVersions(manifest);
  applyDeclaredArtifactVersions(cyanProcessors, declaredVersions, manifest.owner);
  applyDeclaredArtifactVersions(cyanPlugins, declaredVersions, manifest.owner);
  applyDeclaredArtifactVersions(cyanResolvers, declaredVersions, manifest.owner);
  applyDeclaredArtifactVersions(cyanTemplates, declaredVersions, manifest.owner);

  assertDeclaredArtifacts(cyanProcessors, declared, manifest.owner);
  assertDeclaredArtifacts(cyanPlugins, declared, manifest.owner);
  assertDeclaredArtifacts(cyanResolvers, declared, manifest.owner);
  assertDeclaredArtifacts(cyanTemplates, declared, manifest.owner);

  const resolveArtifact = async (dependency: NormalizedArtifactUse): Promise<ArtifactBundleRef> => {
    const key = artifactKey(dependency, manifest.owner);
    const existing = context.artifactBundles.get(key);
    if (existing) {
      return existing;
    }
    const bundle = await resolveDevArtifactBundle({
      workspaceRoot: process.cwd(),
      templateDir,
      dependency,
      defaultOwner: manifest.owner,
      localFallback: context.localFallback,
    });
    context.artifactBundles.set(key, bundle);
    return bundle;
  };

  const staticTemplateKeys = new Set(manifest.templates.map(template => artifactKey(template, manifest.owner)));
  for (const template of cyanTemplates) {
    if (staticTemplateKeys.has(artifactKey(template, manifest.owner))) {
      continue;
    }
    const child = await executeChildTemplate(
      templateDir,
      template,
      manifest.owner,
      context,
      stack,
      dependencyConfigAnswers(template.config),
    );
    files = await mergeLayerFiles({
      current: files,
      currentResolvers: fileResolvers,
      currentResolverInputs: resolverInputs,
      next: child.files,
      nextResolvers: child.fileResolvers,
      nextResolverInputs: child.resolverInputs,
      fallbackNextResolvers: child.artifactUses.resolvers.map(use => normalizeArtifactUse(use, manifest.owner)),
      context,
      defaultOwner: manifest.owner,
      conflicts,
    });
    commands.push(...child.commands);
    conflicts.push(...child.conflicts);
    mergeArtifactUses(artifactUses, child.artifactUses);
  }

  let ownFiles: VfsFile[] = [];
  const artifactPipelineState: ArtifactPipelineState = { scopes: new Map(), owners: new Map() };

  for (const processor of cyanProcessors) {
    const bundle = await resolveArtifact(processor);
    ownFiles = await invokeProcessorForUse(bundle, ownFiles, processor, templateDir, artifactPipelineState);
    artifactUses.processors.push(normalizeArtifactUse(processor, manifest.owner));
  }
  for (const plugin of cyanPlugins) {
    const bundle = await resolveArtifact(plugin);
    ownFiles = await invokePluginForUse(bundle, ownFiles, plugin, templateDir, artifactPipelineState);
    artifactUses.plugins.push(normalizeArtifactUse(plugin, manifest.owner));
  }
  for (const resolver of cyanResolvers) {
    await resolveArtifact(resolver);
    artifactUses.resolvers.push(normalizeArtifactUse(resolver, manifest.owner));
  }
  const ownFileResolvers = new Map(ownFiles.map(file => [file.path, cyanResolvers]));
  const ownResolverInputs = new Map(
    ownFiles
      .filter(file => file.bytesBase64 === undefined)
      .map(file => [
        file.path,
        [
          {
            path: file.path,
            content: file.content ?? '',
            origin: { template: manifest.name, layer: 0 },
          },
        ],
      ]),
  );
  files = await mergeLayerFiles({
    current: files,
    currentResolvers: fileResolvers,
    currentResolverInputs: resolverInputs,
    next: ownFiles,
    nextResolvers: ownFileResolvers,
    nextResolverInputs: ownResolverInputs,
    fallbackNextResolvers: cyanResolvers,
    context,
    defaultOwner: manifest.owner,
    conflicts,
  });
  for (const template of cyanTemplates) {
    if (!staticTemplateKeys.has(artifactKey(template, manifest.owner))) {
      artifactUses.templates.push(normalizeArtifactUse(template, manifest.owner));
    }
  }
  for (const command of cyan.commands ?? []) {
    commands.push(command);
  }

  stack.delete(stackKey);
  return { manifest, files, fileResolvers, resolverInputs, conflicts, commands, artifactUses };
}

async function executeChildTemplate(
  parentDir: string,
  dependency: ArtifactDependency | CyanArtifactUse,
  defaultOwner: string,
  context: GenerationContext,
  stack: Set<string>,
  dependencyAnswers: Answers = {},
): Promise<GeneratedTemplate> {
  const childDir = await resolveDevTemplateDir({
    workspaceRoot: process.cwd(),
    templateDir: parentDir,
    dependency,
    defaultOwner,
    localFallback: context.localFallback,
  });
  const childContext = {
    ...context,
    answers: { ...structuredClone(context.answers), ...structuredClone(dependencyAnswers) },
  };
  const child = await generateTemplate(childDir, childContext, stack);
  for (const [key, value] of Object.entries(childContext.answers)) {
    if (!(key in context.answers)) {
      context.answers[key] = value;
    }
  }
  child.artifactUses.templates.unshift({
    kind: 'template',
    owner: dependency.owner ?? defaultOwner,
    name: dependency.name,
    config: 'config' in dependency ? dependency.config : undefined,
  });
  return child;
}

function dependencyPresetAnswers(manifest: CyanManifest, dependency: ArtifactDependency | CyanArtifactUse): Answers {
  const templates = isRecord(manifest.presets.templates) ? manifest.presets.templates : {};
  const owner = dependency.owner ?? manifest.owner;
  const candidates = [`${dependency.kind}:${owner}:${dependency.name}`, `${owner}/${dependency.name}`, dependency.name];
  for (const key of candidates) {
    const preset = templates[key];
    const answers = isRecord(preset) && isRecord(preset.answers) ? preset.answers : preset;
    if (isRecord(answers)) {
      return { ...answers };
    }
  }
  return {};
}

function dependencyConfigAnswers(config: unknown): Answers {
  if (!isRecord(config) || !isRecord(config.answers)) {
    return {};
  }
  return { ...config.answers };
}

function normalizeReturnedArtifactUses(
  uses: CyanArtifactUse[] | undefined,
  kind: ArtifactKind,
  defaultOwner: string,
): NormalizedArtifactUse[] {
  return (uses ?? []).map(use => {
    const parsed = parseArtifactName(use.name);
    return {
      ...use,
      kind: use.kind ?? kind,
      owner: use.owner ?? parsed.owner ?? defaultOwner,
      name: parsed.name,
    };
  });
}

function parseArtifactName(name: string): { owner?: string; name: string } {
  const [owner, artifactName, extra] = name.split('/');
  if (owner && artifactName && !extra) {
    return { owner, name: artifactName };
  }
  return { name };
}

function overlayFiles(base: VfsFile[], overlay: VfsFile[]): VfsFile[] {
  const files = new Map(base.map(file => [file.path, file]));
  for (const file of overlay) {
    files.set(file.path, file);
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function mergeLayerFiles(args: {
  current: VfsFile[];
  currentResolvers: Map<string, NormalizedArtifactUse[]>;
  currentResolverInputs: Map<string, ResolverFile[]>;
  next: VfsFile[];
  nextResolvers: Map<string, NormalizedArtifactUse[]>;
  nextResolverInputs: Map<string, ResolverFile[]>;
  fallbackNextResolvers: NormalizedArtifactUse[];
  context: GenerationContext;
  defaultOwner: string;
  conflicts: Array<{ path: string; reason: string }>;
}): Promise<VfsFile[]> {
  const files = new Map(args.current.map(file => [file.path, file]));
  for (const file of args.next) {
    const existing = files.get(file.path);
    const nextResolvers = args.nextResolvers.get(file.path) ?? args.fallbackNextResolvers;
    if (!existing) {
      files.set(file.path, file);
      args.currentResolvers.set(file.path, nextResolvers);
      args.currentResolverInputs.set(file.path, resolverInputsForFile(file, args.nextResolverInputs));
      continue;
    }

    const currentResolvers = args.currentResolvers.get(file.path) ?? [];
    const currentInputs = resolverInputsForFile(existing, args.currentResolverInputs);
    const nextInputs = resolverInputsForFile(file, args.nextResolverInputs);
    const resolverInputs = renumberResolverInputs([...currentInputs, ...nextInputs]);
    const decision = createLayerMergeDecision(file.path, currentResolvers, nextResolvers);
    if (decision.status === 'merge') {
      files.set(
        file.path,
        await mergeWithCreateResolver(file, resolverInputs, decision.resolver, args.context, args.defaultOwner),
      );
      args.currentResolvers.set(file.path, [decision.resolver]);
      args.currentResolverInputs.set(file.path, resolverInputs);
      continue;
    }

    args.conflicts.push({ path: file.path, reason: decision.reason });
    files.set(file.path, file);
    args.currentResolvers.set(file.path, nextResolvers);
    args.currentResolverInputs.set(file.path, nextInputs);
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function resolverInputsForFile(file: VfsFile, inputs: Map<string, ResolverFile[]>): ResolverFile[] {
  const existing = inputs.get(file.path);
  if (existing) {
    return existing;
  }
  if (file.bytesBase64 !== undefined) {
    return [];
  }
  return [{ path: file.path, content: file.content ?? '', origin: { template: 'unknown', layer: 0 } }];
}

function renumberResolverInputs(inputs: ResolverFile[]): ResolverFile[] {
  return inputs.map((file, index) => ({
    ...file,
    origin: { ...file.origin, layer: index },
  }));
}

function createLayerMergeDecision(
  path: string,
  currentResolvers: NormalizedArtifactUse[],
  nextResolvers: NormalizedArtifactUse[],
): { status: 'merge'; resolver: NormalizedArtifactUse } | { status: 'lww'; reason: string } {
  const current = resolversForPath(currentResolvers, path);
  const next = resolversForPath(nextResolvers, path);
  if (current.length !== 1 || next.length !== 1) {
    return { status: 'lww', reason: current.length === 0 || next.length === 0 ? 'no_resolver' : 'different_resolver' };
  }
  const [left] = current;
  const [right] = next;
  if (!left || !right || artifactIdentity(left) !== artifactIdentity(right)) {
    return { status: 'lww', reason: 'different_resolver' };
  }
  if (stableConfig(left.config) !== stableConfig(right.config)) {
    return { status: 'lww', reason: 'same_resolver_different_config' };
  }
  return { status: 'merge', resolver: right };
}

function resolversForPath(resolvers: NormalizedArtifactUse[], path: string): NormalizedArtifactUse[] {
  return resolvers.filter(resolver => resolverAppliesToPath(resolver.config, path));
}

async function mergeWithCreateResolver(
  target: VfsFile,
  resolverInputs: ResolverFile[],
  resolver: NormalizedArtifactUse,
  context: GenerationContext,
  defaultOwner: string,
): Promise<VfsFile> {
  if (target.bytesBase64 !== undefined || resolverInputs.length === 0) {
    return target;
  }
  const bundle = context.artifactBundles.get(artifactKey(resolver, defaultOwner));
  if (!bundle) {
    return target;
  }
  const content = await invokeResolver(bundle, {
    files: resolverInputs,
    config: { path: target.path, ...(isRecord(resolver.config) ? resolver.config : {}) },
  });
  return { path: target.path, content };
}

function artifactIdentity(use: NormalizedArtifactUse): string {
  return `${use.kind}:${use.owner}:${use.name}:${use.version ?? ''}`;
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

function resolverAppliesToPath(config: unknown, path: string): boolean {
  if (!isRecord(config) || !Array.isArray(config.paths)) {
    return true;
  }
  return config.paths.includes(path);
}

async function invokeProcessorForUse(
  bundle: ArtifactBundleRef,
  files: VfsFile[],
  processor: NormalizedArtifactUse,
  templateDir: string,
  artifactPipelineState: ArtifactPipelineState,
): Promise<VfsFile[]> {
  if (artifactFileScopes(processor).length === 0) {
    return invokeProcessor(bundle, files, processor.config);
  }
  return applyArtifactFileScopes(templateDir, files, processor, artifactPipelineState, selected =>
    invokeProcessor(bundle, selected, processor.config, { preservePrevious: false }),
  );
}

async function invokePluginForUse(
  bundle: ArtifactBundleRef,
  files: VfsFile[],
  plugin: NormalizedArtifactUse,
  templateDir: string,
  artifactPipelineState: ArtifactPipelineState,
): Promise<VfsFile[]> {
  if (artifactFileScopes(plugin).length === 0) {
    return invokePlugin(bundle, files, plugin.config);
  }
  return applyArtifactFileScopes(templateDir, files, plugin, artifactPipelineState, selected =>
    invokePlugin(bundle, selected, plugin.config, { preservePrevious: false }),
  );
}

type ArtifactPipelineState = {
  scopes: Map<string, { mode: 'template' | 'copy'; files: VfsFile[] }>;
  owners: Map<string, string>;
};

async function applyArtifactFileScopes(
  templateDir: string,
  files: VfsFile[],
  use: NormalizedArtifactUse,
  artifactPipelineState: ArtifactPipelineState,
  invoke: (selected: VfsFile[]) => Promise<VfsFile[]>,
): Promise<VfsFile[]> {
  const scopes = artifactFileScopes(use);
  if (scopes.length === 0) {
    return await invoke(files);
  }

  let current = files;
  for (const scope of scopes) {
    const scopeKey = artifactFileScopeKey(scope);
    let scopeState = artifactPipelineState.scopes.get(scopeKey);
    if (!scopeState) {
      const loaded = await loadScopeFiles(templateDir, scope);
      scopeState = { mode: loaded.mode, files: loaded.files };
      artifactPipelineState.scopes.set(scopeKey, scopeState);
      current = overlayScopedFiles(current, [], scopeState.files, scopeKey, artifactPipelineState.owners);
    }
    if (scopeState.mode === 'copy') {
      continue;
    }
    if (scopeState.files.length > 0) {
      const selected = scopeState.files.filter(file => file.bytesBase64 === undefined);
      if (selected.length === 0) {
        continue;
      }
      const transformed = (await invoke(selected)).map(file => ({
        ...file,
        path: normalizeScopedOutputPath(file.path),
      }));
      const previous = scopeState.files;
      scopeState.files = transformed;
      current = overlayScopedFiles(current, previous, transformed, scopeKey, artifactPipelineState.owners);
      continue;
    }
  }
  return current;
}

function overlayScopedFiles(
  base: VfsFile[],
  previous: VfsFile[],
  overlay: VfsFile[],
  scopeKey: string,
  owners: Map<string, string>,
): VfsFile[] {
  const files = new Map(base.map(file => [file.path, file]));
  for (const file of previous) {
    if (owners.get(file.path) === scopeKey) {
      files.delete(file.path);
      owners.delete(file.path);
    }
  }
  for (const file of overlay) {
    files.set(file.path, file);
    owners.set(file.path, scopeKey);
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function artifactFileScopeKey(scope: CyanFileGlob): string {
  return stableConfig({
    root: normalizeScopeRoot(scope.root ?? scope.base),
    glob: scope.glob ?? '**/*',
    exclude: scope.exclude ?? [],
    mode: fileScopeMode(scope),
  });
}

async function loadScopeFiles(
  templateDir: string,
  scope: CyanFileGlob,
): Promise<{ mode: 'template' | 'copy'; files: VfsFile[] }> {
  const mode = fileScopeMode(scope);
  const files = await globTemplateFiles(templateDir, scope.glob ?? '**/*', {
    base: scope.root ?? scope.base,
    exclude: scope.exclude,
    mode,
  }).catch(error => {
    if (isRecord(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  return { mode, files };
}

function normalizeScopedOutputPath(path: string): string {
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.includes('\0')) {
    throw new CyanError(
      problem('validation', 'unsafe_processor_output_path', `Processor returned an unsafe output path: ${path}`, {
        path,
      }),
    );
  }
  const parts = path.split(/[\\/]+/).filter(part => part && part !== '.');
  if (parts.length === 0 || parts.some(part => part === '..')) {
    throw new CyanError(
      problem('validation', 'unsafe_processor_output_path', `Processor returned an unsafe output path: ${path}`, {
        path,
      }),
    );
  }
  return parts.join('/');
}

function artifactFileScopes(use: CyanArtifactUse): CyanFileGlob[] {
  if (Array.isArray(use.files)) {
    return use.files;
  }
  return [];
}

function fileScopeMode(scope: CyanFileGlob): 'template' | 'copy' {
  const type = scope.type?.toLowerCase();
  return scope.mode ?? (type === 'copy' ? 'copy' : 'template');
}

function normalizeScopeRoot(root: string | undefined): string {
  return (root ?? '')
    .split(/[\\/]+/)
    .filter(part => part && part !== '.')
    .join('/');
}

async function writeVfsFile(outDir: string, file: VfsFile): Promise<void> {
  const target = safeJoin(outDir, file.path);
  if (file.bytesBase64 !== undefined) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.bytesBase64, 'base64'));
    return;
  }
  await writeText(target, file.content ?? '');
}

async function readOutputFiles(outDir: string): Promise<VfsFile[]> {
  const files: VfsFile[] = [];
  await walkOutputFiles(outDir, async path => {
    const relativePath = relative(outDir, path);
    if (relativePath === '.cyan_state.yaml' || relativePath.startsWith('.cyan_conflicts/')) {
      return;
    }
    const bytes = await readFile(path);
    const text = decodeText(bytes);
    files.push(
      text === undefined
        ? { path: relativePath, bytesBase64: Buffer.from(bytes).toString('base64') }
        : { path: relativePath, content: text },
    );
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readOutputFilePathsIfExists(outDir: string): Promise<Set<string>> {
  const info = await stat(outDir).catch(() => undefined);
  if (!info?.isDirectory()) {
    return new Set();
  }
  return new Set((await readOutputFiles(outDir)).map(file => file.path));
}

async function walkOutputFiles(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkOutputFiles(path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    }
  }
}

function decodeText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

function mergeArtifactUses(
  target: CreateProjectResult['artifactUses'],
  source: CreateProjectResult['artifactUses'],
): void {
  target.processors.push(...source.processors);
  target.plugins.push(...source.plugins);
  target.resolvers.push(...source.resolvers);
  target.templates.push(...source.templates);
}

function artifactKey(dependency: ArtifactDependency | CyanArtifactUse, defaultOwner: string): string {
  return `${dependency.kind}:${dependency.owner ?? defaultOwner}:${dependency.name}:${dependency.version ?? ''}`;
}

function normalizeArtifactUse(use: CyanArtifactUse, defaultOwner: string): NormalizedArtifactUse {
  const kind = use.kind;
  if (!kind) {
    throw new CyanError(
      problem('validation', 'missing_artifact_kind', `Artifact use is missing a kind: ${use.name}`, { use }),
    );
  }
  const parsed = parseArtifactName(use.name);
  return { ...use, kind, owner: use.owner ?? parsed.owner ?? defaultOwner, name: parsed.name };
}

async function templateBundleRef(templateDir: string, manifest: CyanManifest): Promise<ArtifactBundleRef> {
  const runtimeFile = safeJoin(templateDir, manifest.bundledEntry);
  await stat(runtimeFile);
  return {
    dependency: {
      kind: manifest.kind,
      owner: manifest.owner,
      name: manifest.name,
      version: manifest.version ?? 'local',
    },
    runtimeFile,
    integrity: sha256(await readFile(runtimeFile)),
  };
}

async function resolveDevTemplateDir(args: {
  workspaceRoot: string;
  templateDir: string;
  dependency: ArtifactDependency | CyanArtifactUse;
  defaultOwner: string;
  localFallback?: boolean;
}): Promise<string> {
  const cached = await readCachedTemplateDir(args.templateDir, args.dependency, args.defaultOwner);
  if (cached) {
    return cached;
  }
  if (args.localFallback === false || process.env.CYANPRINT_DISABLE_LOCAL_ARTIFACT_FALLBACK === '1') {
    throw new Error(
      `Local template fallback is disabled and no cached template was found for ${args.dependency.owner ?? args.defaultOwner}/${args.dependency.name}`,
    );
  }
  for (const root of await findTemplateRoots(args.templateDir, args.workspaceRoot)) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = join(root, entry.name);
      if (!(await stat(join(candidate, 'cyan.yaml')).catch(() => undefined))) {
        continue;
      }
      const { manifest } = await loadManifest(candidate);
      if (
        (manifest.kind === 'template' || manifest.kind === 'template-group') &&
        manifest.owner === (args.dependency.owner ?? args.defaultOwner) &&
        manifest.name === args.dependency.name &&
        (!args.dependency.version || manifest.version === args.dependency.version)
      ) {
        return candidate;
      }
    }
  }
  throw new Error(
    `Unable to resolve child template ${args.dependency.owner ?? args.defaultOwner}/${args.dependency.name}`,
  );
}

async function readCachedTemplateDir(
  templateDir: string,
  dependency: ArtifactDependency | CyanArtifactUse,
  defaultOwner: string,
): Promise<string | undefined> {
  const raw = await readFile(join(templateDir, '.cyan_artifact_bundles.json'), 'utf8').catch(() => undefined);
  if (!raw) {
    return undefined;
  }
  const index = JSON.parse(raw) as {
    bundles?: Array<{ key: string; runtimeFile: string }>;
  };
  const owner = dependency.owner ?? defaultOwner;
  const exactKey = artifactKey(dependency, defaultOwner);
  const unversionedKey = `${dependency.kind}:${owner}:${dependency.name}`;
  const match = index.bundles?.find(bundle => {
    if (bundle.key === exactKey || (!dependency.version && bundle.key === unversionedKey)) {
      return true;
    }
    if (dependency.version) {
      return false;
    }
    const [kind, bundleOwner, name] = bundle.key.split(':');
    return kind === dependency.kind && bundleOwner === owner && name === dependency.name;
  });
  return match ? await findManifestRootFromRuntime(match.runtimeFile) : undefined;
}

async function findManifestRootFromRuntime(runtimeFile: string): Promise<string> {
  let current = dirname(runtimeFile);
  while (true) {
    if (await stat(join(current, 'cyan.yaml')).catch(() => undefined)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(`Unable to locate cyan.yaml for cached template runtime: ${runtimeFile}`);
}

async function findTemplateRoots(...starts: string[]): Promise<string[]> {
  const roots = new Set<string>();
  for (const start of starts) {
    let current = resolve(start);
    const currentInfo = await stat(current).catch(() => undefined);
    if (currentInfo?.isFile()) {
      current = dirname(current);
    }
    while (true) {
      for (const relative of ['examples/templates', 'examples/template-groups']) {
        const candidate = join(current, relative);
        const info = await stat(candidate).catch(() => undefined);
        if (info?.isDirectory()) {
          roots.add(candidate);
        }
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return [...roots];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
