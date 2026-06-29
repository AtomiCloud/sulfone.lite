import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadManifest, safeJoin } from '@cyanprint/core';
import { RegistryClient } from '@cyanprint/registry-client';
import { artifactIntegrity, type ArtifactPublish, type ResolvedDependencyPin } from '@cyanprint/contracts';
import { buildBundle } from '@cyanprint/artifact-bundler';
import { parseFlags, flagBool, flagString } from '../args';
import { createArtifactTextObject, createTemplateArchivePayload } from '../local-object-package';
import { info, kv, pathLabel, printJson, printSection, success } from '../ui';

export async function pushCommand(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const artifactDir = positional[0];
  if (!artifactDir) {
    throw new Error('push requires an artifact directory');
  }
  const json = flagBool(flags, 'json');
  const scriptOnly = flagBool(flags, 'script-only');
  const { manifest } = await loadManifest(artifactDir);
  if (!json) {
    console.log(info(`preparing ${manifest.kind} ${pathLabel(`${manifest.owner}/${manifest.name}`)}`));
  }
  const refs = [...manifest.templates, ...manifest.processors, ...manifest.plugins, ...manifest.resolvers].map(ref => ({
    ...ref,
    owner: ref.owner ?? manifest.owner,
  }));
  const registry = flagString(flags, 'registry');
  const bootstrapClient = registry ? new RegistryClient(registry) : undefined;
  const resolvedPins: ResolvedDependencyPin[] = bootstrapClient
    ? (await bootstrapClient.batchResolve({ refs })).resolved.map(artifact => ({
        kind: artifact.kind,
        owner: artifact.owner,
        name: artifact.name,
        version: artifact.version,
        integrity: artifactIntegrity(artifact),
      }))
    : refs.map(ref => ({
        kind: ref.kind,
        owner: ref.owner ?? manifest.owner,
        name: ref.name,
        version: ref.version ?? '4',
        integrity: `${ref.kind}-${ref.name}-local-integrity`,
      }));
  if (bootstrapClient && resolvedPins.length !== refs.length) {
    const resolvedKeys = new Set(resolvedPins.map(pin => `${pin.kind}:${pin.owner}:${pin.name}`));
    const missing = refs.filter(ref => !resolvedKeys.has(`${ref.kind}:${ref.owner ?? manifest.owner}:${ref.name}`));
    throw new Error(
      `Registry could not resolve declared dependencies: ${missing.map(ref => `${ref.kind}:${ref.owner ?? manifest.owner}:${ref.name}`).join(', ')}`,
    );
  }
  const bundle = ['processor', 'plugin', 'resolver'].includes(manifest.kind)
    ? await buildBundle({ artifactDir, dryRun: flagBool(flags, 'dry-run'), temporary: Boolean(registry) })
    : { runtimeFile: safeJoin(artifactDir, manifest.bundledEntry), dryRun: flagBool(flags, 'dry-run'), sha256: '' };
  const manifestObject = await createArtifactTextObject(safeJoin(artifactDir, 'cyan.yaml'));
  const readmePath = await findReadmePath(artifactDir, manifest.readme);
  const readmeObject = readmePath ? await createArtifactTextObject(readmePath).catch(() => undefined) : undefined;
  let bundleObject;
  try {
    bundleObject = await createArtifactTextObject(bundle.runtimeFile);
  } finally {
    if (bundle.temporaryDirectory) {
      await rm(bundle.temporaryDirectory, { recursive: true, force: true });
    }
  }
  const archiveObject =
    !scriptOnly && (manifest.kind === 'template' || manifest.kind === 'template-group')
      ? await createTemplateArchivePayload(artifactDir, { bundledEntry: manifest.bundledEntry })
      : undefined;
  const artifact: ArtifactPublish = {
    kind: manifest.kind,
    owner: manifest.owner,
    name: manifest.name,
    readme: readmePath
      ? await Bun.file(readmePath)
          .text()
          .catch(() => '')
      : '',
    dependencies: refs,
    resolvedPins,
    scriptOnly,
    disabled: false,
    moderationState: 'active',
    downloads: 0,
    likes: 0,
  };

  let published = false;
  let committedArtifact;
  if (!flagBool(flags, 'dry-run') && registry) {
    const bootstrap = bootstrapClient ?? new RegistryClient(registry);
    const minted = process.env.CYANPRINT_TOKEN
      ? { token: process.env.CYANPRINT_TOKEN }
      : process.env.CYANPRINT_LOCAL_AUTH === '1'
        ? await bootstrap.createToken('cyanprint-push', (await bootstrap.createLocalSession()).session)
        : undefined;
    if (!minted) {
      throw new Error(
        'Publishing requires CYANPRINT_TOKEN. Set CYANPRINT_LOCAL_AUTH=1 only for local registry fixtures.',
      );
    }
    const client = new RegistryClient(registry, minted.token);
    const upload = await client.startUpload({
      kind: manifest.kind,
      owner: manifest.owner,
      name: manifest.name,
      objects: {
        manifest: manifestObject,
        ...(readmeObject ? { readme: readmeObject } : {}),
        bundle: bundleObject,
        ...(archiveObject ? { archive: archiveObject } : {}),
      },
    });
    await client.putUploadObject(upload.urls.manifest, manifestObject.payload);
    if (readmeObject && upload.urls.readme) {
      await client.putUploadObject(upload.urls.readme, readmeObject.payload);
    }
    await client.putUploadObject(upload.urls.bundle, bundleObject.payload);
    if (archiveObject && upload.urls.archive) {
      await client.putUploadObject(upload.urls.archive, archiveObject.payload);
    }
    const committed = await client.finalizeUpload({
      uploadId: upload.uploadId,
      artifact: {
        ...artifact,
        object: upload.objects.archive ?? upload.objects.bundle,
        artifactObjects: upload.objects,
      },
    });
    committedArtifact = committed.artifact;
    published = true;
  }

  const report = {
    status: flagBool(flags, 'dry-run') ? 'planned' : published ? 'published' : 'validated',
    noRemoteExecution: true,
    artifact: committedArtifact ?? artifact,
    dependenciesResolved: resolvedPins.length,
    workerValidatedPins: published,
    bundle,
  };
  if (json) {
    printJson(report);
  } else {
    console.log(success(`${report.status} ${pathLabel(`${manifest.owner}/${manifest.name}`)}`));
    printSection('Summary', [
      kv('kind', manifest.kind),
      kv('dependencies', resolvedPins.length),
      kv('worker validated', published),
      kv('remote execution', false),
    ]);
  }
}

async function findReadmePath(artifactDir: string, declaredReadme: string): Promise<string | undefined> {
  const declared = safeJoin(artifactDir, declaredReadme);
  if (await stat(declared).catch(() => undefined)) {
    return declared;
  }
  const match = (await readdir(artifactDir)).find(name => /^readme(?:\.[a-z0-9]+)?$/i.test(name));
  return match ? join(artifactDir, match) : undefined;
}
