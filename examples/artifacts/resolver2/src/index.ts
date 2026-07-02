import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

type ResolverInput = {
  inputDirs: Array<{ dir: string; origin: { template: string; layer: number } }>;
  outputDir: string;
  config?: unknown;
};

export async function resolver(input: ResolverInput): Promise<void> {
  const path = configPath(input.config);
  const parts = (
    await Promise.all(
      [...input.inputDirs]
        .sort(
          (left, right) =>
            left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template),
        )
        .map(async entry => await readCandidate(entry.dir, path)),
    )
  )
    .filter((content): content is string => Boolean(content?.trim()))
    .map(content => content.trimEnd());
  await writeOutput(input.outputDir, path, `${parts.join('\n')}\n`);
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
