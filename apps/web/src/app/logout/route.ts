import { NextResponse } from 'next/server';
import { readCookie } from '@cyanprint/registry-client';
import { isSameOriginRequest } from '../../features/account/token-route-auth';
import { revokeSession, sessionCookieName } from '../../features/account/token-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return NextResponse.redirect(new URL('/account', request.url));
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'Invalid logout request.' }, { status: 403 });
  }
  const session = readCookie(request.headers.get('cookie') ?? '', sessionCookieName);
  if (session) {
    await revokeSession(session).catch(() => undefined);
  }
  const response = NextResponse.redirect(new URL('/', request.url), { status: 303 });
  response.cookies.set(sessionCookieName, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'lax',
    secure: new URL(request.url).protocol === 'https:',
  });
  return response;
}
