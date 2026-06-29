import { seedArtifacts } from '@cyanprint/registry-client';
import { loadManifest, sha256 } from '@cyanprint/core';
import { createTemplateArchivePayload } from '../../packages/cli/src/local-object-package';

const fixtureDirs: Record<string, string> = {
  'template:cyanprint:hello': 'examples/templates/hello',
  'template:cyanprint:with-artifacts': 'examples/templates/with-artifacts',
  'template:cyan:new': 'in-tree/official/templates/new',
  'template:cyanprint:workspace': 'examples/templates/workspace',
  'template:cyanprint:nix': 'examples/templates/nix',
  'template:cyanprint:template-resolver-1': 'examples/templates/template-resolver-1',
  'template:cyanprint:template-resolver-2': 'examples/templates/template-resolver-2',
  'template-group:cyanprint:basic-group': 'examples/template-groups/basic',
  'processor:cyan:default': 'in-tree/official/processors/default',
  'processor:cyanprint:uppercase': 'examples/artifacts/processor-uppercase',
  'plugin:cyanprint:footer': 'examples/artifacts/plugin-footer',
  'resolver:cyanprint:keep-user': 'examples/artifacts/resolver-keep-user',
  'resolver:cyanprint:resolver1': 'examples/artifacts/resolver1',
  'resolver:cyanprint:resolver2': 'examples/artifacts/resolver2',
};

let source = await Bun.file('packages/registry-client/src/local-registry.ts').text();
let updates = 0;

for (const artifact of seedArtifacts) {
  const dir = fixtureDirs[`${artifact.kind}:${artifact.owner}:${artifact.name}`];
  if (!dir || !artifact.artifactObjects) {
    continue;
  }
  const { manifest } = await loadManifest(dir);
  const objects = artifact.artifactObjects;
  await replaceSeedPart(objects.manifest.key, await Bun.file(`${dir}/cyan.yaml`).text());
  if (objects.readme) {
    await replaceSeedPart(objects.readme.key, await Bun.file(`${dir}/README.md`).text());
  }
  await replaceSeedPart(objects.bundle.key, await Bun.file(`${dir}/${manifest.bundledEntry}`).text());
  if (objects.archive) {
    const archive = await createTemplateArchivePayload(dir, { bundledEntry: manifest.bundledEntry });
    await replaceSeedPart(objects.archive.key, archive.payload, true);
  }
}

await Bun.write('packages/registry-client/src/local-registry.ts', source);
console.log(JSON.stringify({ status: 'done', updates }));

async function replaceSeedPart(key: string, payload: string | Uint8Array, binary = false): Promise<void> {
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const hash = sha256(payload);
  const base64 = Buffer.from(bytes).toString('base64');
  const replacement = [
    'seedPart(',
    `        ${JSON.stringify(key)},`,
    `        ${JSON.stringify(hash)},`,
    `        ${bytes.byteLength},`,
    `        ${JSON.stringify(base64)},${binary ? '\n        true,' : ''}`,
    '      )',
  ].join('\n');
  const next = replaceSeedPartCall(key, replacement);
  if (next !== undefined) {
    if (next !== source) {
      source = next;
      updates += 1;
    }
    return;
  }
  if (replaceRuntimeSeedFields(key, hash, bytes.byteLength, base64)) {
    updates += 1;
    return;
  }
  throw new Error(`Could not update seedPart ${key}`);
}

function replaceSeedPartCall(key: string, replacement: string): string | undefined {
  const keyIndex = findSeedKeyIndex(key);
  if (keyIndex === -1) {
    return undefined;
  }
  const start = source.lastIndexOf('seedPart(', keyIndex);
  if (start === -1) {
    return undefined;
  }
  const close = source.slice(start).match(/\n\s*\)\s*,?/);
  if (!close || close.index === undefined) {
    return undefined;
  }
  const end = start + close.index + close[0].length;
  const trailingComma = close[0].trimEnd().endsWith(',');
  return `${source.slice(0, start)}${replacement}${trailingComma ? ',' : ''}${source.slice(end)}`;
}

function findSeedKeyIndex(key: string): number {
  const doubleQuoted = source.indexOf(JSON.stringify(key));
  if (doubleQuoted !== -1) {
    return doubleQuoted;
  }
  return source.indexOf(`'${key.replaceAll("'", "\\'")}'`);
}

function replaceRuntimeSeedFields(key: string, hash: string, size: number, base64: string): boolean {
  const [kind, , name, , filename] = key.split('/');
  if (!kind || !name || !filename) {
    return false;
  }
  const fieldPrefix =
    filename === 'manifest.yaml'
      ? 'manifest'
      : filename === 'readme.md'
        ? 'readme'
        : filename === 'bundle.js'
          ? 'bundle'
          : undefined;
  if (!fieldPrefix) {
    return false;
  }
  const callStart = source.indexOf(`seedRuntimeDefinition('${kind}', '${name}'`);
  if (callStart === -1) {
    return false;
  }
  const callEnd = source.indexOf('\n  }),', callStart);
  if (callEnd === -1) {
    return false;
  }
  const before = source.slice(0, callStart);
  const block = source.slice(callStart, callEnd);
  const after = source.slice(callEnd);
  const shaPattern = new RegExp(`${fieldPrefix}Sha: ['"][^'"]+['"]`);
  const sizePattern = new RegExp(`${fieldPrefix}Size: \\d+`);
  const base64Pattern = new RegExp(`${fieldPrefix}Base64:\\s*['"][A-Za-z0-9+/=]*['"]`);
  if (!shaPattern.test(block) || !sizePattern.test(block) || !base64Pattern.test(block)) {
    return false;
  }
  const updated = block
    .replace(shaPattern, `${fieldPrefix}Sha: ${JSON.stringify(hash)}`)
    .replace(sizePattern, `${fieldPrefix}Size: ${size}`)
    .replace(base64Pattern, `${fieldPrefix}Base64: ${JSON.stringify(base64)}`);
  if (updated === block) {
    return true;
  }
  source = `${before}${updated}${after}`;
  return true;
}
