import { describe, expect, test } from 'bun:test';
import { isLocalRegistryUrl, listTokens } from './token-service';

describe('account token service', () => {
  test('detects local registry URLs', () => {
    expect(isLocalRegistryUrl('http://127.0.0.1:8787')).toBe(true);
    expect(isLocalRegistryUrl('http://localhost:8787')).toBe(true);
    expect(isLocalRegistryUrl('http://[::1]:8787')).toBe(true);
    expect(isLocalRegistryUrl('https://registry.cyanprint.dev')).toBe(false);
  });

  test('preserves registry error status for stale token sessions', async () => {
    const originalRegistryUrl = process.env.CYANPRINT_REGISTRY_URL;
    const originalFetch = globalThis.fetch;
    process.env.CYANPRINT_REGISTRY_URL = 'https://registry.cyanprint.dev';
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(
        {
          category: 'auth',
          code: 'missing_session',
          message: 'A local authenticated session is required.',
        },
        { status: 401 },
      )) as unknown as typeof fetch;
    try {
      let error: unknown;
      try {
        await listTokens('cps_stale');
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('A local authenticated session is required.');
      expect((error as { status?: number }).status).toBe(401);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalRegistryUrl === undefined) {
        delete process.env.CYANPRINT_REGISTRY_URL;
      } else {
        process.env.CYANPRINT_REGISTRY_URL = originalRegistryUrl;
      }
    }
  });
});
