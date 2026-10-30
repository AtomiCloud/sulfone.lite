import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { bundlePath, renderDocsBundle } from '../../../scripts/generate-docs-bundle';
import { loadDoc } from './docs-loader';

describe('docs loader', () => {
  test('docs are bundled at build time and stay in sync with docs/user', async () => {
    expect(await readFile(bundlePath, 'utf8')).toBe(await renderDocsBundle());
  });

  test('serves docs without touching the filesystem at runtime', async () => {
    const originalCwd = process.cwd();
    process.chdir('/');
    try {
      const doc = await loadDoc('user/quickstart');
      expect(doc.title).not.toBe('Missing');
      expect(doc.body.length).toBeGreaterThan(100);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('unknown and traversal slugs return the missing page', async () => {
    for (const slug of ['user/nope', '../package', 'user/../../package', '/etc/passwd']) {
      expect((await loadDoc(slug)).title).toBe('Missing');
    }
  });
});
