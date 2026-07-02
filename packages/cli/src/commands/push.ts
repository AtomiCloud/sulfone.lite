import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, runArtifactTests, runTemplateTest, safeJoin } from '@cyanprint/core';
import { RegistryClient } from '@cyanprint/registry-client';
import {
  artifactIntegrity,
  type ArtifactPublish,
  type CyanManifest,
  type ResolvedDependencyPin,
} from '@cyanprint/contracts';
import { buildBundle } from '@cyanprint/artifact-bundler';
import { parseFlags, flagBool, flagString } from '../args';
import { createArtifactTextObject, createTemplateArchivePayload } from '../local-object-package';
import { defaultRegistryUrl } from '../registry-defaults';
import { failure, info, kv, pathLabel, printJson, printSection, ReportedCliError, success } from '../ui';

export async function pushCommand(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const artifactDir = positional[0];
  if (!artifactDir) {
    throw new Error('push requires an artifact directory');
  }
  const json = flagBool(flags, 'json');
  const scriptOnly = flagBool(flags, 'script-only');
  const dryRun = flagBool(flags, 'dry-run');
  const skipBundle = flagBool(flags, 'no-bundle');
  const skipTest = flagBool(flags, 'no-test');
  const { manifest } = await loadManifest(artifactDir);
  if (!json) {
    console.log(info(`preparing ${manifest.kind} ${pathLabel(`${manifest.owner}/${manifest.name}`)}`));
  }
  if (!skipTest) {
    if (!json) {
      console.log(info(`testing ${pathLabel(`${manifest.owner}/${manifest.name}`)}`));
    }
    const testReport = await runPushTests(artifactDir, manifest);
    if (testReport.failed > 0) {
      if (!json) {
        console.log(
          failure(`tests failed for ${pathLabel(`${manifest.owner}/${manifest.name}`)} (${testReport.failed} failing)`),
        );
      }
      throw new ReportedCliError(`push aborted: ${testReport.failed} failing test(s). Fix them or pass --no-test.`);
    }
  }
  const refs = [...manifest.templates, ...manifest.processors, ...manifest.plugins, ...manifest.resolvers].map(ref => ({
    ...ref,
    owner: ref.owner ?? manifest.owner,
  }));
  const registry = flagString(flags, 'registry') ?? (flagBool(flags, 'dry-run') ? undefined : defaultRegistryUrl());
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
  const shouldBundle = !skipBundle && ['processor', 'plugin', 'resolver'].includes(manifest.kind);
  const bundle = shouldBundle
    ? await buildBundle({ artifactDir, dryRun, temporary: Boolean(registry) })
    : { runtimeFile: safeJoin(artifactDir, manifest.bundledEntry), dryRun, sha256: '' };
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

async function runPushTests(target: string, manifest: CyanManifest): Promise<{ failed: number }> {
  if (!(await hasTests(target))) {
    return { failed: 0 };
  }
  if (manifest.kind === 'template' || manifest.kind === 'template-group') {
    const outDir = await mkdtemp(join(tmpdir(), 'cyanprint-push-test-'));
    try {
      return await runTemplateTest({
        template: target,
        answers: await defaultTemplateAnswers(target),
        outDir,
        updateSnapshots: false,
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }
  return await runArtifactTests({ artifactDir: target });
}

async function defaultTemplateAnswers(target: string): Promise<string | undefined> {
  const answers = join(target, 'answers.json');
  return (await Bun.file(answers).exists()) ? answers : undefined;
}

async function hasTests(target: string): Promise<boolean> {
  if (await Bun.file(join(target, 'cyan.test.yaml')).exists()) {
    return true;
  }
  if (await Bun.file(join(target, 'test.cyan.yaml')).exists()) {
    return true;
  }
  return Boolean(await stat(join(target, 'tests')).catch(() => undefined));
}

async function findReadmePath(artifactDir: string, declaredReadme: string): Promise<string | undefined> {
  const declared = safeJoin(artifactDir, declaredReadme);
  if (await stat(declared).catch(() => undefined)) {
    return declared;
  }
  const match = (await readdir(artifactDir)).find(name => /^readme(?:\.[a-z0-9]+)?$/i.test(name));
  return match ? join(artifactDir, match) : undefined;
}
