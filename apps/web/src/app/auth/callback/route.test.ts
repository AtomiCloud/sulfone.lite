import { afterEach, describe, expect, test } from 'bun:test';
import { GET } from './route';

const originalRegistryUrl = process.env.CYANPRINT_REGISTRY_URL;

afterEach(() => {
  if (originalRegistryUrl === undefined) {
    delete process.env.CYANPRINT_REGISTRY_URL;
  } else {
    process.env.CYANPRINT_REGISTRY_URL = originalRegistryUrl;
  }
});

describe('web GitHub callback route', () => {
  test('rejects auth handoffs without the matching browser nonce', async () => {
    process.env.CYANPRINT_REGISTRY_URL = 'https://registry.cyanprint.dev';
    const response = await GET(new Request('https://cyanprint.dev/auth/callback?handoff=cph_test&nonce=cpon_url'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://cyanprint.dev/account?error=invalid_login_nonce');
    expect(response.headers.get('set-cookie')).toContain('cyanprint_oauth_nonce=');
  });

  test('consumes auth handoff only when nonce cookie matches', async () => {
    process.env.CYANPRINT_REGISTRY_URL = 'https://registry.cyanprint.dev';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://registry.cyanprint.dev/auth/github/consume');
      expect(init?.body).toBe(JSON.stringify({ handoff: 'cph_test' }));
      return Response.json({ session: 'cps_test', user: { id: 'github:1', handle: 'ada' } });
    }) as typeof fetch;
    try {
      const response = await GET(
        new Request('https://cyanprint.dev/auth/callback?handoff=cph_test&nonce=cpon_cookie', {
          headers: { cookie: 'cyanprint_oauth_nonce=cpon_cookie' },
        }),
      );
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://cyanprint.dev/account/tokens');
      expect(response.headers.get('set-cookie')).toContain('cyanprint_session=cps_test');
      expect(response.headers.get('set-cookie')).toContain('cyanprint_oauth_nonce=');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
