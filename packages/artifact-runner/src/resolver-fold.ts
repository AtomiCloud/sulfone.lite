// Deterministic N-candidate fold over the v4 two-file resolver. Used by the runtime
// and by the commutative-resolver test helper.

import type { ResolvedFile, ResolverInput, ResolverOutput } from './sdk-types';

export type ResolverFn = (input: ResolverInput) => ResolverOutput | Promise<ResolverOutput>;

/**
 * Fold N conflicting candidates into a single result by repeatedly calling the two-file
 * resolver. Candidates are folded in a deterministic order (layer ascending, then template
 * name ascending). The output of step N becomes `current` for step N+1, carrying the
 * higher (`next`) layer's origin. A single candidate is returned untouched.
 */
export async function foldResolverCandidates(
  resolver: ResolverFn,
  args: { path: string; config: Record<string, unknown>; candidates: ResolvedFile[] },
): Promise<ResolverOutput> {
  const sorted = [...args.candidates].sort(
    (a, b) =>
      a.origin.layer - b.origin.layer ||
      (a.origin.template < b.origin.template ? -1 : a.origin.template > b.origin.template ? 1 : 0),
  );
  const first = sorted[0];
  if (!first) {
    throw new Error('resolver fold requires at least one candidate');
  }
  let current: ResolvedFile = first;
  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index];
    if (!next) {
      continue;
    }
    const output = await resolver({ path: args.path, config: args.config, current, next });
    current = { path: output.path, content: output.content, origin: next.origin };
  }
  return { path: current.path, content: current.content };
}
