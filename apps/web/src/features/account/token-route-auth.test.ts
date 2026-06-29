import { describe, expect, test } from 'bun:test';
import { requireSessionCookie, tokenRouteError } from './token-route-auth';

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
});
