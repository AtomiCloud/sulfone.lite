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

/** Concatenates every non-empty variation of the conflicting path in layer order. */
export function resolver(input: ResolverInput): ResolverOutput {
  const sorted = [...input.files].sort(
    (left, right) =>
      left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template),
  );
  const first = sorted[0];
  if (!first) {
    throw new Error('resolver2 was invoked with no variations');
  }
  const parts = sorted
    .map(file => file.content)
    .filter(content => Boolean(content.trim()))
    .map(content => content.trimEnd());
  return { path: first.path, content: `${parts.join('\n')}\n` };
}
