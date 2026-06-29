import { seedArtifacts, seedObjectPayloads } from '@cyanprint/registry-client';
import { loadManifest, sha256 } from '@cyanprint/core';
import { createTemplateArchivePayload } from '../../packages/cli/src/local-object-package';

const fixtureDirs: Record<string, string> = {
  'template:cyanprint:hello': 'examples/templates/hello',
  'template:cyanprint:with-artifacts': 'examples/templates/with-artifacts',
  'template:cyanprint:new': 'examples/templates/new',
  'template:cyanprint:workspace': 'examples/templates/workspace',
  'template:cyanprint:nix': 'examples/templates/nix',
  'template:cyanprint:template-resolver-1': 'examples/templates/template-resolver-1',
  'template:cyanprint:template-resolver-2': 'examples/templates/template-resolver-2',
  'template-group:cyanprint:basic-group': 'examples/template-groups/basic',
  'processor:cyanprint:default': 'examples/artifacts/processor-default',
  'processor:cyanprint:uppercase': 'examples/artifacts/processor-uppercase',
  'plugin:cyanprint:footer': 'examples/artifacts/plugin-footer',
  'resolver:cyanprint:keep-user': 'examples/artifacts/resolver-keep-user',
  'resolver:cyanprint:resolver1': 'examples/artifacts/resolver1',
  'resolver:cyanprint:resolver2': 'examples/artifacts/resolver2',
};

const payloads = new Map(seedObjectPayloads.map(object => [object.ref.key, object.payload]));
const failures: string[] = [];
let objectBackedChecked = 0;

for (const artifact of seedArtifacts) {
  const key = `${artifact.kind}:${artifact.owner}:${artifact.name}`;
  const dir = fixtureDirs[key];
  if (!dir) {
    continue;
  }
  if (!artifact.artifactObjects) {
    failures.push(`${key} has fixture ${dir} but no artifact object refs`);
    continue;
  }
  objectBackedChecked += 1;
  const { manifest } = await loadManifest(dir);
  const expectedFiles: Array<[string, string, string | undefined]> = [
    ['manifest', 'cyan.yaml', artifact.artifactObjects.manifest.key],
    ['readme', 'README.md', artifact.artifactObjects.readme?.key],
    ['bundle', manifest.bundledEntry, artifact.artifactObjects.bundle.key],
  ];
  for (const [part, path, key] of expectedFiles) {
    if (!key) {
      continue;
    }
    const payload = payloads.get(key);
    const source = await Bun.file(`${dir}/${path}`).text();
    if (typeof payload !== 'string') {
      failures.push(
        `${artifact.kind}:${artifact.owner}/${artifact.name}@${artifact.version} ${part} should be seeded as text`,
      );
      continue;
    }
    if (payload !== source) {
      failures.push(
        `${artifact.kind}:${artifact.owner}/${artifact.name}@${artifact.version} ${part} differs from ${path}`,
      );
    }
  }
  if ((artifact.kind === 'template' || artifact.kind === 'template-group') && artifact.artifactObjects.archive) {
    const payload = payloads.get(artifact.artifactObjects.archive.key);
    const archive = await createTemplateArchivePayload(dir, { bundledEntry: manifest.bundledEntry });
    if (!(payload instanceof Uint8Array)) {
      failures.push(`${artifact.kind}:${artifact.owner}/${artifact.name}@${artifact.version} archive should be binary`);
    } else if (!bytesEqual(payload, archive.payload)) {
      failures.push(
        `${artifact.kind}:${artifact.owner}/${artifact.name}@${artifact.version} archive differs from template files`,
      );
    }
    if (artifact.artifactObjects.archive.sha256 !== archive.sha256) {
      failures.push(
        `${artifact.kind}:${artifact.owner}/${artifact.name}@${artifact.version} archive sha256 differs from template files`,
      );
    }
    if (artifact.artifactObjects.archive.size !== archive.size) {
      failures.push(
        `${artifact.kind}:${artifact.owner}/${artifact.name}@${artifact.version} archive size differs from template files`,
      );
    }
  }
}

for (const [key, dir] of Object.entries(fixtureDirs)) {
  if (!seedArtifacts.some(artifact => `${artifact.kind}:${artifact.owner}:${artifact.name}` === key)) {
    failures.push(`${key} missing from seed artifacts for fixture ${dir}`);
  }
}
for (const object of seedObjectPayloads) {
  if (object.ref.sha256 !== sha256(object.payload)) {
    failures.push(`${object.ref.key} sha256 does not match payload`);
  }
  const size =
    typeof object.payload === 'string'
      ? new TextEncoder().encode(object.payload).byteLength
      : object.payload.byteLength;
  if (object.ref.size !== size) {
    failures.push(`${object.ref.key} size does not match payload`);
  }
}

if (failures.length > 0) {
  throw new Error(`Seed registry drift:\n${failures.join('\n')}`);
}

console.log(
  JSON.stringify({
    status: 'done',
    checked: Object.keys(fixtureDirs).length,
    objectBackedChecked,
  }),
);

export {};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return left.every((byte, index) => byte === right[index]);
}
