import { normalizeArtifactKind } from '../registry/artifact-search';
import { listRegistryArtifactPage } from '../registry/registry-data';
import { CatalogBrowser } from './catalog-browser';

export async function CatalogPage({
  cursor,
  kind: requestedKind,
  limit,
  query,
  type,
}: {
  cursor?: string;
  kind?: string;
  limit?: string;
  query?: string;
  type: string;
}) {
  const normalizedKind = normalizeArtifactKind(requestedKind, normalizeArtifactKind(type));
  const kind = normalizedKind === 'all' ? undefined : normalizedKind;
  const parsedLimit = Number(limit);
  const page = await listRegistryArtifactPage({
    cursor,
    kind,
    limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 100,
    query,
  });
  return (
    <CatalogBrowser
      artifacts={page.artifacts}
      displayKind={normalizedKind}
      displayQuery={query ?? ''}
      headingLevel="h1"
      nextCursor={page.nextCursor}
    />
  );
}
