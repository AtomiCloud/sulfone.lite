import { NextResponse } from 'next/server';
import { readCookie } from '@cyanprint/registry-client';
import { sessionCookieName } from './token-service';

export class RouteHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function requireSessionCookie(request: Request): string {
  const session = readCookie(request.headers.get('cookie') ?? '', sessionCookieName);
  if (!session) {
    throw new RouteHttpError('Sign in with GitHub to manage API tokens.', 401);
  }
  return session;
}

export function tokenRouteError(error: unknown, fallback = 'Token request failed.') {
  const message = error instanceof Error ? error.message : fallback;
  const explicitStatus =
    typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;
  const status = explicitStatus ?? 502;
  return NextResponse.json({ error: message }, { status });
}
