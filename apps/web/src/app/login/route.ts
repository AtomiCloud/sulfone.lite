import { NextResponse } from 'next/server';
import {
  createLocalDevSession,
  isLocalRegistryUrl,
  requiredRegistryUrl,
  sessionCookieName,
} from '../../features/account/token-service';
import { oauthNonceCookieName } from '../../features/account/auth-cookies';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const registryUrl = requiredRegistryUrl();
  if (process.env.CYANPRINT_LOCAL_DEV_SECRET && isLocalRegistryUrl(registryUrl)) {
    try {
      const { session } = await createLocalDevSession();
      const response = NextResponse.redirect(new URL('/account/tokens', url.origin));
      response.cookies.set(sessionCookieName, session, {
        httpOnly: true,
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
        sameSite: 'lax',
        secure: url.protocol === 'https:',
      });
      return response;
    } catch {
      return NextResponse.redirect(new URL('/account?error=local_login_failed', url.origin));
    }
  }
  const callback = new URL('/auth/callback', url.origin);
  const nonce = `cpon_${crypto.randomUUID().replaceAll('-', '')}`;
  callback.searchParams.set('nonce', nonce);
  const start = new URL('/auth/github/start', registryUrl);
  start.searchParams.set('return_to', callback.toString());
  const response = NextResponse.redirect(start);
  response.cookies.set(oauthNonceCookieName, nonce, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: '/auth/callback',
    sameSite: 'lax',
    secure: url.protocol === 'https:',
  });
  return response;
}
