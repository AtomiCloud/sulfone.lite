import { NextResponse } from 'next/server';
import { requireSameOrigin, requireSessionCookie, tokenRouteError } from '../../../features/account/token-route-auth';
import { listTokens, mintToken } from '../../../features/account/token-service';

export async function GET(request: Request) {
  try {
    return NextResponse.json({ tokens: await listTokens(requireSessionCookie(request)) });
  } catch (error) {
    return tokenRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = (await request.json().catch(() => ({}))) as { name?: string };
    return NextResponse.json(await mintToken(requireSessionCookie(request), body.name?.trim() || 'default'));
  } catch (error) {
    return tokenRouteError(error);
  }
}
