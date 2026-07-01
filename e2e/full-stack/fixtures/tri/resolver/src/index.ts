import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

export async function resolver(input) {
  const path = input.config?.path ?? 'output.txt';
  const sorted = [...input.inputDirs].sort(
    (left, right) =>
      left.origin.layer - right.origin.layer ||
      (left.origin.template < right.origin.template ? -1 : left.origin.template > right.origin.template ? 1 : 0),
  );
  const contents = await Promise.all(
    sorted.map(
      async entry =>
        await Bun.file(entry.dir + '/' + path)
          .text()
          .catch(() => ''),
    ),
  );
  const lines = contents
    .flatMap(content => String(content ?? '').split('\n'))
    .map(value => value.trim())
    .filter(Boolean);
  const outputPath = input.outputDir + '/' + path;
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, [...new Set(lines)].join('\n') + '\n');
}
