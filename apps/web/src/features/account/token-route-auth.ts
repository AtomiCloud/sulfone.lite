import { NextResponse } from 'next/server';

export function assertLocalProxyAuthorized(request: Request): void {
  const expected = process.env.CYANPRINT_WEB_LOCAL_TOKEN_PROXY_SECRET;
  if (!expected || request.headers.get('x-cyanprint-web-token-secret') !== expected) {
    throw new Error('Local token proxy requires x-cyanprint-web-token-secret.');
  }
}

export function tokenRouteError(error: unknown, fallback = 'Token request failed.') {
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status: 502 });
}
