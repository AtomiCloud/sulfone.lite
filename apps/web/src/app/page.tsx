import { CatalogBrowser } from '../features/catalog/catalog-browser';
import { normalizeArtifactKind } from '../features/registry/artifact-search';
import { listLatestRegistryArtifacts, listRegistryArtifactPage } from '../features/registry/registry-data';
import { LandingHero } from '../features/shell/landing-hero';

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ cursor?: string; kind?: string; limit?: string; q?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const kind = normalizeArtifactKind(params.kind);
  const query = params.q ?? '';
  const parsedLimit = Number(params.limit);
  const [heroArtifacts, catalogPage] = await Promise.all([
    listLatestRegistryArtifacts(),
    listRegistryArtifactPage({
      cursor: params.cursor,
      kind: kind === 'all' ? undefined : kind,
      limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 100,
      query,
    }),
  ]);
  return (
    <>
      <LandingHero artifacts={heroArtifacts} />
      <CatalogBrowser
        artifacts={catalogPage.artifacts}
        displayKind={kind}
        displayQuery={query}
        nextCursor={catalogPage.nextCursor}
      />
    </>
  );
}
