import { NextResponse } from 'next/server';
import { readCookie } from '@cyanprint/registry-client';
import { oauthNonceCookieName } from '../../../features/account/auth-cookies';
import { consumeGitHubHandoff, sessionCookieName } from '../../../features/account/token-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const handoff = url.searchParams.get('handoff');
  const nonce = url.searchParams.get('nonce');
  const expectedNonce = readCookie(request.headers.get('cookie'), oauthNonceCookieName);
  if (!nonce || !expectedNonce || nonce !== expectedNonce) {
    return clearOAuthNonce(NextResponse.redirect(new URL('/account?error=invalid_login_nonce', url.origin)), url);
  }
  if (!handoff) {
    const error = url.searchParams.get('error') ?? 'missing_handoff';
    return clearOAuthNonce(
      NextResponse.redirect(new URL(`/account?error=${encodeURIComponent(error)}`, url.origin)),
      url,
    );
  }
  try {
    const { session } = await consumeGitHubHandoff(handoff);
    const response = NextResponse.redirect(new URL('/account/tokens', url.origin));
    response.cookies.set(sessionCookieName, session, {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
      sameSite: 'lax',
      secure: url.protocol === 'https:',
    });
    return clearOAuthNonce(response, url);
  } catch {
    return clearOAuthNonce(NextResponse.redirect(new URL('/account?error=github_login_failed', url.origin)), url);
  }
}

function clearOAuthNonce(response: NextResponse, url: URL): NextResponse {
  response.cookies.set(oauthNonceCookieName, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/auth/callback',
    sameSite: 'lax',
    secure: url.protocol === 'https:',
  });
  return response;
}
