import { NextResponse } from 'next/server';
import { assertLocalProxyAuthorized, tokenRouteError } from '../../../../features/account/token-route-auth';
import { revokeToken } from '../../../../features/account/token-service';

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertLocalProxyAuthorized(request);
    const { id } = await context.params;
    await revokeToken(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return tokenRouteError(error, 'Token revoke failed.');
  }
}
