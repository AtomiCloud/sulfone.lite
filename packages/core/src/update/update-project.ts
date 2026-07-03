import type { Answers, CompatibilityWarning, InstalledTemplate, PromptAdapter } from '@cyanprint/contracts';
import { CyanError, problem } from '@cyanprint/contracts';
import {
  applyMergedTree,
  assembleTierProvenance,
  defaultTemplateSourceResolver,
  diffCommandSources,
  readFinalProjectFiles,
  readProjectFiles,
  regenerateInstalledTemplate,
  reportWarnings,
  resolveSiblingTier,
  runPostGenerationCommands,
  sortByInstalledAt,
  type GenerationProgressEvent,
  type TemplateSourceResolver,
  type TreeGeneration,
} from '../create/create-project';
import {
  activeTemplates,
  buildGeneratedState,
  currentHistoryEntry,
  loadGeneratedState,
  upsertInstalledTemplate,
  writeGeneratedState,
} from '../state/generated-state';
import { gitThreeWayMerge } from './git-merge';

export type UpdateProjectResult = {
  status: 'done' | 'conflict';
  outputPath: string;
  /** Paths left with in-file git conflict markers. */
  conflicts: string[];
  updated: Array<{ ref: string; from: string; to: string }>;
  reusedAnswers: string[];
};

/** Resolve where a template's update should come from: the new template dir + version. */
export type UpdateTargetResolver = (entry: InstalledTemplate) => Promise<{ templateDir: string; version: string }>;

/**
 * Iridium-exact update: every active template floats to latest (`--template` targets one;
 * `--interactive` lets the caller pick versions via `resolveUpdateTarget`). Base is
 * regenerated from recorded answers + old versions, theirs from the new versions, both
 * layered through tier-3; ours is the user's working tree; the three meet in a real git
 * merge with rename detection. Conflicts stay in-file as standard `<<<<<<<` markers.
 */
