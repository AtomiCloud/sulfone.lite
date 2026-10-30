import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RegistryClient, registryClientOptionsFromEnv } from '@cyanprint/registry-client';
import {
  artifactCachePath,
  claimCacheRoot,
  evaluateArtifactTrust,
  loadManifest,
  loadTrustStore,
  pinsFingerprint,
  resolveCyanCacheDir,
  resolveTrustStorePath,
  safeJoin,
  sha256,
} from '@cyanprint/core';
import { artifactIntegrity, type ArtifactVersion, type ObjectRef } from '@cyanprint/contracts';
import { defaultRegistryUrl } from './registry-defaults';
import { unpackLocalObjectPayload, unpackTemplateArchivePayload } from './local-object-package';

const textEncoder = new TextEncoder();

/**
 * A registry-aware resolver for installed templates' recorded sources: local paths pass
 * through; registry refs hydrate the requested version (or latest when none is given).
 * Used by create-into-existing-project and update to re-execute installed templates.
 */
export function registryTemplateSourceResolver(
  flags: Record<string, string | boolean>,
): (args: { source: string; version?: string }) => Promise<string> {
  return async ({ source, version }) => {
    const flagStr = (name: string): string | undefined => {
      const value = flags[name];
      return typeof value === 'string' ? value : undefined;
    };
    const ref = version && version !== 'local' && !source.includes('@') ? `${source}@${version}` : source;
    const resolved = await resolveTemplateInput({
      template: (await Bun.file(join(source, 'cyan.yaml')).exists()) ? source : ref,
      registry: flagStr('registry') ?? defaultRegistryUrl(),
      cacheDir: flagStr('cache-dir'),
      bypassCache: flags['bypass-cache'] === true,
      trusted: flags.trust === true,
      trustFixture: flagStr('trust-fixture'),
      trustDir: flagStr('trust-dir'),
    });
    return resolved.templateDir;
  };
}

export async function resolveTemplateInput(args: {
  template: string;
  registry?: string;
  cacheDir?: string;
  bypassCache?: boolean;
  trusted?: boolean;
  trustFixture?: string;
  trustDir?: string;
}): Promise<{
  templateDir: string;
  cacheHydrated: boolean;
  registryHydrated: boolean;
  /** Registry-assigned version of the resolved artifact (registry-hydrated only). */
  version?: string;
}> {
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
  const client = new RegistryClient(args.registry, undefined, undefined, registryClientOptionsFromEnv());
  const resolved = await client
    .batchResolve({
      refs: [
        { kind: 'template', owner, name, version },
        { kind: 'template-group', owner, name, version },
      ],
    })
    .catch(async (error: unknown) => {
      await throwIfLocalDirectory(args.template);
      throw error;
    });
  const artifact = resolved.resolved.find(item => item.kind === 'template') ?? resolved.resolved[0];
  if (!artifact) {
    await throwIfLocalDirectory(args.template);
    throw new Error(`Registry template not found: ${args.template}`);
  }
  if (!args.trusted && args.trustFixture !== 'local-registry') {
    const decision = evaluateArtifactTrust(await loadTrustStore(resolveTrustStorePath(args.trustDir)), artifact);
    if (!decision.trusted) {
      throw new Error(
        `${decision.reason} Run cyanprint trust approve before local execution.` +
          ` To trust this exact version: cyanprint trust approve version ${artifact.owner}/${artifact.name}` +
          ` --kind ${artifact.kind} --version ${artifact.version} --integrity '${artifactIntegrity(artifact)}'` +
          ` --pins-fingerprint '${pinsFingerprint(artifact.resolvedPins)}'`,
      );
    }
  }
  const cacheDir = resolveCyanCacheDir(args.cacheDir);
  const cachePath = await hydrateRegistryArtifactWithPins(client, artifact, cacheDir, args.bypassCache, new Set());
  return { templateDir: cachePath, cacheHydrated: true, registryHydrated: true, version: artifact.version };
}

async function throwIfLocalDirectory(template: string): Promise<void> {
  const isDirectory = await stat(template).then(
    entry => entry.isDirectory(),
    () => false,
  );
  if (isDirectory) {
    throw new Error(
      `${template} is a local directory without a cyan.yaml; prefix it with ./ to use it as a path or run from the template root.`,
    );
  }
}

