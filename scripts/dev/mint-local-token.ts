const registry = (process.env.CYANPRINT_REGISTRY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const localSecret = process.env.CYANPRINT_LOCAL_DEV_SECRET ?? 'cyanprint-local-dev';
const userId = process.env.CYANPRINT_USER_ID ?? 'user_local';
const tokenName = process.env.CYANPRINT_TOKEN_NAME ?? 'local-dev';

async function postJson<T>(path: string, body: unknown, headers: HeadersInit = {}): Promise<T> {
  const response = await fetch(`${registry}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as T;
}

try {
  const session = await postJson<{ session: string }>(
    '/auth/local-session',
    { userId },
    { 'x-cyanprint-dev-secret': localSecret },
  );
  const token = await postJson<{ id: string; token: string }>(
    '/tokens',
    { name: tokenName },
    { 'x-cyanprint-session': session.session },
  );

  console.log(`CYANPRINT_TOKEN=${token.token}`);
  console.log(`export CYANPRINT_TOKEN=${token.token}`);
  console.log(`registry=${registry}`);
  console.log(`token_id=${token.id}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Unable to mint local token: ${message}`);
  console.error('Start the local registry first with: pls dev');
  process.exit(1);
}

export {};
