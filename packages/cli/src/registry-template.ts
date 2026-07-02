import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RegistryClient } from '@cyanprint/registry-client';
import {
  artifactCachePath,
  evaluateArtifactTrust,
  loadManifest,
  loadTrustStore,
  resolveCyanCacheDir,
  resolveTrustStorePath,
  safeJoin,
  sha256,
} from '@cyanprint/core';
import { artifactIntegrity, type ArtifactVersion, type ObjectRef } from '@cyanprint/contracts';
import { unpackLocalObjectPayload, unpackTemplateArchivePayload } from './local-object-package';

const textEncoder = new TextEncoder();

export async function resolveTemplateInput(args: {
  template: string;
  registry?: string;
  cacheDir?: string;
  bypassCache?: boolean;
  trusted?: boolean;
  trustFixture?: string;
  trustDir?: string;
}): Promise<{ templateDir: string; cacheHydrated: boolean; registryHydrated: boolean }> {
  const isLocalTemplate = await Bun.file(join(args.template, 'cyan.yaml')).exists();
  if (isLocalTemplate) {
    if (!args.cacheDir) {
      return { templateDir: args.template, cacheHydrated: false, registryHydrated: false };
    }
    return hydrateLocalTemplate(args.template, args.cacheDir, args.bypassCache);
  }
  if (
    !args.registry ||
    args.template.includes('/') === false ||
    args.template.startsWith('.') ||
    args.template.startsWith('/')
  ) {
    return { templateDir: args.template, cacheHydrated: false, registryHydrated: false };
  }
  const [owner, nameWithVersion] = args.template.split('/');
  const [name, version] = nameWithVersion?.split('@') ?? [];
  if (!owner || !name) {
    throw new Error(`Invalid registry template reference: ${args.template}`);
  }
  const client = new RegistryClient(args.registry);
  const resolved = await client.batchResolve({
    refs: [
      { kind: 'template', owner, name, version },
      { kind: 'template-group', owner, name, version },
    ],
  });
  const artifact = resolved.resolved.find(item => item.kind === 'template') ?? resolved.resolved[0];
  if (!artifact) {
    throw new Error(`Registry template not found: ${args.template}`);
  }
  if (!args.trusted && args.trustFixture !== 'local-registry') {
    const decision = evaluateArtifactTrust(await loadTrustStore(resolveTrustStorePath(args.trustDir)), artifact);
    if (!decision.trusted) {
      throw new Error(`${decision.reason} Run cyanprint trust approve before local execution.`);
    }
  }
  const cacheDir = resolveCyanCacheDir(args.cacheDir);
  const cachePath = await hydrateRegistryArtifactWithPins(client, artifact, cacheDir, args.bypassCache, new Set());
  return { templateDir: cachePath, cacheHydrated: true, registryHydrated: true };
}

type ArtifactBundleIndexEntry = {
  key: string;
  dependency: { kind: string; owner: string; name: string; version?: string };
  runtimeFile: string;
  integrity?: string;
  api?: 1 | 2;
};

