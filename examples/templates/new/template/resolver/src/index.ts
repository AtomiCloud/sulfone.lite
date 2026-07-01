import type { ResolverInput, ResolverOutput } from '@cyanprint/sdk';

// Two-file merge: CyanPrint folds N candidates by repeated calls, so 'next' is always
// the higher layer. Returning it keeps the latest layer's content (latest-wins).
export async function resolver(input: ResolverInput): Promise<ResolverOutput> {
  return { path: input.next.path, content: input.next.content };
}
