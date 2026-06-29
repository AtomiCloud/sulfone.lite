import type { ArtifactVersion } from '@cyanprint/contracts';
import { ArrowRight, Box, Code2, GitBranch, Search } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '../../components/ui/badge';
import { ButtonLink } from '../../components/ui/button';

export function LandingHero({ artifacts }: { artifacts: ArtifactVersion[] }) {
  const counts = countKinds(artifacts);
  return (
    <section className="hero">
      <div className="hero-paper" aria-hidden="true">
        <span className="paper-line line-a" />
        <span className="paper-line line-b" />
        <span className="paper-line line-c" />
      </div>
      <div className="hero-content">
        <Badge>Local-first registry</Badge>
        <h1>CyanPrint</h1>
        <p>
          Ship folder-based templates, pinned processors, plugins, and resolvers through a registry that still runs
          every generation locally with Bun.
        </p>
        <div className="hero-search-card">
          <Search aria-hidden="true" size={18} />
          <span>Find a template, processor, plugin, or resolver</span>
          <Link href="/search">
            Search
            <ArrowRight aria-hidden="true" size={16} />
          </Link>
        </div>
        <div className="hero-actions">
          <ButtonLink href="/docs/user/quickstart">Start using it</ButtonLink>
          <ButtonLink href="/docs/user/artifact-authoring" tone="secondary">
            Write templates
          </ButtonLink>
        </div>
      </div>
      <div className="hero-ledger" aria-label="Registry summary">
        <span>
          <Box aria-hidden="true" size={18} />
          <strong>{counts.template ?? 0}</strong>
          templates
        </span>
        <span>
          <Code2 aria-hidden="true" size={18} />
          <strong>{(counts.processor ?? 0) + (counts.plugin ?? 0)}</strong>
          processors + plugins
        </span>
        <span>
          <GitBranch aria-hidden="true" size={18} />
          <strong>{counts.resolver ?? 0}</strong>
          resolvers
        </span>
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
