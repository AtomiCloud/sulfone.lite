// @bun
// examples/artifacts/resolver-keep-user/src/index.ts
import { dirname } from 'path';
import { mkdir } from 'fs/promises';
async function resolver(input) {
  const path = configPath(input.config);
  const current = input.inputDirs.find(entry => entry.origin.template === 'current');
  const selected = current ?? [...input.inputDirs].sort((left, right) => right.origin.layer - left.origin.layer)[0];
  const content = selected ? await readCandidate(selected.dir, path) : '';
  await writeOutput(input.outputDir, path, content);
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
