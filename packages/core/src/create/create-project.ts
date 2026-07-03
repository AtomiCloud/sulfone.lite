import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  invokePlugin,
  invokeProcessor,
  invokeResolver,
  overlayFiles,
  type ArtifactBundleRef,
} from '@cyanprint/artifact-runner';
import type {
  Answers,
  ArtifactDependency,
  ArtifactKind,
  CompatibilityWarning,
  CyanArtifactUse,
  CyanCommandIntent,
  CyanFileGlob,
  CyanManifest,
  InstalledTemplate,
  KindedArtifactRef,
  PromptAdapter,
  Provenance,
  ResolverDeclaration,
  VfsFile,
} from '@cyanprint/contracts';
import { CyanError, declaredDependencyKeys, problem } from '@cyanprint/contracts';
import type { TraceCollector, TraceNode } from '../trace/trace-types';
import { loadManifest } from '../manifest/load-manifest';
import { resolveDevArtifactBundle } from '../artifacts/dev-artifact-resolver';
import { processorCacheKey, readProcessorCache, writeProcessorCache } from '../cache/processor-cache';
import { resolveLayers, type ResolutionLayer, type ResolverInvoker } from '../merge/resolve-layers';
import { executeCyanScript, globTemplateFiles } from '../scripts/load-cyan-script';
import {
  activeTemplates,
  buildGeneratedState,
  currentHistoryEntry,
  hasGeneratedState,
  loadGeneratedState,
  upsertInstalledTemplate,
  writeGeneratedState,
} from '../state/generated-state';
import { gitThreeWayMerge, type GitThreeWayMergeResult } from '../update/git-merge';
import {
  assertRootSafeDelete,
  comparePaths,
  decodeText,
  fileSha,
  isRecord,
  pruneEmptyDirs,
  safeJoin,
  sha256,
  stableConfig,
  writeVfsFile,
} from '../util';

/**
 * A generation step, emitted as it starts: which template is generating, which
 * processor/plugin is running, which resolver is merging (detail = path), or which
 * post-generation command is executing.
 */
export type GenerationProgressEvent = {
  kind: 'template' | 'processor' | 'plugin' | 'resolver' | 'command';
  ref: string;
  detail?: string;
};

/** Resolve an installed template's recorded source (+ optional version) to a template dir. */
export type TemplateSourceResolver = (args: { source: string; version?: string }) => Promise<string>;

export type CreateProjectOptions = {
  template: string;
  outDir: string;
  answers?: Answers;
  deterministicState?: Record<string, unknown>;
  headless?: boolean;
  json?: boolean;
  localFallback?: boolean;
  promptAdapter?: PromptAdapter;
  trace?: TraceCollector;
  onProgress?: (event: GenerationProgressEvent) => void;
  /** Resolvable source recorded in state (registry ref or local path). Defaults to the template dir. */
  templateSource?: string;
  /**
   * Registry-assigned version to record in state. Hydrated registry manifests are
   * versionless, so the resolver that fetched the artifact must supply this; without it
   * update's base regeneration cannot pin the old version.
   */
  templateVersion?: string;
  /** Resolves other installed templates' sources during create-into-existing-project. */
  resolveTemplateSource?: TemplateSourceResolver;
  cacheDir?: string;
  bypassCache?: boolean;
};

export type CreateProjectResult = {
  status: 'done' | 'conflict';
  outputPath: string;
  files: VfsFile[];
  artifactBundles: ArtifactBundleRef[];
  /** Paths left with in-file git conflict markers (create into an existing project only). */
  conflicts: string[];
  docker: false;
  daemon: false;
  remoteExecution: false;
};

export async function createProject(options: CreateProjectOptions): Promise<CreateProjectResult> {
  if (await hasGeneratedState(options.outDir)) {
    return await createIntoExistingProject(options);
  }
  return await createFreshProject(options);
}

async function createFreshProject(options: CreateProjectOptions): Promise<CreateProjectResult> {
  const generation = await generateTemplateTree(options);
  const generatedPaths = new Set(generation.files.map(file => file.path));

  await mkdir(options.outDir, { recursive: true });
  for (const file of generation.files) {
    await writeVfsFile(options.outDir, file);
  }

  const preCommandFiles = await readProjectFiles(options.outDir);
  const commandFailure = await runPostGenerationCommands(generation.commands, options, generation.warnings);

  const finalFiles = await readFinalProjectFiles(options.outDir, generatedPaths, preCommandFiles);
  const commandSources = diffCommandSources(preCommandFiles, finalFiles, generation.ref);
  const provenance = assembleProvenance(generation.decisions, finalFiles, generation.sources, commandSources);
  const time = new Date().toISOString();
  await writeGeneratedState(
    options.outDir,
    buildGeneratedState({
      templates: upsertInstalledTemplate([], {
        owner: generation.manifest.owner,
        name: generation.manifest.name,
        version: options.templateVersion ?? generation.manifest.version ?? 'local',
        source: options.templateSource ?? resolve(options.template),
        time,
        answers: generation.answers,
        deterministicState: generation.deterministicState,
        artifacts: generation.artifacts,
      }),
      files: finalFiles,
      provenance,
    }),
  );

  reportWarnings(generation.warnings, options.json);
  if (commandFailure) {
    throw commandFailure;
  }

  return {
    status: 'done',
    outputPath: options.outDir,
    files: finalFiles,
    artifactBundles: generation.bundles,
    conflicts: [],
    docker: false,
    daemon: false,
    remoteExecution: false,
  };
}

