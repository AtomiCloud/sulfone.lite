import { afterEach, describe, expect, test } from 'bun:test';

type Header = { key: string; value: string };

const originalRegistryUrl = process.env.CYANPRINT_REGISTRY_URL;
const originalReleaseRegistryUrl = process.env.CYANPRINT_RELEASE_REGISTRY_URL;

afterEach(() => {
  restoreEnv('CYANPRINT_REGISTRY_URL', originalRegistryUrl);
  restoreEnv('CYANPRINT_RELEASE_REGISTRY_URL', originalReleaseRegistryUrl);
});

describe('web next config', () => {
  test('uses release registry env for CSP connect-src during deploy builds', async () => {
    delete process.env.CYANPRINT_REGISTRY_URL;
    process.env.CYANPRINT_RELEASE_REGISTRY_URL = 'https://registry.release.example';
    const csp = await loadCsp();
    expect(csp).toContain('connect-src');
    expect(csp).toContain('https://registry.release.example');
  });

  test('runtime registry env takes precedence over release registry env for CSP', async () => {
    process.env.CYANPRINT_REGISTRY_URL = 'https://registry.runtime.example';
    process.env.CYANPRINT_RELEASE_REGISTRY_URL = 'https://registry.release.example';
    const csp = await loadCsp();
    expect(csp).toContain('https://registry.runtime.example');
    expect(csp).not.toContain('https://registry.release.example');
  });
});

async function loadCsp(): Promise<string> {
  const config = (await import(`./next.config?test=${crypto.randomUUID()}`)).default;
  const headers = await config.headers?.();
  const csp = (headers?.[0]?.headers as Header[] | undefined)?.find(
    header => header.key === 'Content-Security-Policy',
  )?.value;
  if (!csp) {
    throw new Error('missing Content-Security-Policy header');
  }
  return csp;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