type ArtifactBundleIndexEntry = {
  key: string;
  dependency: { kind: string; owner: string; name: string; version?: string };
  runtimeFile: string;
  integrity?: string;
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
  await claimCacheRoot(cacheDir);
  const stackKey = `${artifact.kind}:${artifact.owner}:${artifact.name}:${artifact.version}`;
  if (stack.has(stackKey)) {
    throw new Error(`Registry artifact dependency cycle detected: ${stackKey}`);
  }
  stack.add(stackKey);
  const artifactFingerprint = registryArtifactFingerprint(artifact);
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
    });
  }
  const bundleIndexJson = JSON.stringify({ bundles: bundleIndex }, null, 2);
  // A hit writes nothing: concurrent creates may be reading or executing from this entry.
  // A miss hydrates into a staging dir and swaps it in, so the entry is never half-written.
  // "Valid" is the full check (fingerprint + bundle index), also inside the install swap, so a
  // stale index is repaired instead of being kept as a "valid" entry that re-downloads forever.
  const isEntryValid = async (path: string): Promise<boolean> =>
    (await isCacheValid(path, artifactFingerprint)) &&
    (await readFile(join(path, '.cyan_artifact_bundles.json'), 'utf8').catch(() => undefined)) === bundleIndexJson;
  if (bypassCache || !(await isEntryValid(cachePath))) {
    const stagingPath = cacheStagingPath(cachePath);
    try {
      await mkdir(stagingPath, { recursive: true });
      await hydrateRegistryArtifact(client, artifact, stagingPath);
      await writeFile(join(stagingPath, '.cyan_artifact_bundles.json'), bundleIndexJson, 'utf8');
      await writeCacheIntegrity(stagingPath, artifactFingerprint);
      await installStagedCache(stagingPath, cachePath, isEntryValid, bypassCache);
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
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
  object?: ObjectRef;
  artifactObjects?: ArtifactVersion['artifactObjects'];
  resolvedPins: Array<{ kind: string; owner: string; name: string; version: string; integrity: string }>;
}): string {
  // Explicit, ordered fields: the registry's JSON key order must never change the cache key.
  const objectPart = (ref?: ObjectRef): string[] => (ref ? [ref.bucket, ref.key, ref.sha256, String(ref.size)] : []);
  return sha256(
    JSON.stringify([
      'registry-artifact-v2',
      artifact.kind,
      artifact.owner,
      artifact.name,
      artifact.version,
      objectPart(artifact.object),
      objectPart(artifact.artifactObjects?.manifest),
      objectPart(artifact.artifactObjects?.readme),
      objectPart(artifact.artifactObjects?.bundle),
      objectPart(artifact.artifactObjects?.archive),
      artifact.resolvedPins.map(pin => [pin.kind, pin.owner, pin.name, pin.version, pin.integrity]),
    ]),
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
  await claimCacheRoot(resolveCyanCacheDir(cacheDirOverride));
  const cachePath = artifactCachePath(resolveCyanCacheDir(cacheDirOverride), {
    kind: manifest.kind,
    owner: manifest.owner,
    name: manifest.name,
    version: manifest.version,
    integrity,
  });
  if (bypassCache || !(await isCacheValid(cachePath, integrity))) {
    const stagingPath = cacheStagingPath(cachePath);
    try {
      await mkdir(stagingPath, { recursive: true });
      await cp(templateDir, stagingPath, { recursive: true, force: true, verbatimSymlinks: true });
      await writeCacheIntegrity(stagingPath, integrity);
      await installStagedCache(stagingPath, cachePath, path => isCacheValid(path, integrity), bypassCache);
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  return { templateDir: cachePath, cacheHydrated: true, registryHydrated: false };
}

function cacheStagingPath(cachePath: string): string {
  return `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Atomically move a fully-written staging dir into place. An existing entry (invalid, or
 * being force-refreshed) is renamed aside first, because renaming onto a non-empty dir fails
 * with ENOTEMPTY; a concurrent writer that already installed a valid entry wins.
 */
async function installStagedCache(
  stagingPath: string,
  cachePath: string,
  isValid: (path: string) => Promise<boolean>,
  force: boolean,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rename(stagingPath, cachePath);
      return;
    } catch (error) {
      lastError = error;
    }
    if (!force && (await isValid(cachePath))) {
      await rm(stagingPath, { recursive: true, force: true });
      return;
    }
    const asidePath = `${stagingPath}.old`;
    const movedAside = await rename(cachePath, asidePath).then(
      () => true,
      () => false,
    );
    // A concurrent writer may have installed a valid entry between the check above and the
    // move-aside; re-check what was actually moved and put a valid one back.
    if (movedAside && !force && (await isValid(asidePath))) {
      // If the slot was refilled meanwhile, that entry wins and the displaced one is dropped.
      await rename(asidePath, cachePath).catch(() => undefined);
      await rm(asidePath, { recursive: true, force: true }).catch(() => undefined);
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    try {
      await rename(stagingPath, cachePath);
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (movedAside) {
      await rm(asidePath, { recursive: true, force: true }).catch(() => undefined);
    }
    if (lastError === undefined) {
      return;
    }
  }
  throw lastError;
}

/**
 * Content fingerprint of a template/cache directory. Symlinks are fingerprinted by their link
 * target string (never followed — `cp` copies them verbatim, and a dangling or looping link
 * must not break or hang the walk). A top-level `.git` is ignored: it is VCS state that is
 * never executed, and git activity in the source template must not change the cache key.
 */
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
      if (entry === '.git' && prefix === '') {
        continue;
      }
      const path = join(dir, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        chunks.push(`${relative}:symlink:${await readlink(path)}`);
      } else if (info.isDirectory()) {
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
