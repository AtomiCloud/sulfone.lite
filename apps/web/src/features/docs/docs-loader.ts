import bundle from './docs-bundle.generated.json';

const docsBundle: Record<string, string> = bundle;

const missing = { title: 'Missing', body: 'This doc has not been written yet.' };

export async function loadDoc(slug: string): Promise<{ title: string; body: string }> {
  const source = Object.hasOwn(docsBundle, slug) ? docsBundle[slug] : undefined;
  if (source === undefined) {
    return missing;
  }
  const title = source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug.split('/').at(-1)?.replaceAll('-', ' ') ?? 'docs';
  return { title, body: source.replace(/^#\s+.+\n+/, '') };
}
