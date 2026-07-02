import type { ArtifactVersion } from '@cyanprint/contracts';
import { filterArtifacts, RegistryClient, seedArtifacts } from '@cyanprint/registry-client';

export type RegistryArtifactPage = {
  artifacts: ArtifactVersion[];
  nextCursor?: string;
};

export async function listRegistryArtifacts(
  args: {
    cursor?: string;
    kind?: string;
    limit?: number;
    query?: string;
  } = {},
): Promise<ArtifactVersion[]> {
  const page = await listRegistryArtifactPage(args);
  return page.artifacts;
}

export async function listRegistryArtifactPage(
  args: {
    cursor?: string;
    kind?: string;
    limit?: number;
    query?: string;
  } = {},
): Promise<RegistryArtifactPage> {
  const registry = process.env.CYANPRINT_REGISTRY_URL;
  if (registry) {
    const response = await new RegistryClient(registry).search(args);
    return { artifacts: response.artifacts, nextCursor: response.nextCursor };
  }
  const limit = args.limit ?? 100;
  const matching = sortArtifacts(filterArtifacts(seedArtifacts, { kind: args.kind, query: args.query ?? '' }));
  const decoded = decodeSeedCursor(args.cursor);
  const start = decoded
    ? Math.max(
        0,
        matching.findIndex(artifact => compareSeedArtifactToCursor(artifact, decoded) > 0),
      )
    : 0;
  const artifacts = matching.slice(start, start + limit);
  const nextArtifact = artifacts.at(-1);
  return {
    artifacts,
    ...(start + artifacts.length < matching.length && nextArtifact
      ? { nextCursor: encodeSeedCursor(nextArtifact) }
      : {}),
  };
}

export async function listLatestRegistryArtifacts(
  args: {
    cursor?: string;
    kind?: string;
    limit?: number;
    query?: string;
  } = {},
): Promise<ArtifactVersion[]> {
  const registry = process.env.CYANPRINT_REGISTRY_URL;
  if (registry) {
    return (await new RegistryClient(registry).latest(args)).artifacts;
  }
  const latest = new Map<string, ArtifactVersion>();
  const matching = sortArtifacts(filterArtifacts(seedArtifacts, { kind: args.kind, query: args.query ?? '' }));
  for (const artifact of matching) {
    const key = `${artifact.kind}:${artifact.owner}:${artifact.name}`;
    const current = latest.get(key);
    if (!current || compareVersions(artifact.version, current.version) > 0) {
      latest.set(key, artifact);
    }
  }
  return [...latest.values()].sort(compareArtifacts);
}

export async function listRegistryArtifactVersions(args: {
  type: string;
  owner: string;
  name: string;
}): Promise<ArtifactVersion[]> {
  const registry = process.env.CYANPRINT_REGISTRY_URL;
  if (registry) {
    return (await new RegistryClient(registry).listArtifactVersions(args.type, args.owner, args.name)).artifacts;
  }
  return seedArtifacts
    .filter(artifact => artifact.owner === args.owner && artifact.name === args.name)
    .filter(artifact => artifact.kind === args.type)
    .toSorted((left, right) => compareVersions(right.version, left.version));
}

function sortArtifacts(artifacts: ArtifactVersion[]): ArtifactVersion[] {
  return artifacts.toSorted(compareArtifacts);
}

function compareArtifacts(left: ArtifactVersion, right: ArtifactVersion): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.owner.localeCompare(right.owner) ||
    left.name.localeCompare(right.name) ||
    compareVersions(right.version, left.version)
  );
}

function compareVersions(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}

type SeedCursor = {
  kind: string;
  owner: string;
  name: string;
  version: string;
  id: string;
};

function encodeSeedCursor(artifact: ArtifactVersion): string {
  return btoa(
    JSON.stringify({
      kind: artifact.kind,
      owner: artifact.owner,
      name: artifact.name,
      version: artifact.version,
      id: artifact.id,
    } satisfies SeedCursor),
  );
}

function decodeSeedCursor(cursor: string | undefined): SeedCursor | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(atob(cursor)) as Partial<SeedCursor>;
    return parsed.kind && parsed.owner && parsed.name && parsed.version && parsed.id
      ? {
          kind: parsed.kind,
          owner: parsed.owner,
          name: parsed.name,
          version: parsed.version,
          id: parsed.id,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function compareSeedArtifactToCursor(artifact: ArtifactVersion, cursor: SeedCursor): number {
  return (
    artifact.kind.localeCompare(cursor.kind) ||
    artifact.owner.localeCompare(cursor.owner) ||
    artifact.name.localeCompare(cursor.name) ||
    compareVersions(cursor.version, artifact.version) ||
    artifact.id.localeCompare(cursor.id)
  );
}
