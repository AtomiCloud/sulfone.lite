// Test helpers for resolver authors. Driven by `cyanprint test` (never imported by a
// generated artifact at runtime).

import type { ResolvedFile } from './sdk-types';
import type { ResolverFn } from './resolver-fold';

/**
 * Assert a resolver's merge is commutative: for every pair of candidates, merging
 * `(a, b)` must produce the same content as merging `(b, a)`. Throws on the first
 * divergent pair. Used to enforce a resolver's declared `commutative: true`.
 */
export async function assertResolverCommutative(
  resolver: ResolverFn,
  args: { path: string; config: Record<string, unknown>; candidates: ResolvedFile[] },
): Promise<void> {
  const { path, config, candidates } = args;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      if (!a || !b) {
        continue;
      }
      const forward = await resolver({ path, config, current: a, next: b });
      const reverse = await resolver({ path, config, current: b, next: a });
      if (forward.content !== reverse.content) {
        throw new Error(
          `Resolver declared commutative but merge(${a.origin.template}, ${b.origin.template}) ` +
            'differs from the reversed order.',
        );
      }
    }
  }
}
