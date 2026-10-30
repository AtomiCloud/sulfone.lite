import { afterEach, describe, expect, test } from 'bun:test';
import type { ObjectRef } from '@cyanprint/contracts';
import { RegistryClient } from './client';

type Handler = (request: Request, hit: number) => Response | Promise<Response>;

const servers: Array<{ stop: (force?: boolean) => unknown }> = [];

function serve(handler: Handler): { url: string; hits: () => number; paths: string[] } {
  let hits = 0;
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      hits += 1;
      paths.push(new URL(request.url).pathname + new URL(request.url).search);
      return handler(request, hits);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, hits: () => hits, paths };
}

const fast = { retryDelayMs: 1 };
const hang = () => new Promise<Response>(() => {});
const ref = { sha256: 'a'.repeat(64), size: 1 } as unknown as ObjectRef;

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe('registry client token paths', () => {
  test('revokeToken encodes the token id as one path segment', async () => {
    const server = serve(() => Response.json({ ok: true }));
    await new RegistryClient(server.url).revokeToken('a/b?x=1', 'session');
    expect(server.paths).toEqual(['/tokens/a%2Fb%3Fx%3D1']);
  });
});

describe('registry client timeout', () => {
  test('a hung registry rejects instead of waiting forever', async () => {
    const server = serve(hang);
    const client = new RegistryClient(server.url, undefined, undefined, { timeoutMs: 50, retries: 0 });
    const started = Date.now();
    await expect(client.health()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(server.hits()).toBe(1);
  });

  test('a hung non-idempotent call times out without retrying', async () => {
    const server = serve(hang);
    const client = new RegistryClient(server.url, undefined, undefined, { timeoutMs: 50, retries: 3, ...fast });
    await expect(client.publishArtifact({} as never)).rejects.toThrow();
    expect(server.hits()).toBe(1);
  });
});

describe('registry client retry', () => {
  test('GET retries 5xx and then succeeds', async () => {
    const server = serve((_request, hit) =>
      hit < 3 ? new Response('upstream down', { status: 503 }) : Response.json({ ok: true }),
    );
    const client = new RegistryClient(server.url, undefined, undefined, fast);
    expect(await client.health()).toEqual({ ok: true });
    expect(server.hits()).toBe(3);
  });

  test('GET retries 429', async () => {
    const server = serve((_request, hit) =>
      hit < 2 ? new Response('slow down', { status: 429 }) : Response.json({ ok: true }),
    );
    const client = new RegistryClient(server.url, undefined, undefined, fast);
    expect(await client.health()).toEqual({ ok: true });
    expect(server.hits()).toBe(2);
  });

  test('GET gives up after the retry budget and surfaces the last error', async () => {
    const server = serve(() => new Response('upstream down', { status: 503 }));
    const client = new RegistryClient(server.url, undefined, undefined, { retries: 2, ...fast });
    await expect(client.health()).rejects.toThrow('HTTP 503');
    expect(server.hits()).toBe(3);
  });

  test('GET does not retry a 404', async () => {
    const server = serve(() => Response.json({ error: 'missing' }, { status: 404 }));
    const client = new RegistryClient(server.url, undefined, undefined, fast);
    await expect(client.health()).rejects.toThrow('missing');
    expect(server.hits()).toBe(1);
  });

  test('GET retries after a timeout', async () => {
    const server = serve((_request, hit) => (hit < 2 ? hang() : Response.json({ ok: true })));
    const client = new RegistryClient(server.url, undefined, undefined, { timeoutMs: 100, ...fast });
    expect(await client.health()).toEqual({ ok: true });
    expect(server.hits()).toBe(2);
  });

  test('batchResolve is idempotent and retried', async () => {
    const server = serve((_request, hit) =>
      hit < 2 ? new Response('boom', { status: 500 }) : Response.json({ artifacts: [] }),
    );
    const client = new RegistryClient(server.url, undefined, undefined, fast);
    await client.batchResolve({} as never);
    expect(server.hits()).toBe(2);
  });

  test('downloadObjectBytes is retried', async () => {
    const server = serve((_request, hit) =>
      hit < 2 ? new Response('boom', { status: 502 }) : new Response(new Uint8Array([1, 2, 3])),
    );
    const client = new RegistryClient(server.url, undefined, undefined, fast);
    expect([...(await client.downloadObjectBytes(ref))]).toEqual([1, 2, 3]);
    expect(server.hits()).toBe(2);
  });

  test('publishArtifact is not retried', async () => {
    const server = serve(() => new Response('boom', { status: 503 }));
    const client = new RegistryClient(server.url, undefined, undefined, fast);
    await expect(client.publishArtifact({} as never)).rejects.toThrow('HTTP 503');
    expect(server.hits()).toBe(1);
  });
});