/**
 * Multi-install (iridium parity): `create` into a directory that already has
 * `.cyan_state.yaml` upserts the template into the state. The new template's output is
 * layered over the existing installation via tier-3 (sibling) resolution, then
 * three-way merged with the user's local files through git.
 */
async function createIntoExistingProject(options: CreateProjectOptions): Promise<CreateProjectResult> {
  const state = await loadGeneratedState(options.outDir);
  const resolveSource = options.resolveTemplateSource ?? defaultTemplateSourceResolver;

  const { manifest: nextManifest } = await loadManifest(options.template);
  const installed = activeTemplates(state);
  const existingEntry = installed.find(entry => entry.owner === nextManifest.owner && entry.name === nextManifest.name);
  // Re-creating an installed template must reuse its recorded deterministic state —
  // regenerating fresh random values would break determinism and cause phantom diffs.
  const seededDeterministicState = existingEntry
    ? { ...currentHistoryEntry(existingEntry).deterministicState, ...(options.deterministicState ?? {}) }
    : options.deterministicState;
  const nextGeneration = await generateTemplateTree({ ...options, deterministicState: seededDeterministicState });
  const nextOwner = nextGeneration.manifest.owner;
  const nextName = nextGeneration.manifest.name;
  const others = installed.filter(entry => entry !== existingEntry);

  const otherGenerations: Array<{ entry: InstalledTemplate; generation: TreeGeneration }> = [];
  for (const entry of others) {
    otherGenerations.push({ entry, generation: await regenerateInstalledTemplate(entry, resolveSource, options) });
  }

  const baseGenerations = [...otherGenerations];
  if (existingEntry) {
    baseGenerations.push({
      entry: existingEntry,
      generation: await regenerateInstalledTemplate(existingEntry, resolveSource, options),
    });
  }
  const base = await resolveSiblingTier(sortByInstalledAt(baseGenerations), options);

  const time = new Date().toISOString();
  const theirsGenerations = sortByInstalledAt([
    ...otherGenerations,
    {
      entry: {
        installedAt: existingEntry?.installedAt ?? time,
        owner: nextOwner,
        name: nextName,
      } as InstalledTemplate,
      generation: nextGeneration,
    },
  ]);
  const theirs = await resolveSiblingTier(theirsGenerations, options);

  const ours = await readProjectFiles(options.outDir);
  const merge = await gitThreeWayMerge({ base: base.files, ours, theirs: theirs.files });
  await applyMergedTree(options.outDir, merge);

  // A conflicted merge leaves the workspace with in-file markers: state must not
  // advance (a retry then re-merges from the ORIGINAL base instead of treating the
  // half-accepted incoming tree as the new baseline), and post-generation commands
  // must not run over marker-bearing files.
  let commandFailure: CyanError | undefined;
  if (merge.conflicts.length > 0) {
    nextGeneration.warnings.push({
      code: 'merge_conflicts_pending',
      message:
        'Merge conflicts left in-file; post-generation commands were skipped and .cyan_state.yaml was not advanced. ' +
        'Resolve the markers, then re-run the command.',
    });
  } else {
    const preCommandFiles = await readProjectFiles(options.outDir);
    commandFailure = await runPostGenerationCommands(nextGeneration.commands, options, nextGeneration.warnings);
    // Re-read the post-command tree so files a command created or changed land in state
    // and provenance — parity with a fresh create, which snapshots after commands run.
    // Without this the upsert persists the pre-command file set and silently drops them.
    const finalFiles = await readFinalProjectFiles(
      options.outDir,
      new Set(theirs.files.map(file => file.path)),
      preCommandFiles,
    );
    // Only the incoming template's commands ran, so its ref owns every command effect.
    const commandSources = diffCommandSources(preCommandFiles, finalFiles, nextGeneration.ref);
    await writeGeneratedState(
      options.outDir,
      buildGeneratedState({
        templates: upsertInstalledTemplate(state.templates, {
          owner: nextOwner,
          name: nextName,
          version: options.templateVersion ?? nextGeneration.manifest.version ?? 'local',
          source: options.templateSource ?? resolve(options.template),
          time,
          answers: nextGeneration.answers,
          deterministicState: nextGeneration.deterministicState,
          artifacts: nextGeneration.artifacts,
        }),
        files: finalFiles,
        provenance: assembleTierProvenance(
          theirsGenerations,
          { files: finalFiles, decisions: theirs.decisions },
          commandSources,
        ),
      }),
    );
  }

  reportWarnings(nextGeneration.warnings, options.json);
  if (commandFailure) {
    throw commandFailure;
  }

  return {
    status: merge.conflicts.length > 0 ? 'conflict' : 'done',
    outputPath: options.outDir,
    files: merge.files,
    artifactBundles: nextGeneration.bundles,
    conflicts: merge.conflicts,
    docker: false,
    daemon: false,
    remoteExecution: false,
  };
}

