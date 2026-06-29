import { NextResponse } from 'next/server';
import { assertLocalProxyAuthorized, tokenRouteError } from '../../../features/account/token-route-auth';
import { listTokens, mintToken } from '../../../features/account/token-service';

export async function GET(request: Request) {
  try {
    assertLocalProxyAuthorized(request);
    return NextResponse.json({ tokens: await listTokens() });
  } catch (error) {
    return tokenRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLocalProxyAuthorized(request);
    const body = (await request.json().catch(() => ({}))) as { name?: string };
    return NextResponse.json(await mintToken(body.name?.trim() || 'local'));
  } catch (error) {
    return tokenRouteError(error);
  }
}
