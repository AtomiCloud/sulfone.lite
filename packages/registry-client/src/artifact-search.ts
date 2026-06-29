import { ArtifactKindSchema, type ArtifactVersion } from '@cyanprint/contracts';

export const artifactKinds = ['all', ...ArtifactKindSchema.options] as const;
export type ArtifactKindFilter = (typeof artifactKinds)[number];

export function normalizeArtifactKind(
  kind: string | null | undefined,
  fallback: ArtifactKindFilter = 'all',
): ArtifactKindFilter {
  return artifactKinds.includes(kind as ArtifactKindFilter) ? (kind as ArtifactKindFilter) : fallback;
}

export function filterArtifacts(
  artifacts: ArtifactVersion[],
  args: { query: string; kind?: string },
): ArtifactVersion[] {
  const tokens = tokenizeArtifactQuery(args.query);
  const kind = normalizeArtifactKind(args.kind);
  return artifacts.filter(artifact => {
    if (kind !== 'all' && artifact.kind !== kind) {
      return false;
    }
    return artifactMatchesQuery(artifactSearchText(artifact), tokens);
  });
}

export function artifactMatchesQuery(searchText: string, tokens: string[] | string): boolean {
  const normalizedTokens = Array.isArray(tokens) ? tokens : tokenizeArtifactQuery(tokens);
  if (normalizedTokens.length === 0) {
    return true;
  }
  const words = searchText
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter(Boolean);
  return normalizedTokens.every(token => words.some(word => word.startsWith(token)));
}

export function tokenizeArtifactQuery(query: string | undefined): string[] {
  return (query ?? '')
    .split(/[^a-z0-9_]+/i)
    .map(term => term.trim().toLowerCase())
    .filter(Boolean);
}

export function artifactFtsQuery(query: string | undefined): string {
  return tokenizeArtifactQuery(query)
    .map(term => `${term}*`)
    .join(' AND ');
}

export function artifactSearchText(artifact: ArtifactVersion): string {
  return [
    artifact.kind,
    artifact.owner,
    artifact.name,
    `${artifact.owner}/${artifact.name}`,
    `${artifact.owner}/${artifact.name}@${artifact.version}`,
    artifact.readme,
  ]
    .join('\n')
    .toLowerCase();
}