export async function updateProject(args: {
  projectDir: string;
  /** Only update the template matching this `owner/name` (or bare name). */
  template?: string;
  answers?: Answers;
  headless?: boolean;
  json?: boolean;
  localFallback?: boolean;
  promptAdapter?: PromptAdapter;
  onProgress?: (event: GenerationProgressEvent) => void;
  resolveTemplateSource?: TemplateSourceResolver;
  resolveUpdateTarget?: UpdateTargetResolver;
  cacheDir?: string;
  bypassCache?: boolean;
}): Promise<UpdateProjectResult> {
  const state = await loadGeneratedState(args.projectDir);
  const installed = activeTemplates(state);
  if (installed.length === 0) {
    throw new CyanError(problem('validation', 'no_active_templates', 'Project has no active templates to update.'));
  }
  const resolveSource = args.resolveTemplateSource ?? defaultTemplateSourceResolver;
  const resolveTarget: UpdateTargetResolver =
    args.resolveUpdateTarget ??
    (async entry => {
      const templateDir = await resolveSource({ source: entry.source });
      return { templateDir, version: entry.version };
    });

  const targets = args.template
    ? installed.filter(entry => matchesTemplateFilter(entry, args.template ?? ''))
    : installed;
  if (args.template && targets.length === 0) {
    throw new CyanError(
      problem('validation', 'unknown_update_template', `No active template matches --template ${args.template}.`),
    );
  }

  const generationOptions = {
    localFallback: args.localFallback,
    cacheDir: args.cacheDir,
    bypassCache: args.bypassCache,
    onProgress: args.onProgress,
  };

  // Base: every active template re-executed at its *old* version with its *saved*
  // answers + deterministic state. Nondeterminism here means phantom diffs — this is
  // why determinism is the core contract.
  const baseGenerations: Array<{ entry: InstalledTemplate; generation: TreeGeneration }> = [];
  for (const entry of installed) {
    baseGenerations.push({
      entry,
      generation: await regenerateInstalledTemplate(entry, resolveSource, generationOptions),
    });
  }

  // Theirs: targets execute their new versions, reusing saved answers (only new
  // questions prompt; prior values as defaults). Untouched templates reuse their base
  // generation — identical inputs, identical output.
  const updated: UpdateProjectResult['updated'] = [];
  const theirsGenerations: Array<{ entry: InstalledTemplate; generation: TreeGeneration; toVersion: string }> = [];
  for (const item of baseGenerations) {
    const isTarget = targets.includes(item.entry);
    if (!isTarget) {
      theirsGenerations.push({ ...item, toVersion: item.entry.version });
      continue;
    }
    const target = await resolveTarget(item.entry);
    const generation = await regenerateInstalledTemplate(item.entry, resolveSource, generationOptions, {
      templateDir: target.templateDir,
      answers: args.answers,
      promptAdapter: args.promptAdapter,
      headless: args.headless ?? true,
    });
    // Hydrated registry manifests are versionless — the resolved target version is the
    // authoritative one; an authored manifest version (local templates) wins when present.
    const toVersion = generation.manifest.version ?? target.version;
    theirsGenerations.push({ entry: item.entry, generation, toVersion });
    if (toVersion !== item.entry.version) {
      updated.push({ ref: `${item.entry.owner}/${item.entry.name}`, from: item.entry.version, to: toVersion });
    }
  }

  const base = await resolveSiblingTier(sortByInstalledAt(baseGenerations), generationOptions);
  const theirs = await resolveSiblingTier(sortByInstalledAt(theirsGenerations), generationOptions);
  const ours = await readProjectFiles(args.projectDir);

  const merge = await gitThreeWayMerge({ base: base.files, ours, theirs: theirs.files });
  await applyMergedTree(args.projectDir, merge);

  // Persist new state only for templates that actually changed version, and only when
  // the merge is conflict-free: with in-file markers pending, state must stay at the old
  // versions so a retry re-merges from the ORIGINAL base rather than treating the
  // half-accepted incoming tree as the new baseline.
  let commandFailure: CyanError | undefined;
  if (merge.conflicts.length === 0) {
    // Run the post-generation commands of the templates that actually changed version,
    // over the merged working tree (children's commands first), then snapshot the
    // post-command tree — parity with create, so command output lands in state and a
    // later update sees it as generated content rather than untracked user files.
    const commandWarnings: CompatibilityWarning[] = [];
    const changedTargets = theirsGenerations.filter(item => item.toVersion !== item.entry.version);
    const preCommandFiles = await readProjectFiles(args.projectDir);
    // Run each changed template's command batch separately and snapshot the tree between
    // batches, so every file a command created or rewrote is attributed to the template
    // whose command produced it (a later batch rewriting the same path wins). A failed
    // batch still gets its effects attributed; the remaining batches are skipped, matching
    // runPostGenerationCommands aborting a batch at its first failing command.
    const commandSources = new Map<string, string>();
    let commandSnapshot = preCommandFiles;
    for (const item of changedTargets) {
      commandFailure = await runPostGenerationCommands(
        item.generation.commands,
        { outDir: args.projectDir, onProgress: args.onProgress },
        commandWarnings,
      );
      const postBatch = await readProjectFiles(args.projectDir);
      diffCommandSources(commandSnapshot, postBatch, item.generation.ref, commandSources);
      commandSnapshot = postBatch;
      if (commandFailure) {
        break;
      }
    }
    const finalFiles = await readFinalProjectFiles(
      args.projectDir,
      new Set(theirs.files.map(file => file.path)),
      preCommandFiles,
    );

    const time = new Date().toISOString();
    let templates = state.templates;
    for (const item of theirsGenerations) {
      if (item.toVersion === item.entry.version) {
        continue;
      }
      templates = upsertInstalledTemplate(templates, {
        owner: item.entry.owner,
        name: item.entry.name,
        version: item.toVersion,
        source: item.entry.source,
        time,
        answers: item.generation.answers,
        deterministicState: item.generation.deterministicState,
        artifacts: item.generation.artifacts,
      });
    }
    await writeGeneratedState(
      args.projectDir,
      buildGeneratedState({
        templates,
        files: finalFiles,
        provenance: assembleTierProvenance(
          theirsGenerations,
          { files: finalFiles, decisions: theirs.decisions },
          commandSources,
        ),
      }),
    );
    reportWarnings(commandWarnings, args.json);
  } else {
    // Symmetry with create's upsert path: surface the same warning code when markers are
    // left in-file so both flows report a pending merge identically (the CLI additionally
    // lists each conflicted path).
    reportWarnings(
      [
        {
          code: 'merge_conflicts_pending',
          message:
            'Merge conflicts left in-file; post-generation commands were skipped and .cyan_state.yaml was not advanced. ' +
            'Resolve the markers, then re-run update.',
        },
      ],
      args.json,
    );
  }

  // Defer a failed-command throw until after state is persisted, so a later update can
  // still run (mirrors create).
  if (commandFailure) {
    throw commandFailure;
  }

  const reusedAnswers = [...new Set(installed.flatMap(entry => Object.keys(currentHistoryEntry(entry).answers)))];
  return {
    status: merge.conflicts.length > 0 ? 'conflict' : 'done',
    outputPath: args.projectDir,
    conflicts: merge.conflicts,
    updated,
    reusedAnswers,
  };
}

function matchesTemplateFilter(entry: InstalledTemplate, filter: string): boolean {
  const bare = filter.split('@')[0] ?? filter;
  return bare === `${entry.owner}/${entry.name}` || bare === entry.name;
}
