export { cyanprintSessionCookieName as sessionCookieName } from '@cyanprint/registry-client';

export type AccountUser = {
  id: string;
  handle: string | null;
  login?: string;
  admin?: boolean;
};

export type AccountToken = {
  id: string;
  userId: string;
  name: string;
  revoked?: boolean;
};

export async function getCurrentUser(session: string): Promise<AccountUser | undefined> {
  const response = await fetch(`${requiredRegistryUrl()}/me`, {
    headers: { 'x-cyanprint-session': session },
    cache: 'no-store',
  });
  if (response.status === 401) {
    return undefined;
  }
  if (!response.ok) {
    await throwRegistryError(response, 'Unable to load account.');
  }
  const body = (await response.json()) as { user: AccountUser };
  return body.user;
}

export async function listTokens(session: string): Promise<AccountToken[]> {
  const response = await fetch(`${requiredRegistryUrl()}/tokens`, {
    headers: { 'x-cyanprint-session': session },
    cache: 'no-store',
  });
  if (!response.ok) {
    await throwRegistryError(response, 'Unable to list API tokens.');
  }
  const body = (await response.json()) as { tokens: AccountToken[] };
  return body.tokens;
}

export async function updateCurrentUser(session: string, handle: string): Promise<AccountUser> {
  const response = await fetch(`${requiredRegistryUrl()}/me`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-cyanprint-session': session },
    body: JSON.stringify({ handle }),
    cache: 'no-store',
  });
  if (!response.ok) {
    await throwRegistryError(response, 'Unable to update username.');
  }
  const body = (await response.json()) as { user: AccountUser };
  return body.user;
}

export async function mintToken(session: string, name: string): Promise<{ id: string; token: string }> {
  const response = await fetch(`${requiredRegistryUrl()}/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cyanprint-session': session },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    await throwRegistryError(response, 'Unable to mint API token.');
  }
  return (await response.json()) as { id: string; token: string };
}

export async function revokeToken(session: string, id: string): Promise<void> {
  const response = await fetch(`${requiredRegistryUrl()}/tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-cyanprint-session': session },
  });
  if (!response.ok) {
    await throwRegistryError(response, 'Unable to revoke API token.');
  }
}

export async function consumeGitHubHandoff(handoff: string): Promise<{ session: string; user: AccountUser }> {
  const response = await fetch(`${requiredRegistryUrl()}/auth/github/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handoff }),
    cache: 'no-store',
  });
  if (!response.ok) {
    await throwRegistryError(response, 'Unable to complete GitHub sign-in.');
  }
  return (await response.json()) as { session: string; user: AccountUser };
}

export async function createLocalDevSession(userId = 'user_local'): Promise<{ session: string; user: AccountUser }> {
  const secret = process.env.CYANPRINT_LOCAL_DEV_SECRET;
  if (!secret || !isLocalRegistryUrl(requiredRegistryUrl())) {
    throw new Error('Local web sign-in is only available with a local registry and CYANPRINT_LOCAL_DEV_SECRET.');
  }
  const response = await fetch(`${requiredRegistryUrl()}/auth/local-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cyanprint-dev-secret': secret },
    body: JSON.stringify({ userId }),
    cache: 'no-store',
  });
  if (!response.ok) {
    await throwRegistryError(response, 'Unable to create local dev session.');
  }
  return (await response.json()) as { session: string; user: AccountUser };
}

export async function revokeSession(session: string): Promise<void> {
  await fetch(`${requiredRegistryUrl()}/auth/logout`, {
    method: 'POST',
    headers: { 'x-cyanprint-session': session },
    cache: 'no-store',
  });
}

export function requiredRegistryUrl(): string {
  const registryUrl = process.env.CYANPRINT_REGISTRY_URL;
  if (!registryUrl) {
    throw new Error('CYANPRINT_REGISTRY_URL is required for account management.');
  }
  return registryUrl.replace(/\/$/, '');
}

export function isLocalRegistryUrl(registryUrl: string): boolean {
  const hostname = new URL(registryUrl).hostname.replace(/^\[(.*)\]$/, '$1');
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

async function throwRegistryError(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  const error = new Error(body.message ?? fallback);
  Object.assign(error, { status: response.status });
  throw error;
}
