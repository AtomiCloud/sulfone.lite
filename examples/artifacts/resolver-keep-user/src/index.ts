// Matches the vendored @cyanprint/sdk resolver contract: one call per conflicting
// path, carrying every variation of that path (with origins) at once.
type FileOrigin = {
  template: string;
  layer: number;
  processor?: { ref: string; invocation: number };
};

type ResolvedFile = { path: string; content: string; origin: FileOrigin };

type ResolverInput = { config: Record<string, unknown>; files: ResolvedFile[] };

type ResolverOutput = { path: string; content: string };

/**
 * Keeps the highest layer's content. Resolvers only merge template-vs-template
 * output during layering — updates use a git three-way merge for user edits, so
 * "keep user" now simply means the most recent layer wins.
 */
export function resolver(input: ResolverInput): ResolverOutput {
  const winner = [...input.files].sort(
    (left, right) =>
      right.origin.layer - left.origin.layer || right.origin.template.localeCompare(left.origin.template),
  )[0];
  if (!winner) {
    throw new Error('keep-user was invoked with no variations');
  }
  return { path: winner.path, content: winner.content };
}
