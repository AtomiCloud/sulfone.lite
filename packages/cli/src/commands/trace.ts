import { join } from 'node:path';
import {
  loadGeneratedState,
  mergedDeterministicState,
  mergedStateAnswers,
  traceProject,
  type TraceNode,
} from '@cyanprint/core';
import type { Answers, PromptAdapter, Provenance } from '@cyanprint/contracts';
import { parseFlags, flagBool, flagString, readAnswersFile } from '../args';
import { defaultRegistryUrl } from '../registry-defaults';
import { resolveTemplateInput } from '../registry-template';
import { info, kv, pathLabel, printJson, printSection, success } from '../ui';

type CliRuntime = {
  promptAdapter?: PromptAdapter;
  promptAdapterFactory?: (answers: Record<string, unknown>) => PromptAdapter;
  silent?: boolean;
};

export async function traceCommand(argv: string[], runtime: CliRuntime = {}): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const target = positional[0];
  if (!target) {
    throw new Error('trace requires a template path, registry reference, or generated project directory');
  }
  const answersPath = flagString(flags, 'answers');
  let answers: Answers = answersPath ? await readAnswersFile(answersPath) : {};
  let deterministicState: Record<string, unknown> | undefined;
  const json = flagBool(flags, 'json');
  const headless = flagBool(flags, 'headless') || json;

  // A generated project carries `.cyan_state.yaml` with the FULL persisted provenance
  // of its last generation — the provenance view reads it directly, no regeneration.
  // Regeneration remains only for the isolated per-template output + diffs.
  let template = target;
  let tracingProject = false;
  let persistedProvenance: Provenance[] | undefined;
  if (await Bun.file(join(target, '.cyan_state.yaml')).exists()) {
    tracingProject = true;
    const state = await loadGeneratedState(target);
    persistedProvenance = state.provenance;
    answers = { ...mergedStateAnswers(state), ...answers };
    deterministicState = mergedDeterministicState(state);
    template = flagString(flags, 'template') ?? state.templates.find(entry => entry.active)?.source ?? target;
    if (!json) {
      console.log(info(`tracing generated project ${pathLabel(target)} (provenance from .cyan_state.yaml)`));
    }
  }
  const promptAdapter = runtime.promptAdapterFactory?.(answers) ?? runtime.promptAdapter;

  const trace = await resolveAndTrace({
    template,
    flags,
    answers,
    deterministicState,
    headless,
    promptAdapter,
    optional: tracingProject,
  });

  const provenance = persistedProvenance ?? trace?.provenance ?? [];
  if (json) {
    printJson({ provenance, tree: trace?.tree, diffs: trace?.diffs ?? [] });
    return;
  }

  console.log(success(`traced ${pathLabel(tracingProject ? target : template)}`));
  printProvenanceBySegment(provenance);

  if (trace) {
    const templateRows: string[] = [];
    const walk = (node: TraceNode, indent: string): void => {
      templateRows.push(`${indent}${node.ref}  (${node.ownFiles.length} file(s))`);
      for (const own of node.ownFiles) {
        templateRows.push(`${indent}  - ${own.path}`);
      }
      for (const child of node.children) {
        walk(child, `${indent}  `);
      }
    };
    walk(trace.tree, '');
    printSection('Per-template output', templateRows);

    if (trace.diffs.length > 0) {
      console.log('\nDiffs (contribution vs final):');
      for (const entry of trace.diffs) {
        console.log(`\n-- ${entry.template} · ${entry.path} --`);
        console.log(entry.diff);
      }
    }
  }
}

// Human trace output groups merge decisions by segment (processor / dependency /
// sibling); added files come last. `--json` carries everything verbatim.
function printProvenanceBySegment(provenance: Provenance[]): void {
  const segments: Array<{ title: string; entries: Provenance[] }> = [
    {
      title: 'Merges — processor outputs (tier 1)',
      entries: provenance.filter(entry => entry.segment === 'processor'),
    },
    { title: 'Merges — dependency tree (tier 2)', entries: provenance.filter(entry => entry.segment === 'dependency') },
    {
      title: 'Merges — sibling installations (tier 3)',
      entries: provenance.filter(entry => entry.segment === 'sibling'),
    },
    { title: 'Added (no conflict)', entries: provenance.filter(entry => entry.decision === 'added') },
  ];
  for (const segment of segments) {
    if (segment.entries.length === 0) {
      continue;
    }
    printSection(
      segment.title,
      segment.entries.map(entry =>
        kv(
          entry.path,
          `${entry.source} [${entry.decision}${entry.resolver ? ` via ${entry.resolver}` : ''}]` +
            (entry.contributors?.length
              ? ` contributors: ${entry.contributors.map(origin => origin.template + (origin.processor ? `#${origin.processor.ref}@${origin.processor.invocation}` : '')).join(', ')}`
              : ''),
        ),
      ),
    );
  }
}

async function resolveAndTrace(args: {
  template: string;
  flags: Record<string, string | boolean>;
  answers: Answers;
  deterministicState?: Record<string, unknown>;
  headless: boolean;
  promptAdapter?: PromptAdapter;
  optional: boolean;
}): Promise<Awaited<ReturnType<typeof traceProject>> | undefined> {
  try {
    const resolved = await resolveTemplateInput({
      template: args.template,
      registry: flagString(args.flags, 'registry') ?? defaultRegistryUrl(),
      cacheDir: flagString(args.flags, 'cache-dir'),
      bypassCache: flagBool(args.flags, 'bypass-cache'),
      trusted: flagBool(args.flags, 'trust'),
      trustFixture: flagString(args.flags, 'trust-fixture'),
      trustDir: flagString(args.flags, 'trust-dir'),
    });
    return await traceProject({
      template: resolved.templateDir,
      answers: args.answers,
      deterministicState: args.deterministicState,
      headless: args.headless,
      localFallback: !resolved.registryHydrated,
      promptAdapter: args.headless ? undefined : args.promptAdapter,
    });
  } catch (error) {
    // Project provenance still prints from state; the regenerated tree/diffs are extra.
    if (args.optional) {
      return undefined;
    }
    throw error;
  }
}
