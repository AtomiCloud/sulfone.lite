import type { ArtifactVersion } from '@cyanprint/contracts';
import { Badge } from '../../components/ui/badge';
import { ButtonLink } from '../../components/ui/button';

export function LandingHero({ artifacts }: { artifacts: ArtifactVersion[] }) {
  const counts = countKinds(artifacts);
  return (
    <section className="hero">
      <div className="hero-scene" aria-hidden="true">
        <div className="scene-rail rail-one" />
        <div className="scene-rail rail-two" />
      </div>
      <div className="hero-content">
        <Badge>Local-first registry</Badge>
        <h1>CyanPrint v4</h1>
        <p>
          A Bun-native template registry where templates download once, execute locally, and stay deterministic through
          pinned processors, plugins, and resolvers.
        </p>
        <div className="hero-actions">
          <ButtonLink href="/artifacts/template">Browse templates</ButtonLink>
          <ButtonLink href="/docs/user/quickstart" tone="secondary">
            Read quickstart
          </ButtonLink>
        </div>
        <div className="hero-dashboard" aria-label="Registry artifact summary">
          <div className="hero-stats">
            <span>
              <strong>{counts.template ?? 0}</strong>
              templates
            </span>
            <span>
              <strong>{counts.processor ?? 0}</strong>
              processors
            </span>
            <span>
              <strong>{counts.resolver ?? 0}</strong>
              resolvers
            </span>
          </div>
          <div className="hero-feed">
            {artifacts.slice(0, 4).map(artifact => (
              <span key={artifact.id}>
                <Badge>{artifact.kind}</Badge>
                <strong>
                  {artifact.owner}/{artifact.name}
                </strong>
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function countKinds(artifacts: ArtifactVersion[]): Record<string, number> {
  return artifacts.reduce<Record<string, number>>((counts, artifact) => {
    counts[artifact.kind] = (counts[artifact.kind] ?? 0) + 1;
    return counts;
  }, {});
}
