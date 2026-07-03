import type { Answers, PromptAdapter } from '@cyanprint/contracts';
import { generateTemplateTree, assembleProvenance } from '../create/create-project';
import { comparePaths } from '../util';
import { unifiedDiff } from '../util/unified-diff';
import type { TraceCollector, TraceNode, TraceResult } from './trace-types';

export type { Provenance, TraceNode, TraceResult } from './trace-types';

/**
 * Generate a template into memory while capturing composition provenance, per-template
 * isolated output, and per-template unified diffs vs the final merged result. Note:
 * generated *projects* don't need this — their provenance is persisted in
 * `.cyan_state.yaml` and read directly by `cyanprint trace`.
 */
export async function traceProject(options: {
  template: string;
  answers?: Answers;
  deterministicState?: Record<string, unknown>;
  headless?: boolean;
  localFallback?: boolean;
  promptAdapter?: PromptAdapter;
}): Promise<TraceResult> {
  const collector: TraceCollector = { root: { children: [] } };
  const generation = await generateTemplateTree({
    template: options.template,
    answers: options.answers,
    deterministicState: options.deterministicState,
    headless: options.headless ?? true,
    localFallback: options.localFallback,
    promptAdapter: options.promptAdapter,
    trace: collector,
  });
  const tree = collector.root.children[0];
  if (!tree) {
    throw new Error('trace produced no template tree');
  }
  const provenance = assembleProvenance(generation.decisions, generation.files, generation.sources);
  const finalByPath = new Map(generation.files.map(file => [file.path, file]));
  const diffs: TraceResult['diffs'] = [];
  const visit = (node: TraceNode): void => {
    for (const own of node.ownFiles) {
      if (own.content === undefined) {
        continue; // text-only; skip binary
      }
      const final = finalByPath.get(own.path);
      if (!final || final.content === undefined) {
        continue;
      }
      const diff = unifiedDiff(own.content, final.content, { fromLabel: `${node.ref} (own)`, toLabel: 'final' });
      if (diff) {
        diffs.push({ template: node.ref, path: own.path, diff });
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(tree);
  return {
    files: generation.files,
    tree,
    provenance: provenance.sort((left, right) => comparePaths(left.path, right.path)),
    diffs,
  };
}