export async function regenerateInstalledTemplate(
  entry: InstalledTemplate,
  resolveSource: TemplateSourceResolver,
  options: {
    localFallback?: boolean;
    cacheDir?: string;
    bypassCache?: boolean;
    onProgress?: (event: GenerationProgressEvent) => void;
  },
  override?: { templateDir?: string; answers?: Answers; promptAdapter?: PromptAdapter; headless?: boolean },
): Promise<TreeGeneration> {
  const history = currentHistoryEntry(entry);
  const templateDir = override?.templateDir ?? (await resolveSource({ source: entry.source, version: entry.version }));
  return await generateTemplateTree({
    template: templateDir,
    answers: { ...history.answers, ...(override?.answers ?? {}) },
    deterministicState: history.deterministicState,
    headless: override?.headless ?? true,
    promptAdapter: override?.promptAdapter,
    localFallback: options.localFallback,
    cacheDir: options.cacheDir,
    bypassCache: options.bypassCache,
    onProgress: options.onProgress,
  });
}

export const defaultTemplateSourceResolver: TemplateSourceResolver = async ({ source }) => {
  if (await stat(join(source, 'cyan.yaml')).catch(() => undefined)) {
    return source;
  }
  throw new CyanError(
    problem(
      'validation',
      'unresolvable_template_source',
      `Cannot resolve installed template source "${source}" to a template directory. ` +
        'Registry sources need a registry-aware resolver (run through the CLI).',
    ),
  );
};

export function sortByInstalledAt<T extends { entry: { installedAt: string } }>(items: T[]): T[] {
  return [...items].sort((left, right) =>
    left.entry.installedAt < right.entry.installedAt ? -1 : left.entry.installedAt > right.entry.installedAt ? 1 : 0,
  );
}

/**
 * Tier 3 — sibling installations: each installed template's final output is one layer,
 * ordered by installation time (most recently installed wins LWW). Single-install
 * projects have one layer and resolve trivially.
 */
export async function resolveSiblingTier(
  generations: Array<{ entry: { installedAt: string }; generation: TreeGeneration }>,
  options: { onProgress?: (event: GenerationProgressEvent) => void },
): Promise<{ files: VfsFile[]; decisions: Provenance[] }> {
  const layers: ResolutionLayer[] = generations.map(item => ({
    template: item.generation.ref,
    files: item.generation.files,
    resolvers: item.generation.resolvers,
  }));
  const bundles = new Map<string, ArtifactBundleRef>();
  for (const item of generations) {
    for (const bundle of item.generation.bundles) {
      bundles.set(bundleKey(bundle.dependency.kind, bundle.dependency), bundle);
    }
  }
  const invoker = makeResolverInvoker(bundles, options.onProgress);
  return await resolveLayers({ layers, segment: 'sibling', invokeResolver: invoker });
}

// ---------------------------------------------------------------------------
// Single-template tree generation (tiers 1 and 2)
// ---------------------------------------------------------------------------

export type TreeGeneration = {
  manifest: CyanManifest;
  /** `owner/name@version` (version `local` when unversioned). */
  ref: string;
  files: VfsFile[];
  /** Root template's `resolvers:` declarations — its tier-3 nomination source. */
  resolvers: ResolverDeclaration[];
  commands: CyanCommandIntent[];
  decisions: Provenance[];
  /** Deep first-contributor attribution per path, for `added` provenance. */
  sources: Map<string, string>;
  artifacts: InstalledTemplate['artifacts'];
  bundles: ArtifactBundleRef[];
  answers: Answers;
  deterministicState: Record<string, unknown>;
  warnings: CompatibilityWarning[];
};

type GenerationContext = {
  answers: Answers;
  deterministicState: Record<string, unknown>;
  interactive: boolean;
  bundles: Map<string, ArtifactBundleRef>;
  warnings: CompatibilityWarning[];
  localFallback?: boolean;
  promptAdapter?: PromptAdapter;
  seenTemplateRefs: Set<string>;
  decisions: Provenance[];
  sources: Map<string, string>;
  trace?: TraceCollector;
  traceNode?: { children: TraceNode[] };
  onProgress?: (event: GenerationProgressEvent) => void;
  cacheDir?: string;
  bypassCache?: boolean;
};

