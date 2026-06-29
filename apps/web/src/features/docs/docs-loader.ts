import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export async function loadDoc(slug: string): Promise<{ title: string; body: string }> {
  const docsRoot = await findDocsRoot();
  const path = resolve(docsRoot, `${slug}.md`);
  const fromRoot = relative(docsRoot, path);
  if (fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\') || isAbsolute(fromRoot)) {
    return { title: 'missing', body: '# Missing\n\nThis doc has not been written yet.' };
  }
  const body = await readFile(path, 'utf8').catch(() => '# Missing\n\nThis doc has not been written yet.');
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug.split('/').at(-1)?.replaceAll('-', ' ') ?? 'docs';
  return { title, body: body.replace(/^#\s+.+\n+/, '') };
}

async function findDocsRoot(): Promise<string> {
  let current = process.cwd();
  while (true) {
    const candidate = resolve(current, 'docs');
    if (await stat(resolve(candidate, 'user/quickstart.md')).catch(() => undefined)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(process.cwd(), 'docs');
    }
    current = parent;
  }
}
