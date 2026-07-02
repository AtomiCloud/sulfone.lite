// @bun
// examples/artifacts/resolver1/src/index.ts
import { dirname } from 'path';
import { mkdir } from 'fs/promises';
function configStrategy(config) {
  if (!config || typeof config !== 'object' || !('arrayStrategy' in config)) {
    return 'replace';
  }
  const strategy = config.arrayStrategy;
  if (strategy === 'concat' || strategy === 'replace' || strategy === 'distinct') {
    return strategy;
  }
  throw new Error('arrayStrategy has to be concat, replace, or distinct');
}
function mergeJson(left, right, strategy) {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (strategy === 'replace') {
      return right;
    }
    const merged = [...left, ...right];
    if (strategy === 'concat') {
      return merged;
    }
    const seen = new Set();
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
    const output = { ...left };
    for (const [key, value] of Object.entries(right)) {
      output[key] = key in output ? mergeJson(output[key], value, strategy) : value;
    }
    return output;
  }
  return right;
}
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function resolver(input) {
  const strategy = configStrategy(input.config);
  const path = configPath(input.config);
  const sorted = [...input.inputDirs].sort(
    (left, right) =>
      left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template),
  );
  const documents = (await Promise.all(sorted.map(async entry => await readCandidate(entry.dir, path))))
    .filter(content => Boolean(content.trim()))
    .map(content => JSON.parse(content));
  const merged = documents.reduce((acc, document) => mergeJson(acc, document, strategy));
  await writeOutput(
    input.outputDir,
    path,
    `${JSON.stringify(merged, null, 2)}
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
