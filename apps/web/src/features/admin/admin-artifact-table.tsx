import type { ArtifactVersion, ObjectRef } from '@cyanprint/contracts';
import Link from 'next/link';

export function AdminArtifactTable({
  artifacts,
  nextCursor,
  params,
}: {
  artifacts: ArtifactVersion[];
  nextCursor?: string;
  params: { cursor?: string; kind?: string; limit?: string; q?: string };
}) {
  return (
    <section className="stack">
      <div>
        <p className="eyebrow">Admin review</p>
        <h1>Artifact moderation</h1>
      </div>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Artifact</th>
              <th>Owner</th>
              <th>Object</th>
              <th>Pins</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {artifacts.map(artifact => (
              <tr key={artifact.id}>
                <td>
                  {artifact.kind}/{artifact.name}
                </td>
                <td>{artifact.owner}</td>
                <td>{objectSummary(artifact)}</td>
                <td>{artifact.resolvedPins.length}</td>
                <td>{artifact.moderationState}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextCursor ? (
        <Link className="btn btn-secondary" href={adminNextHref(params, nextCursor)}>
          Next page
        </Link>
      ) : null}
    </section>
  );
}

function adminNextHref(
  params: {
    cursor?: string;
    kind?: string;
    limit?: string;
    q?: string;
  },
  cursor: string,
): string {
  const next = new URLSearchParams();
  for (const key of ['kind', 'limit', 'q'] as const) {
    if (params[key]) {
      next.set(key, params[key]);
    }
  }
  next.set('cursor', cursor);
  return `?${next.toString()}`;
}

function objectSummary(artifact: ArtifactVersion): string {
  if (artifact.artifactObjects) {
    return Object.entries(artifact.artifactObjects)
      .filter((entry): entry is [string, ObjectRef] => Boolean(entry[1]))
      .map(([part, ref]) => `${part}:${ref.size}b`)
      .join(', ');
  }
  return artifact.object?.key ?? 'metadata-only';
}
