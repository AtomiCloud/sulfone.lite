import type { ResolverInput, ResolverOutput } from '@cyanprint/sdk';

// Global merge: CyanPrint calls a resolver once per conflicting path with every
// variation of that path in scope (each with its origin). Returning the highest
// layer keeps the most recent content (latest-wins).
export async function resolver(input: ResolverInput): Promise<ResolverOutput> {
  const latest = [...input.files].sort((left, right) => right.origin.layer - left.origin.layer)[0];
  if (!latest) {
    throw new Error('resolver was invoked with no variations');
  }
  return { path: latest.path, content: latest.content };
}