async function hydrateRegistryArtifactWithPins(
  client: RegistryClient,
  artifact: ArtifactVersion,
  cacheDir: string,
  bypassCache = false,
  stack: Set<string>,
  pinnedIntegrity?: string,
): Promise<string> {
  const cachePath = artifactCachePath(cacheDir, {
    kind: artifact.kind,
    owner: artifact.owner,
    name: artifact.name,
    version: artifact.version,
    integrity: pinnedIntegrity ?? artifact.object?.sha256,
  });
  const stackKey = `${artifact.kind}:${artifact.owner}:${artifact.name}:${artifact.version}`;
  if (stack.has(stackKey)) {
    throw new Error(`Registry artifact dependency cycle detected: ${stackKey}`);
  }
  stack.add(stackKey);
  const artifactFingerprint = registryArtifactFingerprint(artifact);
  if (bypassCache || !(await isCacheValid(cachePath, artifactFingerprint))) {
    await mkdir(cachePath, { recursive: true });
    await hydrateRegistryArtifact(client, artifact, cachePath);
  }
  const bundleIndex: ArtifactBundleIndexEntry[] = [];
  for (const pin of artifact.resolvedPins) {
    const dependencyVersion = await resolvePinnedArtifact(client, pin);
    const dependencyCachePath = await hydrateRegistryArtifactWithPins(
      client,
      dependencyVersion,
      cacheDir,
      bypassCache,
      stack,
      pin.integrity,
    );
    const { manifest } = await loadManifest(dependencyCachePath);
    const runtimeFile = safeJoin(dependencyCachePath, manifest.bundledEntry);
    bundleIndex.push({
      key: `${pin.kind}:${pin.owner}:${pin.name}:${pin.version}`,
      dependency: { kind: pin.kind, owner: pin.owner, name: pin.name, version: pin.version },
      runtimeFile,
      integrity: sha256(await Bun.file(runtimeFile).text()),
      api: manifest.api,
    });
  }
  await writeFile(
    join(cachePath, '.cyan_artifact_bundles.json'),
    JSON.stringify({ bundles: bundleIndex }, null, 2),
    'utf8',
  );
  await writeCacheIntegrity(cachePath, artifactFingerprint);
  stack.delete(stackKey);
  return cachePath;
}

async function resolvePinnedArtifact(
  client: RegistryClient,
  pin: { kind: string; owner: string; name: string; version: string; integrity: string },
): Promise<ArtifactVersion> {
  const dependency = { kind: pin.kind, owner: pin.owner, name: pin.name, version: pin.version };
  const dependencyVersion = (await client.batchResolve({ refs: [dependency] })).resolved[0];
  if (!dependencyVersion) {
    throw new Error(`Registry artifact could not be resolved: ${pin.kind}:${pin.owner}:${pin.name}@${pin.version}`);
  }
  const expectedIntegrity = artifactIntegrity(dependencyVersion);
  if (pin.integrity !== expectedIntegrity) {
    throw new Error(`Resolved artifact pin integrity mismatch: ${pin.kind}:${pin.owner}:${pin.name}@${pin.version}`);
  }
  return dependencyVersion;
}

function registryArtifactFingerprint(artifact: {
  kind: string;
  owner: string;
  name: string;
  version: string;
  object?: { bucket: string; key: string; sha256: string; size: number };
  artifactObjects?: ArtifactVersion['artifactObjects'];
  resolvedPins: Array<{ kind: string; owner: string; name: string; version: string; integrity: string }>;
}): string {
  return sha256(
    JSON.stringify({
      kind: artifact.kind,
      owner: artifact.owner,
      name: artifact.name,
      version: artifact.version,
      object: artifact.object,
      artifactObjects: artifact.artifactObjects,
      resolvedPins: artifact.resolvedPins.map(pin => ({
        kind: pin.kind,
        owner: pin.owner,
        name: pin.name,
        version: pin.version,
        integrity: pin.integrity,
      })),
    }),
  );
}

async function hydrateRegistryArtifact(
  client: RegistryClient,
  artifact: ArtifactVersion,
  cachePath: string,
): Promise<void> {
  if (!artifact.artifactObjects) {
    if (!artifact.object) {
      throw new Error(
        `Registry artifact has no downloadable objects: ${artifact.kind}:${artifact.owner}:${artifact.name}@${artifact.version}`,
      );
    }
    const downloaded = await downloadVerified(client, artifact.object);
    await unpackLocalObjectPayload(downloaded, cachePath);
    return;
  }
  await rm(cachePath, { recursive: true, force: true });
  await mkdir(cachePath, { recursive: true });
  if (artifact.artifactObjects.archive) {
    await unpackTemplateArchivePayload(
      await downloadVerifiedBytes(client, artifact.artifactObjects.archive),
      cachePath,
    );
  }
  await writeFile(
    join(cachePath, 'cyan.yaml'),
    await downloadVerified(client, artifact.artifactObjects.manifest),
    'utf8',
  );
  if (artifact.artifactObjects.readme) {
    await writeFile(
      join(cachePath, 'README.md'),
      await downloadVerified(client, artifact.artifactObjects.readme),
      'utf8',
    );
  }
  const { manifest } = await loadManifest(cachePath);
  const bundlePath = safeJoin(cachePath, manifest.bundledEntry);
  await mkdir(dirname(bundlePath), { recursive: true });
  await writeFile(bundlePath, await downloadVerified(client, artifact.artifactObjects.bundle), 'utf8');
}

