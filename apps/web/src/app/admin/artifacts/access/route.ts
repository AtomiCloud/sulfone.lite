import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const expected = process.env.CYANPRINT_WEB_ADMIN_SECRET;
  const form = await request.formData().catch(() => undefined);
  const secret = form?.get('adminSecret');
  const redirectTo = typeof form?.get('redirectTo') === 'string' ? String(form.get('redirectTo')) : '/admin/artifacts';
  const response = NextResponse.redirect(new URL(safeRedirectPath(redirectTo), request.url), { status: 303 });
  if (expected && secret === expected) {
    response.cookies.set('cyanprint-admin-secret', expected, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
  }
  return response;
}

function safeRedirectPath(path: string): string {
  return path.startsWith('/admin/artifacts') ? path : '/admin/artifacts';
}
