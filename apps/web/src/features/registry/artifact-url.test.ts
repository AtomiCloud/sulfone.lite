import { describe, expect, test } from 'bun:test';
import type { ArtifactVersion } from '@cyanprint/contracts';
import { artifactDetailHref, artifactTypeHref } from './artifact-url';

describe('artifact URL helpers', () => {
  test('encodes artifact detail path segments and preserves query state', () => {
    const params = new URLSearchParams({ q: 'resolver test', kind: 'all' });
    const artifact = {
      kind: 'template',
      owner: 'org/name?',
      name: 'hello#world%',
    } as ArtifactVersion;

    expect(artifactDetailHref(artifact, params)).toBe(
      '/artifacts/template/org%2Fname%3F/hello%23world%25?q=resolver+test&kind=all',
    );
  });

  test('encodes artifact type path segments', () => {
    expect(artifactTypeHref('template/group')).toBe('/artifacts/template%2Fgroup');
  });
});