async function downloadVerified(client: RegistryClient, ref: ObjectRef): Promise<string> {
  return new TextDecoder().decode(await downloadVerifiedBytes(client, ref));
}

async function downloadVerifiedBytes(client: RegistryClient, ref: ObjectRef): Promise<Uint8Array> {
  const bytes = await client.downloadObjectBytes(ref);
  if (sha256(bytes) !== ref.sha256 || bytes.byteLength !== ref.size) {
    throw new Error(`Downloaded artifact object failed integrity check: ${ref.key}`);
  }
  return bytes;
}

async function hydrateLocalTemplate(
  templateDir: string,
  cacheDirOverride: string,
  bypassCache = false,
): Promise<{ templateDir: string; cacheHydrated: boolean; registryHydrated: boolean }> {
  const { manifest } = await loadManifest(templateDir);
  const integrity = await fingerprintDirectory(templateDir);
  const cachePath = artifactCachePath(resolveCyanCacheDir(cacheDirOverride), {
    kind: manifest.kind,
    owner: manifest.owner,
    name: manifest.name,
    version: manifest.version,
    integrity,
  });
  if (bypassCache || !(await isCacheValid(cachePath, integrity))) {
    const stagingPath = `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await rm(stagingPath, { recursive: true, force: true });
    await mkdir(stagingPath, { recursive: true });
    await cp(templateDir, stagingPath, { recursive: true, force: true, verbatimSymlinks: true });
    await writeCacheIntegrity(stagingPath, integrity);
    if (!bypassCache && (await isCacheValid(cachePath, integrity))) {
      await rm(stagingPath, { recursive: true, force: true });
    } else {
      if (bypassCache) {
        await rm(cachePath, { recursive: true, force: true });
      }
      try {
        await rename(stagingPath, cachePath);
      } catch (error) {
        if (!bypassCache && (await isCacheValid(cachePath, integrity))) {
          await rm(stagingPath, { recursive: true, force: true });
        } else {
          throw error;
        }
      }
    }
  }
  return { templateDir: cachePath, cacheHydrated: true, registryHydrated: false };
}

async function fingerprintDirectory(root: string): Promise<string> {
  const chunks: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir);
    for (const entry of entries.sort()) {
      if (entry === '.cyan_cache_integrity') {
        continue;
      }
      if (entry === '.cyan_cache_content_integrity') {
        continue;
      }
      const path = join(dir, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const info = await stat(path);
      if (info.isDirectory()) {
        await walk(path, relative);
      } else if (info.isFile()) {
        chunks.push(`${relative}:${sha256(await readFile(path))}`);
      }
    }
  }
  await walk(root, '');
  return sha256(chunks.join('\n'));
}

async function isCacheValid(cachePath: string, expected: string): Promise<boolean> {
  if (!(await Bun.file(join(cachePath, 'cyan.yaml')).exists())) {
    return false;
  }
  const actual = await readFile(join(cachePath, '.cyan_cache_integrity'), 'utf8').catch(() => undefined);
  if (actual !== expected) {
    return false;
  }
  const expectedContent = await readFile(join(cachePath, '.cyan_cache_content_integrity'), 'utf8').catch(
    () => undefined,
  );
  return expectedContent === (await fingerprintDirectory(cachePath));
}

async function writeCacheIntegrity(cachePath: string, artifactFingerprint: string): Promise<void> {
  await writeFile(join(cachePath, '.cyan_cache_integrity'), artifactFingerprint, 'utf8');
  await writeFile(join(cachePath, '.cyan_cache_content_integrity'), await fingerprintDirectory(cachePath), 'utf8');
}
