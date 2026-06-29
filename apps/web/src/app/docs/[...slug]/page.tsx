import { loadDoc } from '../../../features/docs/docs-loader';
import { MarkdownReadme } from '../../../features/artifacts/markdown-readme';

export default async function DocsPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const doc = await loadDoc(slug.join('/'));
  return (
    <article className="doc">
      <p className="eyebrow">Docs</p>
      <h1>{doc.title}</h1>
      <MarkdownReadme markdown={doc.body} />
    </article>
  );
}