export async function generateTemplateTree(options: {
  template: string;
  answers?: Answers;
  deterministicState?: Record<string, unknown>;
  headless?: boolean;
  localFallback?: boolean;
  promptAdapter?: PromptAdapter;
  trace?: TraceCollector;
  onProgress?: (event: GenerationProgressEvent) => void;
  cacheDir?: string;
  bypassCache?: boolean;
}): Promise<TreeGeneration> {
  const answers = structuredClone(options.answers ?? {}) as Answers;
  const deterministicState = structuredClone(options.deterministicState ?? {}) as Record<string, unknown>;
  const context: GenerationContext = {
    answers,
    deterministicState,
    interactive: options.headless === false,
    bundles: new Map(),
    warnings: [],
    localFallback: options.localFallback,
    promptAdapter: options.promptAdapter,
    seenTemplateRefs: new Set(),
    decisions: [],
    sources: new Map(),
    trace: options.trace,
    traceNode: options.trace?.root,
    onProgress: options.onProgress,
    cacheDir: options.cacheDir,
    bypassCache: options.bypassCache,
  };
  const generated = await generateTemplate(options.template, context, new Set());
  return {
    manifest: generated.manifest,
    ref: generated.ref,
    files: generated.files,
    resolvers: generated.manifest.resolvers,
    commands: generated.commands,
    decisions: context.decisions,
    sources: context.sources,
    artifacts: [...context.bundles.values()].map(bundle => ({
      kind: bundle.dependency.kind,
      owner: bundle.dependency.owner ?? generated.manifest.owner,
      name: bundle.dependency.name,
      version: bundle.dependency.version ?? 'local',
      integrity: bundle.integrity ?? '',
    })),
    bundles: [...context.bundles.values()],
    answers: context.answers,
    deterministicState: context.deterministicState,
    warnings: context.warnings,
  };
}

type GeneratedTemplate = {
  manifest: CyanManifest;
  ref: string;
  files: VfsFile[];
  commands: CyanCommandIntent[];
};

async function generateTemplate(
  templateDir: string,
  context: GenerationContext,
  stack: Set<string>,
): Promise<GeneratedTemplate> {
  const { manifest, warnings } = await loadManifest(templateDir);
  context.warnings.push(...warnings);

  // Each template (owner:name, version-ignored) may appear only once in the whole composition.
  const templateRef = `${manifest.owner}:${manifest.name}`;
  if (context.seenTemplateRefs.has(templateRef)) {
    throw new CyanError(
      problem(
        'validation',
        'duplicate_template_dependency',
        `Template ${templateRef} is included more than once; each template may appear only once.`,
      ),
    );
  }
  context.seenTemplateRefs.add(templateRef);

  const stackKey = `${manifest.owner}:${manifest.name}:${resolve(templateDir)}`;
  if (stack.has(stackKey)) {
    throw new CyanError(problem('validation', 'template_cycle', `Template dependency cycle detected: ${stackKey}`));
  }
  stack.add(stackKey);
  try {
    return await generateTemplateLayers(templateDir, manifest, context, stack);
  } finally {
    stack.delete(stackKey);
  }
}

