import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { ArtifactBundleRef } from '@cyanprint/artifact-runner';
import type { ArtifactDependency, ArtifactKind } from '@cyanprint/contracts';
import { parseCyanManifest } from '@cyanprint/contracts';
import { sha256 } from '../util';

export async function resolveDevArtifactBundle(args: {
  workspaceRoot: string;
  templateDir?: string;
  /** The artifact kind, implied by the declaration context the dependency came from. */
  kind: ArtifactKind;
  dependency: ArtifactDependency;
  defaultOwner?: string;
  localFallback?: boolean;
}): Promise<ArtifactBundleRef> {
  if (args.templateDir) {
    const cached = await readCachedArtifactBundle(args.templateDir, args.kind, args.dependency, args.defaultOwner);
    if (cached) {
      return cached;
    }
  }
  if (args.localFallback === false || process.env.CYANPRINT_DISABLE_LOCAL_ARTIFACT_FALLBACK === '1') {
    throw new Error(
      `Local artifact fallback is disabled and no cached bundle was found for ${args.kind} ${args.dependency.owner ?? args.defaultOwner ?? 'local'}/${args.dependency.name}`,
    );
  }
  const artifactsRoot = await findArtifactsRoot(
    args.templateDir ?? args.workspaceRoot,
    args.workspaceRoot,
    dirname(fileURLToPath(import.meta.url)),
  );
  const entries = await readdir(artifactsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const artifactDir = join(artifactsRoot, entry.name);
    const manifest = parseCyanManifest(YAML.parse(await readFile(join(artifactDir, 'cyan.yaml'), 'utf8'))).manifest;
    if (
      manifest.kind === args.kind &&
      manifest.name === args.dependency.name &&
      manifest.owner === (args.dependency.owner ?? args.defaultOwner ?? manifest.owner) &&
      (!args.dependency.version || manifest.version === args.dependency.version)
    ) {
      const runtimeFile = join(artifactDir, manifest.entry);
      return {
        dependency: { kind: manifest.kind, owner: manifest.owner, name: manifest.name, version: manifest.version },
        runtimeFile,
        integrity: sha256(await readFile(runtimeFile)),
      };
    }
  }
  throw new Error(
    `Unable to resolve dev artifact bundle for ${args.kind} ${args.dependency.owner ?? 'local'}/${args.dependency.name}`,
  );
}

async function findArtifactsRoot(...starts: Array<string | undefined>): Promise<string> {
  for (const start of starts) {
    if (!start) {
      continue;
    }
    let current = resolve(start);
    const currentInfo = await stat(current).catch(() => undefined);
    if (currentInfo?.isFile()) {
      current = dirname(current);
    }
    while (true) {
      const candidate = join(current, 'examples/artifacts');
      const info = await stat(candidate).catch(() => undefined);
      if (info?.isDirectory()) {
        return candidate;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  throw new Error('Unable to locate examples/artifacts from template or workspace path.');
}

async function readCachedArtifactBundle(
  templateDir: string,
  kind: ArtifactKind,
  dependency: ArtifactDependency,
  defaultOwner = 'local',
): Promise<ArtifactBundleRef | undefined> {
  const indexPath = join(templateDir, '.cyan_artifact_bundles.json');
  const raw = await readFile(indexPath, 'utf8').catch(() => undefined);
  if (!raw) {
    return undefined;
  }
  const index = JSON.parse(raw) as {
    bundles?: Array<{
      key: string;
      dependency: ArtifactBundleRef['dependency'];
      runtimeFile: string;
      integrity?: string;
    }>;
  };
  const owner = dependency.owner ?? defaultOwner;
  // Bundle index keys are registry-internal and keep the kind prefix; the kind here comes
  // from the declaration context, never from the dependency itself.
  const exactKey = `${kind}:${owner}:${dependency.name}:${dependency.version ?? ''}`;
  const unversionedKey = `${kind}:${owner}:${dependency.name}`;
  const match = index.bundles?.find(bundle => {
    if (bundle.key === exactKey || (!dependency.version && bundle.key === unversionedKey)) {
      return true;
    }
    if (dependency.version) {
      return false;
    }
    const [bundleKind, bundleOwner, name] = bundle.key.split(':');
    return bundleKind === kind && bundleOwner === owner && name === dependency.name;
  });
  if (!match) {
    return undefined;
  }
  return {
    dependency: match.dependency,
    runtimeFile: match.runtimeFile,
    integrity: match.integrity,
  };
}
