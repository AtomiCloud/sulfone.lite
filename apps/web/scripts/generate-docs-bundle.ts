import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = resolve(webDir, '../../docs/user');
export const bundlePath = join(webDir, 'src/features/docs/docs-bundle.generated.json');

export async function renderDocsBundle(dir: string = docsDir): Promise<string> {
  const files = (await readdir(dir)).filter(file => file.endsWith('.md')).sort();
  const bundle: Record<string, string> = {};
  for (const file of files) {
    bundle[`user/${file.slice(0, -3)}`] = await readFile(join(dir, file), 'utf8');
  }
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

if (import.meta.main) {
  await writeFile(bundlePath, await renderDocsBundle());
}
