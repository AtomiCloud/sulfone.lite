import { afterEach, describe, expect, test } from 'bun:test';
import { GET, POST } from './route';

const originalRegistryUrl = process.env.CYANPRINT_REGISTRY_URL;

afterEach(() => {
  if (originalRegistryUrl === undefined) {
    delete process.env.CYANPRINT_REGISTRY_URL;
  } else {
    process.env.CYANPRINT_REGISTRY_URL = originalRegistryUrl;
  }
});

describe('web logout route', () => {
  test('GET logout does not revoke the session', async () => {
    process.env.CYANPRINT_REGISTRY_URL = 'https://registry.cyanprint.dev';
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    try {
      const response = await GET(new Request('https://cyanprint.dev/logout'));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://cyanprint.dev/account');
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('POST logout requires same-origin submission', async () => {
    process.env.CYANPRINT_REGISTRY_URL = 'https://registry.cyanprint.dev';
    const response = await POST(
      new Request('https://cyanprint.dev/logout', {
        method: 'POST',
        headers: { origin: 'https://evil.example', cookie: 'cyanprint_session=cps_test' },
      }),
    );
    expect(response.status).toBe(403);
  });

  test('POST logout revokes and clears same-origin sessions', async () => {
    process.env.CYANPRINT_REGISTRY_URL = 'https://registry.cyanprint.dev';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://registry.cyanprint.dev/auth/logout');
      expect((init?.headers as Record<string, string>)['x-cyanprint-session']).toBe('cps_test');
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    try {
      const response = await POST(
        new Request('https://cyanprint.dev/logout', {
          method: 'POST',
          headers: { origin: 'https://cyanprint.dev', cookie: 'cyanprint_session=cps_test' },
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://cyanprint.dev/');
      expect(response.headers.get('set-cookie')).toContain('cyanprint_session=');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
