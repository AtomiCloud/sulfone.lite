import { NextResponse } from 'next/server';
import { requireSessionCookie, tokenRouteError } from '../../../../features/account/token-route-auth';
import { revokeToken } from '../../../../features/account/token-service';

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await revokeToken(requireSessionCookie(request), id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return tokenRouteError(error, 'Token revoke failed.');
  }
}
