import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import AccountPage from './page';

describe('account page auth errors', () => {
  test('shows local sign-in failures instead of silent signed-out state', async () => {
    const html = await renderHtml(AccountPage({ searchParams: Promise.resolve({ error: 'local_login_failed' }) }));
    expect(html).toContain('Local sign-in failed');
  });

  test('shows GitHub sign-in failures instead of silent signed-out state', async () => {
    const html = await renderHtml(AccountPage({ searchParams: Promise.resolve({ error: 'github_login_failed' }) }));
    expect(html).toContain('GitHub sign-in failed');
  });

  test('shows invalid OAuth nonce failures instead of silent signed-out state', async () => {
    const html = await renderHtml(AccountPage({ searchParams: Promise.resolve({ error: 'invalid_login_nonce' }) }));
    expect(html).toContain('Your sign-in link expired');
  });
});

async function renderHtml(element: ReturnType<typeof AccountPage>): Promise<string> {
  const stream = await renderToReadableStream(createElement('div', null, await element));
  return await new Response(stream).text();
}
