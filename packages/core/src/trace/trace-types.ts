import type { ArtifactKind, Provenance, VfsFile } from '@cyanprint/contracts';

export type { Provenance } from '@cyanprint/contracts';

/** One template node in the composition tree, with its isolated own output. */
export type TraceNode = {
  ref: string;
  kind: ArtifactKind;
  ownFiles: VfsFile[];
  children: TraceNode[];
};

/**
 * Passed into generation to capture the composition tree (per-template isolated output)
 * without a second traversal. `root` is a container; the root template becomes
 * `root.children[0]`. Merge provenance is always collected by the engine and persisted
 * to `.cyan_state.yaml` — the collector only carries the tree.
 */
export type TraceCollector = {
  root: { children: TraceNode[] };
};

export type TraceResult = {
  files: VfsFile[];
  tree: TraceNode;
  provenance: Provenance[];
  diffs: Array<{ template: string; path: string; diff: string }>;
};
