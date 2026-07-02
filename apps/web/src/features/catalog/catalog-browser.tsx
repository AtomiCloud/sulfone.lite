'use client';

import type { ArtifactVersion } from '@cyanprint/contracts';
import { Download, Heart, PackageCheck } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '../../components/ui/badge';
import { artifactDetailHref } from '../registry/artifact-url';
import { useUrlState } from '../shell/url-state';

export function CatalogBrowser({
  artifacts,
  displayKind,
  displayQuery,
  headingLevel = 'h2',
  nextCursor,
}: {
  artifacts: ArtifactVersion[];
  displayKind: string;
  displayQuery: string;
  headingLevel?: 'h1' | 'h2';
  nextCursor?: string;
}) {
  const { params } = useUrlState();

  return (
    <section className="catalog-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Registry search</p>
          {headingLevel === 'h1' ? <h1>{catalogTitle(displayKind)}</h1> : <h2>{catalogTitle(displayKind)}</h2>}
          <p className="lede">
            Use the centered search bar above to filter by text and artifact type. The URL always carries the current
            state.
          </p>
        </div>
      </div>
      <div className="result-meta">
        <span>{artifacts.length} results</span>
        {displayQuery ? <span>query: {displayQuery}</span> : <span>no query filter</span>}
      </div>
      <div className="artifact-grid">
        {artifacts.map(artifact => (
          <Link
            className="artifact-card"
            data-testid="artifact-card"
            key={`${artifact.kind}:${artifact.owner}:${artifact.name}:${artifact.version}`}
            href={artifactDetailHref(artifact, params)}
          >
            <span className="artifact-card-top">
              <Badge>{artifact.kind}</Badge>
              <small>v{artifact.version}</small>
            </span>
            <strong>
              {artifact.owner}/{artifact.name}
            </strong>
            <p>{descriptionFor(artifact)}</p>
            <span className="artifact-metrics">
              <small>
                <Download aria-hidden="true" size={14} />
                {artifact.downloads}
              </small>
              <small>
                <Heart aria-hidden="true" size={14} />
                {artifact.likes}
              </small>
              <small>
                <PackageCheck aria-hidden="true" size={14} />
                {artifact.resolvedPins.length} pins
              </small>
            </span>
          </Link>
        ))}
      </div>
      {artifacts.length === 0 ? (
        <div className="empty-state">
          <PackageCheck aria-hidden="true" size={28} />
          <strong>No artifacts match this URL state.</strong>
          <p>Clear the search query or switch artifact type.</p>
        </div>
      ) : null}
      {nextCursor ? (
        <div className="catalog-pagination">
          <Link className="btn btn-secondary" href={nextPageHref(params, nextCursor)}>
            Next page
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function catalogTitle(kind: string): string {
  if (!kind || kind === 'all') {
    return 'All artifacts';
  }
  return `${kind.replace('-', ' ')}s`;
}

function descriptionFor(artifact: ArtifactVersion): string {
  const firstTextLine = artifact.readme
    .split('\n')
    .map(line => line.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return firstTextLine ?? 'Pinned runtime artifact ready for local execution.';
}

function nextPageHref(params: URLSearchParams, cursor: string): string {
  const next = new URLSearchParams(params.toString());
  next.set('cursor', cursor);
  const query = next.toString();
  return query ? `?${query}` : '?cursor=0';
}
