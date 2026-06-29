type Strategy = 'concat' | 'replace' | 'distinct';

type ResolverInput = {
  files: Array<{ content: string; origin: { template: string; layer: number } }>;
  config?: unknown;
};

function configStrategy(config: unknown): Strategy {
  if (!config || typeof config !== 'object' || !('arrayStrategy' in config)) {
    return 'replace';
  }
  const strategy = (config as { arrayStrategy?: unknown }).arrayStrategy;
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

export function resolver(input: ResolverInput): string {
  const strategy = configStrategy(input.config);
  const documents = [...input.files]
    .sort(
      (left, right) =>
        left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template),
    )
    .map(file => file.content)
    .filter((content): content is string => Boolean(content?.trim()))
    .map(content => JSON.parse(content) as unknown);
  const merged = documents.reduce((acc, document) => mergeJson(acc, document, strategy));
  return `${JSON.stringify(merged, null, 2)}\n`;
}
