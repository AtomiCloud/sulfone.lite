import { NextResponse } from 'next/server';
import { requireSessionCookie, tokenRouteError } from '../../../features/account/token-route-auth';
import { updateCurrentUser } from '../../../features/account/token-service';

export async function PATCH(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { handle?: string };
    return NextResponse.json({ user: await updateCurrentUser(requireSessionCookie(request), body.handle ?? '') });
  } catch (error) {
    return tokenRouteError(error);
  }
}
