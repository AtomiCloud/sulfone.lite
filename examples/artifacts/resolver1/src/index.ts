type Strategy = 'concat' | 'replace' | 'distinct';

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

function configStrategy(config: Record<string, unknown>): Strategy {
  if (!('arrayStrategy' in config)) {
    return 'replace';
  }
  const strategy = config.arrayStrategy;
  if (strategy === 'concat' || strategy === 'replace' || strategy === 'distinct') {
    return strategy;
  }
  throw new Error('arrayStrategy has to be concat, replace, or distinct');
}

function mergeJson(left: unknown, right: unknown, strategy: Strategy): unknown {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (strategy === 'replace') {
      return right;
    }
    const merged = [...left, ...right];
    if (strategy === 'concat') {
      return merged;
    }
    const seen = new Set<string>();
    return merged.filter(item => {
      const key = JSON.stringify(item);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
  if (isRecord(left) && isRecord(right)) {
    const output: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) {
      output[key] = key in output ? mergeJson(output[key], value, strategy) : value;
    }
    return output;
  }
  return right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merges every JSON variation of the conflicting path in layer order. */
export function resolver(input: ResolverInput): ResolverOutput {
  const strategy = configStrategy(input.config);
  const sorted = [...input.files].sort(
    (left, right) =>
      left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template),
  );
  const first = sorted[0];
  if (!first) {
    throw new Error('resolver1 was invoked with no variations');
  }
  const documents = sorted
    .map(file => file.content)
    .filter(content => Boolean(content.trim()))
    .map(content => JSON.parse(content) as unknown);
  const merged = documents.reduce((acc, document) => mergeJson(acc, document, strategy));
  return { path: first.path, content: `${JSON.stringify(merged, null, 2)}\n` };
}
