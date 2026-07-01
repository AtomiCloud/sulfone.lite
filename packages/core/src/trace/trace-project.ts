import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Answers, PromptAdapter } from '@cyanprint/contracts';
import { createProject } from '../create/create-project';
import { comparePaths } from '../util';
import { unifiedDiff } from '../util/unified-diff';
import type { TraceCollector, TraceNode, TraceResult } from './trace-types';

export type { Provenance, TraceNode, TraceResult } from './trace-types';

/**
 * Generate a template into a throwaway temp dir while capturing composition provenance,
 * per-template isolated output, and per-template unified diffs vs the final merged result.
 */
export async function traceProject(options: {
  template: string;
  answers?: Answers;
  deterministicState?: Record<string, unknown>;
  headless?: boolean;
  localFallback?: boolean;
  promptAdapter?: PromptAdapter;
}): Promise<TraceResult> {
  const collector: TraceCollector = {
    provenance: new Map(),
    root: { children: [] },
    record(path, source, decision) {
      this.provenance.set(path, { path, source, decision });
    },
  };
  const outDir = await mkdtemp(join(tmpdir(), 'cyanprint-trace-'));
  try {
    const result = await createProject({
      template: options.template,
      outDir,
      answers: options.answers,
      deterministicState: options.deterministicState,
      headless: options.headless ?? true,
      json: true,
      localFallback: options.localFallback,
      promptAdapter: options.promptAdapter,
      trace: collector,
    });
    const tree = collector.root.children[0];
    if (!tree) {
      throw new Error('trace produced no template tree');
    }
    const provenance = [...collector.provenance.values()].sort((left, right) => comparePaths(left.path, right.path));
    const finalByPath = new Map(result.files.map(file => [file.path, file]));
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
    return { files: result.files, tree, provenance, diffs };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
