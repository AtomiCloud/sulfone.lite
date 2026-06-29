import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { parseCyanManifest, type ParsedManifest } from '@cyanprint/contracts';

export async function loadManifest(templateDir: string): Promise<ParsedManifest> {
  const raw = await readFile(join(templateDir, 'cyan.yaml'), 'utf8');
  const parsed = YAML.parse(raw) as unknown;
  return parseCyanManifest(parsed);
}
