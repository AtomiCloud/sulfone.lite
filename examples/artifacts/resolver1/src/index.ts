import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

type Strategy = 'concat' | 'replace' | 'distinct';

type ResolverInput = {
  inputDirs: Array<{ dir: string; origin: { template: string; layer: number } }>;
  outputDir: string;
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

export async function resolver(input: ResolverInput): Promise<void> {
  const strategy = configStrategy(input.config);
  const path = configPath(input.config);
  const sorted = [...input.inputDirs].sort(
    (left, right) =>
      left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template),
  );
  const documents = (await Promise.all(sorted.map(async entry => await readCandidate(entry.dir, path))))
    .filter(content => Boolean(content.trim()))
    .map(content => JSON.parse(content) as unknown);
  const merged = documents.reduce((acc, document) => mergeJson(acc, document, strategy));
  await writeOutput(input.outputDir, path, `${JSON.stringify(merged, null, 2)}\n`);
}

async function readCandidate(dir: string, path: string): Promise<string> {
  return await Bun.file(`${dir}/${path}`)
    .text()
    .catch(() => '');
}

function configPath(config: unknown): string {
  if (
    config &&
    typeof config === 'object' &&
    !Array.isArray(config) &&
    typeof (config as { path?: unknown }).path === 'string'
  ) {
    return (config as { path: string }).path;
  }
  return 'output.txt';
}

async function writeOutput(outputDir: string, path: string, content: string): Promise<void> {
  const outputPath = `${outputDir}/${path}`;
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, content);
}
