import type { ArtifactVersion } from '@cyanprint/contracts';
import { Download, Heart, PackageCheck, ShieldCheck } from 'lucide-react';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Badge } from '../../components/ui/badge';
import { CopyCommand } from './copy-command';
import { MarkdownReadme } from './markdown-readme';
import { listRegistryArtifactVersions } from '../registry/registry-data';

export async function ArtifactDetail({ type, owner, name }: { type: string; owner: string; name: string }) {
  const versions = await listRegistryArtifactVersions({ type, owner, name });
  const artifact = versions[0];
  if (!artifact) {
    notFound();
  }
  const readme = artifact?.readme || fallbackReadme(type, owner, name);
  const dependencyCommand = dependencyEntryFor(type, owner, name, artifact?.version);
  const isCreatable = type === 'template' || type === 'template-group';
  return (
    <section className="artifact-detail">
      <div className="artifact-hero">
        <div className="artifact-title-block">
          <p className="eyebrow">{type}</p>
          <h1>
            {owner}/{name}
          </h1>
          <p className="lede">{summaryFromReadme(readme)}</p>
          <div className="artifact-title-meta">
            <Badge>{type}</Badge>
            <span>v{artifact?.version ?? 'unknown'}</span>
            <span>{artifact?.scriptOnly ? 'script-only' : 'folder artifact'}</span>
          </div>
        </div>
        <div className="artifact-command-panel">
          {isCreatable ? <CopyCommand command={`cyanprint create ${owner}/${name}`} label="Use template" /> : null}
          {dependencyCommand ? <CopyCommand command={dependencyCommand} label="Add dependency" /> : null}
        </div>
      </div>

      <div className="artifact-stat-grid">
        <Metric icon={<Download aria-hidden="true" size={18} />} label="downloads" value={artifact?.downloads ?? 0} />
        <Metric icon={<Heart aria-hidden="true" size={18} />} label="likes" value={artifact?.likes ?? 0} />
        <Metric icon={<PackageCheck aria-hidden="true" size={18} />} label="versions" value={versions.length || 1} />
        <Metric
          icon={<ShieldCheck aria-hidden="true" size={18} />}
          label="pins"
          value={artifact?.resolvedPins.length ?? 0}
        />
      </div>

      <div className="artifact-layout">
        <article className="readme-panel">
          <div className="panel-heading">
            <p className="eyebrow">Rendered markdown</p>
            <h2>README</h2>
          </div>
          <MarkdownReadme markdown={readme} />
        </article>

        <aside className="artifact-sidebar">
          <div className="panel">
            <h2>Version history</h2>
            <div className="version-list" data-testid="version-list">
              {versions.map(version => (
                <div className="version-row" key={`${version.version}:${version.id}`}>
                  <div>
                    <strong>v{version.version}</strong>
                    <small>{publishedDateFor(version)}</small>
                  </div>
                  <span>{version.downloads.toLocaleString()} downloads</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h2>Dependency pins</h2>
            {artifact?.resolvedPins.length ? (
              <div className="pin-list">
                {artifact.resolvedPins.map(pin => (
                  <code key={`${pin.kind}:${pin.owner}/${pin.name}@${pin.version}`}>
                    {pin.kind}: {pin.owner}/{pin.name}@{pin.version}
                  </code>
                ))}
              </div>
            ) : (
              <p className="muted-copy">No pinned runtime dependencies.</p>
            )}
          </div>

          <div className="panel">
            <h2>Objects</h2>
            <dl className="facts">
              <dt>Manifest</dt>
              <dd>{artifact?.artifactObjects?.manifest.key ?? artifact?.object?.key ?? 'metadata only'}</dd>
              <dt>Bundle</dt>
              <dd>{artifact?.artifactObjects?.bundle.key ?? 'not published'}</dd>
              <dt>Archive</dt>
              <dd>{artifact?.artifactObjects?.archive?.key ?? 'none'}</dd>
            </dl>
          </div>
        </aside>
      </div>
    </section>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="artifact-stat">
      {icon}
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}

function dependencyEntryFor(type: string, owner: string, name: string, version?: string): string | undefined {
  if (type === 'template-group') {
    return undefined;
  }
  const section = dependencySectionFor(type);
  const ref = `${owner}/${name}${version ? `@${version}` : ''}`;
  return `${section}:\n  - ${ref}`;
}

function dependencySectionFor(type: string): string {
  if (type === 'template') {
    return 'templates';
  }
  return `${type}s`;
}

function fallbackReadme(type: string, owner: string, name: string): string {
  const command = type === 'template' ? `\n\n\`\`\`bash\ncyanprint create ${owner}/${name}\n\`\`\`` : '';
  return `# ${owner}/${name}\n\nPinned CyanPrint ${type} artifact.${command}`;
}

function summaryFromReadme(readme: string): string {
  return (
    readme
      .split('\n')
      .map(line => line.replace(/^#+\s*/, '').trim())
      .find(line => line && !line.startsWith('```')) ?? 'Pinned CyanPrint artifact ready for local execution.'
  );
}

function publishedDateFor(artifact: ArtifactVersion): string {
  if (!artifact.publishedAt) {
    return 'Date unavailable';
  }
  const date = new Date(artifact.publishedAt);
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    date,
  );
}
