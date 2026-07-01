// @bun
// examples/artifacts/resolver2/src/index.ts
import { dirname } from 'path';
import { mkdir } from 'fs/promises';
async function resolver(input) {
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
    .filter(content => Boolean(content?.trim()))
    .map(content => content.trimEnd());
  await writeOutput(
    input.outputDir,
    path,
    `${parts.join(`
`)}
`,
  );
}
async function readCandidate(dir, path) {
  return await Bun.file(`${dir}/${path}`)
    .text()
    .catch(() => '');
}
function configPath(config) {
  if (config && typeof config === 'object' && !Array.isArray(config) && typeof config.path === 'string') {
    return config.path;
  }
  return 'output.txt';
}
async function writeOutput(outputDir, path, content) {
  const outputPath = `${outputDir}/${path}`;
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, content);
}
export { resolver };
