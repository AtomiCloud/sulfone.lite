import { describe, expect, test } from 'bun:test';
import { artifactFtsQuery, filterArtifacts, normalizeArtifactKind } from './artifact-search';
import { RegistryClient } from './client';
import { seedArtifacts } from './local-registry';

describe('artifact search helpers', () => {
  test('normalizes invalid artifact kinds to all by default', () => {
    expect(normalizeArtifactKind('bogus')).toBe('all');
    expect(normalizeArtifactKind(null)).toBe('all');
    expect(normalizeArtifactKind(undefined)).toBe('all');
  });

  test('preserves valid artifact kinds and supports typed fallbacks', () => {
    expect(normalizeArtifactKind('resolver')).toBe('resolver');
    expect(normalizeArtifactKind('bogus', 'template')).toBe('template');
  });

  test('uses tokenized prefix semantics for multi-term artifact queries', () => {
    expect(artifactFtsQuery('hello template')).toBe('hello* AND template*');
    expect(filterArtifacts(seedArtifacts, { kind: 'template', query: 'hello template' })).toEqual([
      expect.objectContaining({ name: 'hello' }),
    ]);
    expect(filterArtifacts(seedArtifacts, { kind: 'template', query: 'template hello' })).toEqual([
      expect.objectContaining({ name: 'hello' }),
    ]);
  });
});

describe('registry client URLs', () => {
  test('normalizes trailing slashes before joining API paths', async () => {
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      seen.push(String(input));
      return Promise.resolve(Response.json({ artifacts: [] }));
    }) as typeof fetch;
    try {
      await new RegistryClient('http://127.0.0.1:8787/').search({ kind: 'template' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seen).toEqual(['http://127.0.0.1:8787/artifacts?kind=template']);
  });
});
