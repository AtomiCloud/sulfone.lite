import { afterEach, describe, expect, test } from 'bun:test';
import { loadShellArtifacts } from './shell-data';

const originalRegistryUrl = process.env.CYANPRINT_REGISTRY_URL;

afterEach(() => {
  if (originalRegistryUrl === undefined) {
    delete process.env.CYANPRINT_REGISTRY_URL;
  } else {
    process.env.CYANPRINT_REGISTRY_URL = originalRegistryUrl;
  }
});

describe('shell data', () => {
  test('a registry outage degrades to an empty catalog instead of throwing', async () => {
    process.env.CYANPRINT_REGISTRY_URL = 'http://127.0.0.1:1';
    const result = await loadShellArtifacts();
    expect(result.artifacts).toEqual([]);
    expect(result.registryUnavailable).toBe(true);
  });

  test('a reachable catalog is passed through', async () => {
    delete process.env.CYANPRINT_REGISTRY_URL;
    const result = await loadShellArtifacts();
    expect(result.registryUnavailable).toBe(false);
    expect(result.artifacts.length).toBeGreaterThan(0);
  });
});
