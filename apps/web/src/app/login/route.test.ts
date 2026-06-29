import { afterEach, describe, expect, test } from 'bun:test';
import { GET } from './route';

const originalRegistryUrl = process.env.CYANPRINT_REGISTRY_URL;
const originalLocalSecret = process.env.CYANPRINT_LOCAL_DEV_SECRET;

afterEach(() => {
  restoreEnv('CYANPRINT_REGISTRY_URL', originalRegistryUrl);
  restoreEnv('CYANPRINT_LOCAL_DEV_SECRET', originalLocalSecret);
});

describe('web login route', () => {
  test('uses local dev sessions for local registry sign-in', async () => {
    process.env.CYANPRINT_REGISTRY_URL = 'http://127.0.0.1:8787';
    process.env.CYANPRINT_LOCAL_DEV_SECRET = 'cyanprint-local-dev';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8787/auth/local-session');
      expect((init?.headers as Record<string, string>)['x-cyanprint-dev-secret']).toBe('cyanprint-local-dev');
      expect(init?.body).toBe(JSON.stringify({ userId: 'user_local' }));
      return Response.json({ session: 'cps_local', user: { id: 'user_local', handle: 'local' } });
    }) as typeof fetch;
    try {
      const response = await GET(new Request('http://127.0.0.1:3000/login'));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('http://127.0.0.1:3000/account/tokens');
      expect(response.headers.get('set-cookie')).toContain('cyanprint_session=cps_local');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('uses GitHub OAuth for production registry sign-in', async () => {
    process.env.CYANPRINT_REGISTRY_URL = 'https://registry.cyanprint.dev';
    delete process.env.CYANPRINT_LOCAL_DEV_SECRET;
    const response = await GET(new Request('https://cyanprint.dev/login'));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin).toBe('https://registry.cyanprint.dev');
    expect(location.pathname).toBe('/auth/github/start');
    const returnTo = new URL(location.searchParams.get('return_to') ?? '');
    expect(returnTo.origin).toBe('https://cyanprint.dev');
    expect(returnTo.pathname).toBe('/auth/callback');
    expect(returnTo.searchParams.get('nonce')).toStartWith('cpon_');
    expect(response.headers.get('set-cookie')).toContain('cyanprint_oauth_nonce=cpon_');
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
