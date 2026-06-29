import { NextResponse } from 'next/server';
import { normalizeArtifactKind } from '../../../../features/registry/artifact-search';
import { listRegistryArtifactPage } from '../../../../features/registry/registry-data';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const kind = normalizeArtifactKind(url.searchParams.get('kind'));
  const limit = Number(url.searchParams.get('limit'));
  const page = await listRegistryArtifactPage({
    cursor: url.searchParams.get('cursor') ?? undefined,
    kind: kind === 'all' ? undefined : kind,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 8,
    query: url.searchParams.get('q') ?? undefined,
  });
  return NextResponse.json(page);
}