async function generateTemplateLayers(
  templateDir: string,
  manifest: CyanManifest,
  context: GenerationContext,
  stack: Set<string>,
): Promise<GeneratedTemplate> {
  const selfRef = templateRefOf(manifest);
  context.onProgress?.({ kind: 'template', ref: `${manifest.owner}/${manifest.name}` });

  // Child contexts are spread copies, so reassigning traceNode here nests children under
  // this node without disturbing the parent's pointer.
  let traceNode: TraceNode | undefined;
  if (context.trace) {
    traceNode = { ref: `${manifest.owner}/${manifest.name}`, kind: manifest.kind, ownFiles: [], children: [] };
    context.traceNode?.children.push(traceNode);
    context.traceNode = traceNode;
  }

  const templateBundle = await templateBundleRef(templateDir, manifest);
  context.bundles.set(bundleKey(manifest.kind, templateBundle.dependency), templateBundle);

  const commands: CyanCommandIntent[] = [];

  // Children generate first (deepest-first), so child answers always bubble up before
  // this template's cyan.ts runs. Dependency config is embedded in the templates: dict.
  const childLayers: ResolutionLayer[] = [];
  for (const dependency of manifest.templates) {
    seedDeterministic(context, dependency.deterministicState);
    const child = await executeChildTemplate(templateDir, dependency, manifest.owner, context, stack);
    childLayers.push({
      template: child.ref,
      files: child.files,
      resolvers: child.manifest.resolvers,
    });
    commands.push(...child.commands);
  }

  const scriptPath = safeJoin(templateDir, manifest.bundledEntry);
  const cyan = await executeCyanScript(
    scriptPath,
    context.answers,
    context.deterministicState,
    context.interactive,
    context.promptAdapter,
  );

  const cyanProcessors = normalizeReturnedArtifactUses(cyan.processors, manifest.owner);
  const cyanPlugins = normalizeReturnedArtifactUses(cyan.plugins, manifest.owner);
  applyDeclaredArtifactVersions(cyanProcessors, manifest.processors, manifest.owner);
  applyDeclaredArtifactVersions(cyanPlugins, manifest.plugins, manifest.owner);
  assertDeclaredArtifacts(cyanProcessors, manifest.processors, manifest.owner, 'processor');
  assertDeclaredArtifacts(cyanPlugins, manifest.plugins, manifest.owner, 'plugin');

  const resolveArtifact = async (kind: ArtifactKind, dependency: NormalizedArtifactUse): Promise<ArtifactBundleRef> => {
    const key = bundleKey(kind, { ...dependency, owner: dependency.owner ?? manifest.owner });
    const existing = context.bundles.get(key);
    if (existing) {
      return existing;
    }
    const bundle = await resolveDevArtifactBundle({
      workspaceRoot: process.cwd(),
      templateDir,
      kind,
      dependency,
      defaultOwner: manifest.owner,
      localFallback: context.localFallback,
    });
    context.bundles.set(key, bundle);
    return bundle;
  };

  // Resolver declarations come from cyan.yaml only; pre-resolve their bundles so tiers
  // above this node (and this node's own tiers) can invoke them.
  for (const declaration of manifest.resolvers) {
    await resolveArtifact('resolver', {
      owner: declaration.owner,
      name: declaration.name,
      version: declaration.version,
    });
  }

  // Tier 1 — processor outputs. Each processor invocation is hermetic: its input is its
  // declared file scopes (never a previous processor's output), so its output is a pure
  // function of (artifact integrity, config, input file set) and cacheable.
  const artifactPipelineState: ArtifactPipelineState = { scopes: new Map() };
  const processorLayers: ResolutionLayer[] = [];
  for (const [invocation, processor] of cyanProcessors.entries()) {
    context.onProgress?.({
      kind: 'processor',
      ref: `${processor.owner}/${processor.name}`,
      detail: `${manifest.owner}/${manifest.name}`,
    });
    const bundle = await resolveArtifact('processor', processor);
    const output = await invokeProcessorForUse(bundle, processor, templateDir, artifactPipelineState, context);
    processorLayers.push({
      template: selfRef,
      files: output,
      resolvers: manifest.resolvers,
      processor: { ref: `${processor.owner}/${processor.name}`, invocation },
    });
  }
  const invoker = makeResolverInvoker(context.bundles, context.onProgress);
  const tierOne = await resolveLayers({ layers: processorLayers, segment: 'processor', invokeResolver: invoker });
  context.decisions.push(...tierOne.decisions);
  let ownFiles = tierOne.files;

  // Plugins transform the template's now-single own layer.
  for (const plugin of cyanPlugins) {
    context.onProgress?.({
      kind: 'plugin',
      ref: `${plugin.owner}/${plugin.name}`,
      detail: `${manifest.owner}/${manifest.name}`,
    });
    const bundle = await resolveArtifact('plugin', plugin);
    ownFiles = await invokePluginForUse(bundle, ownFiles, plugin, templateDir, artifactPipelineState);
  }

  for (const file of ownFiles) {
    if (!context.sources.has(file.path)) {
      context.sources.set(file.path, selfRef);
    }
  }
  if (traceNode) {
    traceNode.ownFiles = ownFiles.map(file => ({ ...file }));
  }

  // Tier 2 — dependency tree: all dependency layers (each child's fully merged subtree
  // output, in declaration order) plus this template's own post-plugin layer, own last
  // so self wins LWW. One global resolution covers dep-vs-dep and dep-vs-self.
  const tierTwo = await resolveLayers({
    layers: [...childLayers, { template: selfRef, files: ownFiles, resolvers: manifest.resolvers }],
    segment: 'dependency',
    invokeResolver: invoker,
  });
  context.decisions.push(...tierTwo.decisions);
  for (const decision of tierTwo.decisions) {
    context.sources.set(decision.path, decision.source);
  }

  for (const command of cyan.commands ?? []) {
    commands.push(command);
  }

  return { manifest, ref: selfRef, files: tierTwo.files, commands };
}

async function executeChildTemplate(
  parentDir: string,
  dependency: CyanManifest['templates'][number],
  defaultOwner: string,
  context: GenerationContext,
  stack: Set<string>,
): Promise<GeneratedTemplate> {
  const childDir = await resolveDevTemplateDir({
    workspaceRoot: process.cwd(),
    templateDir: parentDir,
    dependency,
    defaultOwner,
    localFallback: context.localFallback,
  });
  // `answers` embedded in the templates: dict seed the child's answer bag before it
  // generates, so they also reach the child's own descendants via normal answer sharing.
  const childContext = {
    ...context,
    answers: { ...structuredClone(context.answers), ...structuredClone(dependency.answers) },
  };
  const child = await generateTemplate(childDir, childContext, stack);
  for (const [key, value] of Object.entries(childContext.answers)) {
    if (!(key in context.answers)) {
      context.answers[key] = value;
    }
  }
  return child;
}

function seedDeterministic(context: GenerationContext, deterministic: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(deterministic)) {
    if (!(key in context.deterministicState)) {
      context.deterministicState[key] = value;
    }
  }
}

