const registryUrl = process.env.CYANPRINT_REGISTRY_URL;
const localDevSecret = process.env.CYANPRINT_LOCAL_DEV_SECRET;
const localTokenProxyEnabled = process.env.CYANPRINT_WEB_ENABLE_LOCAL_TOKEN_PROXY === '1';

export type AccountToken = {
  id: string;
  userId: string;
  name: string;
  revoked?: boolean;
};

export async function listTokens(): Promise<AccountToken[]> {
  const session = await createLocalSession();
  const response = await fetch(`${requiredRegistryUrl()}/tokens`, {
    headers: { 'x-cyanprint-session': session },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const body = (await response.json()) as { tokens: AccountToken[] };
  return body.tokens;
}

export async function mintToken(name: string): Promise<{ id: string; token: string }> {
  const session = await createLocalSession();
  const response = await fetch(`${requiredRegistryUrl()}/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cyanprint-session': session },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as { id: string; token: string };
}

export async function revokeToken(id: string): Promise<void> {
  const session = await createLocalSession();
  const response = await fetch(`${requiredRegistryUrl()}/tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-cyanprint-session': session },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function createLocalSession(): Promise<string> {
  if (!localDevSecret) {
    throw new Error('CYANPRINT_LOCAL_DEV_SECRET is required to manage tokens from the web UI.');
  }
  const response = await fetch(`${requiredRegistryUrl()}/auth/local-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cyanprint-dev-secret': localDevSecret },
    body: JSON.stringify({}),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const body = (await response.json()) as { session: string };
  return body.session;
}

function requiredRegistryUrl(): string {
  if (!localTokenProxyEnabled) {
    throw new Error('Set CYANPRINT_WEB_ENABLE_LOCAL_TOKEN_PROXY=1 to enable local token management.');
  }
  if (!registryUrl) {
    throw new Error('CYANPRINT_REGISTRY_URL is required to manage tokens from the web UI.');
  }
  if (!isLocalRegistryUrl(registryUrl)) {
    throw new Error('Local token management only supports localhost registry URLs.');
  }
  return registryUrl.replace(/\/$/, '');
}

export function isLocalRegistryUrl(value: string): boolean {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[(.*)]$/, '$1');
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}
