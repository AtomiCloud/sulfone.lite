import { describe, expect, test } from 'bun:test';
import { isSameOriginRequest, requireSameOrigin, requireSessionCookie, tokenRouteError } from './token-route-auth';

describe('token route session auth', () => {
  test('reads the httpOnly registry session cookie', () => {
    const request = new Request('https://cyanprint.dev/api/tokens', {
      headers: { cookie: 'theme=dark; cyanprint_session=cps_test; other=value' },
    });
    expect(requireSessionCookie(request)).toBe('cps_test');
  });

  test('rejects token management without a session cookie', () => {
    const request = new Request('https://cyanprint.dev/api/tokens');
    expect(() => requireSessionCookie(request)).toThrow('Sign in with GitHub');
  });

  test('maps missing session errors to 401 without matching message text', async () => {
    const request = new Request('https://cyanprint.dev/api/tokens');
    let error: unknown;
    try {
      requireSessionCookie(request);
    } catch (caught) {
      error = caught;
    }
    const response = tokenRouteError(error);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Sign in with GitHub to manage API tokens.' });
  });

  test('accepts mutations from the same origin or referer', () => {
    const withOrigin = new Request('https://cyanprint.dev/api/tokens', {
      method: 'POST',
      headers: { origin: 'https://cyanprint.dev' },
    });
    expect(isSameOriginRequest(withOrigin)).toBe(true);
    expect(() => requireSameOrigin(withOrigin)).not.toThrow();

    const withReferer = new Request('https://cyanprint.dev/api/tokens', {
      method: 'POST',
      headers: { referer: 'https://cyanprint.dev/account/tokens' },
    });
    expect(isSameOriginRequest(withReferer)).toBe(true);
  });

  test('rejects cross-origin and origin-less mutations with 403', () => {
    const crossOrigin = new Request('https://cyanprint.dev/api/tokens', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(isSameOriginRequest(crossOrigin)).toBe(false);
    let error: unknown;
    try {
      requireSameOrigin(crossOrigin);
    } catch (caught) {
      error = caught;
    }
    const response = tokenRouteError(error);
    expect(response.status).toBe(403);

    const bare = new Request('https://cyanprint.dev/api/tokens', { method: 'POST' });
    expect(isSameOriginRequest(bare)).toBe(false);

    const badReferer = new Request('https://cyanprint.dev/api/tokens', {
      method: 'POST',
      headers: { referer: 'not-a-url' },
    });
    expect(isSameOriginRequest(badReferer)).toBe(false);
  });
});
