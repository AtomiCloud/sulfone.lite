import { CatalogPage } from '../../../features/catalog/catalog-page';

export default async function ArtifactTypePage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<{ cursor?: string; kind?: string; limit?: string; q?: string }>;
}) {
  const { type } = await params;
  const { cursor, kind, limit, q } = await searchParams;
  return <CatalogPage cursor={cursor} kind={kind} limit={limit} query={q} type={type} />;
}
