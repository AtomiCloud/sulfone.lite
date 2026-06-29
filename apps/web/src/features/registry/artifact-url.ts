import type { ArtifactVersion } from '@cyanprint/contracts';

export function artifactDetailHref(artifact: ArtifactVersion, params?: URLSearchParams): string {
  return withQuery(
    `/artifacts/${encodeURIComponent(artifact.kind)}/${encodeURIComponent(artifact.owner)}/${encodeURIComponent(artifact.name)}`,
    params,
  );
}

export function artifactTypeHref(kind: string, params?: URLSearchParams): string {
  return withQuery(`/artifacts/${encodeURIComponent(kind)}`, params);
}

function withQuery(pathname: string, params?: URLSearchParams): string {
  const query = params?.toString();
  return query ? `${pathname}?${query}` : pathname;
}