function templateRefOf(manifest: CyanManifest): string {
  return `${manifest.owner}/${manifest.name}@${manifest.version ?? 'local'}`;
}

function makeResolverInvoker(
  bundles: Map<string, ArtifactBundleRef>,
  onProgress?: (event: GenerationProgressEvent) => void,
): ResolverInvoker {
  return async ({ resolver, path, files }) => {
    const key = bundleKey('resolver', resolver);
    const bundle =
      bundles.get(key) ??
      bundles.get(bundleKey('resolver', { ...resolver, version: undefined })) ??
      findBundleByName(bundles, 'resolver', resolver);
    if (!bundle) {
      throw new CyanError(
        problem(
          'execution',
          'resolver_bundle_missing',
          `Resolver ${resolver.owner}/${resolver.name} was nominated for ${path} but its bundle was not resolved.`,
        ),
      );
    }
    onProgress?.({ kind: 'resolver', ref: `${resolver.owner}/${resolver.name}`, detail: path });
    const output = await invokeResolver(bundle, { config: resolver.config, files });
    return output.content;
  };
}

function findBundleByName(
  bundles: Map<string, ArtifactBundleRef>,
  kind: ArtifactKind,
  ref: { owner?: string; name: string },
): ArtifactBundleRef | undefined {
  for (const bundle of bundles.values()) {
    if (
      bundle.dependency.kind === kind &&
      bundle.dependency.name === ref.name &&
      (!ref.owner || bundle.dependency.owner === ref.owner)
    ) {
      return bundle;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// cyan.ts artifact uses (processors and plugins only)
// ---------------------------------------------------------------------------

type NormalizedArtifactUse = CyanArtifactUse & { owner: string };

function normalizeReturnedArtifactUses(
  uses: CyanArtifactUse[] | undefined,
  defaultOwner: string,
): NormalizedArtifactUse[] {
  return (uses ?? []).map(use => {
    const parsed = parseArtifactName(use.name);
    return {
      ...use,
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

function assertDeclaredArtifacts(
  uses: NormalizedArtifactUse[],
  declared: ArtifactDependency[],
  owner: string,
  kindLabel: string,
): void {
  const keys = declaredDependencyKeys(declared, owner);
  for (const use of uses) {
    const key = `${use.owner}:${use.name}`;
    const declaredKey = use.version ? `${key}@${use.version}` : key;
    if (!keys.has(declaredKey)) {
      throw new CyanError(
        problem(
          'validation',
          'undeclared_artifact',
          `cyan.ts returned ${kindLabel} ${declaredKey}, but cyan.yaml does not declare it.`,
          { key: declaredKey },
        ),
      );
    }
  }
}

function applyDeclaredArtifactVersions(
  uses: NormalizedArtifactUse[],
  declared: ArtifactDependency[],
  owner: string,
): void {
  const versions = new Map<string, Set<string>>();
  for (const ref of declared) {
    if (!ref.version) {
      continue;
    }
    const key = `${ref.owner ?? owner}:${ref.name}`;
    const refVersions = versions.get(key) ?? new Set<string>();
    refVersions.add(ref.version);
    versions.set(key, refVersions);
  }
  for (const use of uses) {
    if (use.version) {
      continue;
    }
    const declaredVersions = versions.get(`${use.owner}:${use.name}`);
    if (declaredVersions?.size === 1) {
      use.version = [...declaredVersions][0];
    }
  }
}

// ---------------------------------------------------------------------------
// Processor / plugin invocation (hermetic; processor outputs cached)
// ---------------------------------------------------------------------------

async function invokeProcessorForUse(
  bundle: ArtifactBundleRef,
  processor: NormalizedArtifactUse,
  templateDir: string,
  artifactPipelineState: ArtifactPipelineState,
  context: GenerationContext,
): Promise<VfsFile[]> {
  const scopes = artifactFileScopes(processor);
  const inputFiles = await loadArtifactScopeFiles(templateDir, processor, artifactPipelineState);
  const cacheKey =
    bundle.integrity !== undefined
      ? processorCacheKey({ integrity: bundle.integrity, config: processor.config, inputFiles })
      : undefined;
  if (cacheKey && !context.bypassCache) {
    const cached = await readProcessorCache({ key: cacheKey, cacheDir: context.cacheDir });
    if (cached) {
      return cached;
    }
  }
  const output =
    scopes.length === 0
      ? await invokeProcessor(bundle, [], processor.config)
      : await applyArtifactFileScopes(templateDir, processor, artifactPipelineState, selected =>
          invokeProcessor(bundle, selected, processor.config, { preservePrevious: false }),
        );
  if (cacheKey) {
    await writeProcessorCache({ key: cacheKey, files: output, cacheDir: context.cacheDir });
  }
  return output;
}

async function invokePluginForUse(
  bundle: ArtifactBundleRef,
  files: VfsFile[],
  plugin: NormalizedArtifactUse,
  templateDir: string,
  artifactPipelineState: ArtifactPipelineState,
): Promise<VfsFile[]> {
  const scopedFiles = await loadArtifactScopeFiles(templateDir, plugin, artifactPipelineState);
  return invokePlugin(bundle, overlayFiles(files, scopedFiles), plugin.config);
}

type ArtifactPipelineState = {
  scopes: Map<string, { mode: 'template' | 'copy'; files: VfsFile[] }>;
};

async function applyArtifactFileScopes(
  templateDir: string,
  use: NormalizedArtifactUse,
  artifactPipelineState: ArtifactPipelineState,
  invoke: (selected: VfsFile[]) => Promise<VfsFile[]>,
): Promise<VfsFile[]> {
  const scopes = artifactFileScopes(use);
  let output: VfsFile[] = [];
  for (const scope of scopes) {
    const scopeState = await loadScopeState(templateDir, scope, artifactPipelineState);
    if (scopeState.mode === 'copy') {
      output = overlayFiles(output, scopeState.files);
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
      output = overlayFiles(output, transformed);
      continue;
    }
  }
  return output;
}

async function loadArtifactScopeFiles(
  templateDir: string,
  use: NormalizedArtifactUse,
  artifactPipelineState: ArtifactPipelineState,
): Promise<VfsFile[]> {
  let output: VfsFile[] = [];
  for (const scope of artifactFileScopes(use)) {
    const scopeState = await loadScopeState(templateDir, scope, artifactPipelineState);
    output = overlayFiles(output, scopeState.files);
  }
  return output;
}

async function loadScopeState(
  templateDir: string,
  scope: CyanFileGlob,
  artifactPipelineState: ArtifactPipelineState,
): Promise<{ mode: 'template' | 'copy'; files: VfsFile[] }> {
  const scopeKey = artifactFileScopeKey(scope);
  let scopeState = artifactPipelineState.scopes.get(scopeKey);
  if (!scopeState) {
    const loaded = await loadScopeFiles(templateDir, scope);
    scopeState = { mode: loaded.mode, files: loaded.files };
    artifactPipelineState.scopes.set(scopeKey, scopeState);
  }
  return scopeState;
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

// ---------------------------------------------------------------------------
// Output IO, provenance assembly, commands
// ---------------------------------------------------------------------------

/** Write a merged working tree back to the project: merge deletions first, then changed files. */
export async function applyMergedTree(outDir: string, merge: GitThreeWayMergeResult): Promise<void> {
  // Deletions must land before writes: a merge can replace a file with a directory (or a
  // directory with a file), and writing first hits the stale entry still on disk (EEXIST
  // from mkdir over the old file, EISDIR writing over the old directory).
  for (const path of merge.deletions) {
    // Guard the delete vector the way `writeVfsFile` guards writes: a symlinked parent component
    // would make `rm` follow the link and unlink a file outside the project root.
    await assertRootSafeDelete(outDir, path);
    await rm(safeJoin(outDir, path), { force: true }).catch(() => undefined);
    await pruneEmptyDirs(outDir, path);
  }
  for (const file of merge.files) {
    await writeVfsFile(outDir, file);
  }
}

/**
 * Provenance for a tier-3 layered result: every contributing generation's own decisions
 * plus the sibling-tier decisions, with `added` attribution from the first contributor.
 */
export function assembleTierProvenance(
  generations: Array<{ generation: TreeGeneration }>,
  tier: { files: VfsFile[]; decisions: Provenance[] },
  commandSources?: Map<string, string>,
): Provenance[] {
  const decisions = [...generations.flatMap(item => item.generation.decisions), ...tier.decisions];
  const sources = new Map<string, string>();
  for (const item of generations) {
    for (const [path, source] of item.generation.sources) {
      if (!sources.has(path)) {
        sources.set(path, source);
      }
    }
  }
  return assembleProvenance(decisions, tier.files, sources, commandSources);
}

/** Every merge decision plus an `added` record for each final path that never conflicted. */
export function assembleProvenance(
  decisions: Provenance[],
  finalFiles: VfsFile[],
  sources: Map<string, string>,
  commandSources?: Map<string, string>,
): Provenance[] {
  const decided = new Set(decisions.map(decision => decision.path));
  const added: Provenance[] = finalFiles
    .filter(file => !decided.has(file.path))
    .map(file => ({
      path: file.path,
      // Generation sources cover the generated tree; a final path outside it was created
      // by a post-generation command and belongs to the template whose command ran.
      source: sources.get(file.path) ?? commandSources?.get(file.path) ?? 'unknown',
      decision: 'added' as const,
    }));
  return [...decisions, ...added].sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * Attribute a command batch's effects to the template whose commands ran: every path that
 * is new or whose bytes changed against the pre-command snapshot. Gives command-created
 * files a real `added` source (generation sources only cover the generated tree).
 */
export function diffCommandSources(
  before: VfsFile[],
  after: VfsFile[],
  templateRef: string,
  into: Map<string, string> = new Map(),
): Map<string, string> {
  const priorShas = new Map(before.map(file => [file.path, fileSha(file)]));
  for (const file of after) {
    if (priorShas.get(file.path) !== fileSha(file)) {
      into.set(file.path, templateRef);
    }
  }
  return into;
}

/** Minimal context a command run needs: where to run and how to report progress. */
export type PostGenerationContext = {
  outDir: string;
  onProgress?: (event: GenerationProgressEvent) => void;
};

export async function runPostGenerationCommands(
  commands: CyanCommandIntent[],
  ctx: PostGenerationContext,
  warnings: CompatibilityWarning[],
): Promise<CyanError | undefined> {
  for (const command of commands) {
    ctx.onProgress?.({ kind: 'command', ref: [command.command, ...(command.args ?? [])].join(' ') });
    const { runPostGenerationCommand } = await import('../commands/post-generation-command');
    const result = await runPostGenerationCommand({ ...command, cwd: ctx.outDir });
    if (!result.allowed) {
      warnings.push({
        code: 'post_generation_command_skipped',
        message: `Post-generation command skipped: ${command.command} — ${result.stderr ?? 'not allowed'}`,
      });
      continue;
    }
    if (result.exitCode !== 0) {
      // Defer the throw so generated state is still written; without it a later `update` cannot run.
      return new CyanError(
        problem('execution', 'post_generation_command_failed', `Post-generation command failed: ${command.command}`, {
          result,
        }),
      );
    }
  }
  return undefined;
}

export function reportWarnings(warnings: CompatibilityWarning[], json?: boolean): void {
  if (warnings.length > 0 && !json) {
    for (const warning of warnings) {
      console.warn(`${warning.code}: ${warning.message}`);
    }
  }
}

/** Read the project's files (everything except CyanPrint metadata and `.git/`). */
export async function readProjectFiles(projectDir: string): Promise<VfsFile[]> {
  const files: VfsFile[] = [];
  const info = await stat(projectDir).catch(() => undefined);
  if (!info?.isDirectory()) {
    return files;
  }
  await walkOutputFiles(projectDir, async path => {
    const relativePath = relative(projectDir, path)
      .split(/[\\/]+/)
      .join('/');
    if (relativePath === '.cyan_state.yaml' || relativePath === '.git' || relativePath.startsWith('.git/')) {
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
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * Snapshot the project after post-generation commands ran, keeping only files this
 * generation owns: the generated/merged tree (`generatedPaths`) plus anything a command
 * created or modified. `preCommandFiles` is the disk snapshot taken immediately before
 * the commands ran, so a file is a command effect when it is absent from that snapshot or
 * its bytes changed against it. Files that were already on disk and untouched (unrelated
 * user files) are excluded so they are not misattributed as generated. Shared by fresh
 * create, upsert, and update so command output is captured consistently on every path —
 * even when a command rewrites a file an earlier command produced.
 */
export async function readFinalProjectFiles(
  outDir: string,
  generatedPaths: Set<string>,
  preCommandFiles: VfsFile[],
): Promise<VfsFile[]> {
  const preShas = new Map(preCommandFiles.map(file => [file.path, fileSha(file)]));
  return (await readProjectFiles(outDir)).filter(file => {
    if (generatedPaths.has(file.path)) {
      return true;
    }
    const previous = preShas.get(file.path);
    return previous === undefined || previous !== fileSha(file);
  });
}

async function walkOutputFiles(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git') {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkOutputFiles(path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    }
  }
}

export function bundleKey(kind: ArtifactKind, dependency: ArtifactDependency): string {
  return `${kind}|${dependency.owner ?? 'local'}:${dependency.name}:${dependency.version ?? ''}`;
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
    } satisfies KindedArtifactRef,
    runtimeFile,
    integrity: sha256(await readFile(runtimeFile)),
  };
}

// ---------------------------------------------------------------------------
// Dev-time template dir resolution (registry-free fallback)
// ---------------------------------------------------------------------------

async function resolveDevTemplateDir(args: {
  workspaceRoot: string;
  templateDir: string;
  dependency: ArtifactDependency;
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
  dependency: ArtifactDependency,
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
  // Bundle index keys are registry-internal and carry the kind prefix; the template kind
  // is implied here by the templates: section the dependency came from.
  const exactKey = `template:${owner}:${dependency.name}:${dependency.version ?? ''}`;
  const unversionedKey = `template:${owner}:${dependency.name}`;
  const match = index.bundles?.find(bundle => {
    if (bundle.key === exactKey || (!dependency.version && bundle.key === unversionedKey)) {
      return true;
    }
    if (dependency.version) {
      return false;
    }
    const [kind, bundleOwner, name] = bundle.key.split(':');
    return (kind === 'template' || kind === 'template-group') && bundleOwner === owner && name === dependency.name;
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
      for (const relativeRoot of ['examples/templates', 'examples/template-groups']) {
        const candidate = join(current, relativeRoot);
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
