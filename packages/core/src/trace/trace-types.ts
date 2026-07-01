import type { ArtifactKind, VfsFile } from '@cyanprint/contracts';

/** One template node in the composition tree, with its isolated own output. */
export type TraceNode = {
  ref: string;
  kind: ArtifactKind;
  ownFiles: VfsFile[];
  children: TraceNode[];
};

/** How a path's winning content got there during the layer merge. */
export type Provenance = {
  path: string;
  source: string;
  decision: 'added' | 'resolver-merged' | 'lww-override';
};

/**
 * Passed into createProject to capture composition provenance without a second traversal.
 * `root` is a container; the root template becomes `root.children[0]`.
 */
export type TraceCollector = {
  provenance: Map<string, Provenance>;
  root: { children: TraceNode[] };
  record(path: string, source: string, decision: Provenance['decision']): void;
};

export type TraceResult = {
  files: VfsFile[];
  tree: TraceNode;
  provenance: Provenance[];
  diffs: Array<{ template: string; path: string; diff: string }>;
};
