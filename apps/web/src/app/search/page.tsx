import { CatalogBrowser } from '../../features/catalog/catalog-browser';
import { normalizeArtifactKind } from '../../features/registry/artifact-search';
import { listRegistryArtifactPage } from '../../features/registry/registry-data';

export default async function SearchPage({
  searchParams,
}: {
  searchParams?: Promise<{ cursor?: string; kind?: string; limit?: string; q?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const kind = normalizeArtifactKind(params.kind);
  const query = params.q ?? '';
  const parsedLimit = Number(params.limit);
  const page = await listRegistryArtifactPage({
    cursor: params.cursor,
    kind: kind === 'all' ? undefined : kind,
    limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 100,
    query,
  });
  return (
    <CatalogBrowser
      artifacts={page.artifacts}
      displayKind={kind}
      displayQuery={query}
      headingLevel="h1"
      nextCursor={page.nextCursor}
    />
  );
}
