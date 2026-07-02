import { seedArtifacts } from '@cyanprint/registry-client';
import { loadManifest, sha256 } from '@cyanprint/core';
import { createTemplateArchivePayload } from '../../packages/cli/src/local-object-package';
import { readSeedBundle } from './seed-bundles';

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
  await replaceSeedPart(objects.bundle.key, await readSeedBundle(dir, manifest));
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
  const next = replaceSeedPartCall(key, ({ lineIndent }) => {
    const argIndent = `${lineIndent}  `;
    return [
      'seedPart(',
      `${argIndent}${quoteTsString(key)},`,
      `${argIndent}${quoteTsString(hash)},`,
      `${argIndent}${bytes.byteLength},`,
      `${argIndent}${quoteTsString(base64)},${binary ? `\n${argIndent}true,` : ''}`,
      `${lineIndent})`,
    ].join('\n');
  });
  if (next !== undefined) {
    if (next !== source) {
      source = next;
      updates += 1;
    }
    return;
  }
  const runtimeChanged = replaceRuntimeSeedFields(key, hash, bytes.byteLength, base64);
  if (runtimeChanged !== undefined) {
    if (runtimeChanged) {
      updates += 1;
    }
    return;
  }
  throw new Error(`Could not update seedPart ${key}`);
}

function replaceSeedPartCall(
  key: string,
  buildReplacement: (context: { lineIndent: string }) => string,
): string | undefined {
  const keyIndex = findSeedKeyIndex(key);
  if (keyIndex === -1) {
    return undefined;
  }
  const start = source.lastIndexOf('seedPart(', keyIndex);
  if (start === -1) {
    return undefined;
  }
  const lineStart = source.lastIndexOf('\n', start) + 1;
  const linePrefix = source.slice(lineStart, start);
  const lineIndent = linePrefix.match(/^\s*/)?.[0] ?? '';
  const replacement = buildReplacement({ lineIndent });
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

function replaceRuntimeSeedFields(key: string, hash: string, size: number, base64: string): boolean | undefined {
  const [kind, , name, , filename] = key.split('/');
  if (!kind || !name || !filename) {
    return undefined;
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
    return undefined;
  }
  const callStart = source.indexOf(`seedRuntimeDefinition('${kind}', '${name}'`);
  if (callStart === -1) {
    return undefined;
  }
  const callEnd = source.indexOf('\n  }),', callStart);
  if (callEnd === -1) {
    return undefined;
  }
  const before = source.slice(0, callStart);
  const block = source.slice(callStart, callEnd);
  const after = source.slice(callEnd);
  const shaPattern = new RegExp(`${fieldPrefix}Sha: ['"][^'"]+['"]`);
  const sizePattern = new RegExp(`${fieldPrefix}Size: \\d+`);
  const base64Pattern = new RegExp(
    `${fieldPrefix}Base64:\\s*(?:['"][A-Za-z0-9+/=]*['"]|\\[\\n(?:\\s*['"][A-Za-z0-9+/=]*['"],\\n)+\\s*\\]\\.join\\(''\\))`,
  );
  if (!shaPattern.test(block) || !sizePattern.test(block) || !base64Pattern.test(block)) {
    return undefined;
  }
  const updated = block
    .replace(shaPattern, `${fieldPrefix}Sha: ${quoteTsString(hash)}`)
    .replace(sizePattern, `${fieldPrefix}Size: ${size}`)
    .replace(base64Pattern, `${fieldPrefix}Base64: ${formatRuntimeBase64(base64)}`);
  if (updated === block) {
    return false;
  }
  source = `${before}${updated}${after}`;
  return true;
}

function quoteTsString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function formatRuntimeBase64(value: string): string {
  if (value.length <= 120) {
    return quoteTsString(value);
  }
  const chunks = value.match(/.{1,100}/g) ?? [''];
  return `[\n${chunks.map(chunk => `      ${quoteTsString(chunk)},`).join('\n')}\n    ].join('')`;
}
