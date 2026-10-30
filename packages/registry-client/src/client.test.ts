import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_BATCH_RESOLVE_REFS, type BatchResolveRequest, type ObjectRef } from '@cyanprint/contracts';
import { RegistryClient, registryClientOptionsFromEnv } from './client';

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

describe('registry client transfers', () => {
  const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  // Headers arrive at once; the body trickles in after `delay` ms.
  const slowBody = (delay: number, bytes: number[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          await later(delay);
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      }),
    );

  test('the short request timeout does not apply to a slow archive download body', async () => {
    const server = serve(() => slowBody(400, [1, 2, 3]));
    const client = new RegistryClient(server.url, undefined, undefined, {
      timeoutMs: 100,
      transferTimeoutMs: 5000,
      ...fast,
    });
    expect([...(await client.downloadObjectBytes(ref))]).toEqual([1, 2, 3]);
  });

  test('a download body that is cut off mid-read is retried', async () => {
    // Raw socket: promises 10 bytes, sends 3 and hangs up, which is what a dropped connection looks like.
    let connections = 0;
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket) {
          connections += 1;
          const head = 'HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\nconnection: close\r\n';
          if (connections < 2) {
            socket.write(`${head}content-length: 10\r\n\r\nabc`);
          } else {
            socket.write(`${head}content-length: 3\r\n\r\n\x01\x02\x03`);
          }
          socket.end();
        },
      },
    });
    servers.push(listener);
    const client = new RegistryClient(`http://127.0.0.1:${listener.port}`, undefined, undefined, fast);
    expect([...(await client.downloadObjectBytes(ref))]).toEqual([1, 2, 3]);
    expect(connections).toBe(2);
  });

  test('a slow upload is not cut off by the short request timeout', async () => {
    const server = serve(async () => {
      await later(400);
      return new Response('ok');
    });
    const client = new RegistryClient(server.url, undefined, undefined, {
      timeoutMs: 100,
      transferTimeoutMs: 5000,
      ...fast,
    });
    await client.putUploadObject('/upload/x', new Uint8Array([1, 2, 3]));
    expect(server.hits()).toBe(1);
  });

  test('timeout errors name the method and URL without leaking the query string', async () => {
    const server = serve(hang);
    const client = new RegistryClient(server.url, undefined, undefined, { timeoutMs: 50, retries: 0 });
    const error = await client.search({ query: 'secret-term' }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain('GET');
    expect(error?.message).toContain(`${server.url}/artifacts`);
    expect(error?.message).toContain('50ms');
    expect(error?.message).not.toContain('secret-term');
  });
});

describe('registry client error text', () => {
  test('a transfer timeout names the transfer variable, a JSON timeout names the JSON one', async () => {
    const server = serve(hang);
    const client = new RegistryClient(server.url, undefined, undefined, {
      timeoutMs: 40,
      transferTimeoutMs: 60,
      retries: 0,
    });
    const transfer = await client.downloadObjectBytes(ref).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(transfer?.message).toContain('60ms');
    expect(transfer?.message).toContain('CYANPRINT_REGISTRY_TRANSFER_TIMEOUT_MS');
    expect(transfer?.message).not.toContain('CYANPRINT_REGISTRY_TIMEOUT_MS');
    expect(transfer?.message).toContain('POST');
    const json = await client.health().then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(json?.message).toContain('40ms');
    expect(json?.message).toContain('CYANPRINT_REGISTRY_TIMEOUT_MS');
    expect(json?.message).not.toContain('TRANSFER');
  });

  test('network errors name the method and URL without the query string or a cause that holds it', async () => {
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);
    const client = new RegistryClient(`http://127.0.0.1:${port}`, undefined, undefined, { retries: 0 });
    const error = await client.putUploadObject('/upload/x?sig=topsecret', 'x').then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain('PUT');
    expect(error?.message).toContain(`http://127.0.0.1:${port}/upload/x`);
    expect(error?.message).not.toContain('topsecret');
    expect(error?.cause).toBeUndefined();
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('topsecret');
  });
});

describe('registryClientOptionsFromEnv', () => {
  test('reads CYANPRINT_REGISTRY_TRANSFER_TIMEOUT_MS with the same rules', () => {
    expect(registryClientOptionsFromEnv({ CYANPRINT_REGISTRY_TRANSFER_TIMEOUT_MS: '900000' })).toEqual({
      transferTimeoutMs: 900000,
    });
    expect(
      registryClientOptionsFromEnv({
        CYANPRINT_REGISTRY_TIMEOUT_MS: '5',
        CYANPRINT_REGISTRY_TRANSFER_TIMEOUT_MS: '6',
      }),
    ).toEqual({ timeoutMs: 5, transferTimeoutMs: 6 });
    expect(() => registryClientOptionsFromEnv({ CYANPRINT_REGISTRY_TRANSFER_TIMEOUT_MS: '-1' })).toThrow(
      'CYANPRINT_REGISTRY_TRANSFER_TIMEOUT_MS',
    );
  });

  test('reads CYANPRINT_REGISTRY_TIMEOUT_MS and rejects garbage', () => {
    expect(registryClientOptionsFromEnv({})).toEqual({});
    expect(registryClientOptionsFromEnv({ CYANPRINT_REGISTRY_TIMEOUT_MS: '120000' })).toEqual({ timeoutMs: 120000 });
    expect(() => registryClientOptionsFromEnv({ CYANPRINT_REGISTRY_TIMEOUT_MS: 'soon' })).toThrow(
      'CYANPRINT_REGISTRY_TIMEOUT_MS',
    );
    expect(() => registryClientOptionsFromEnv({ CYANPRINT_REGISTRY_TIMEOUT_MS: '0' })).toThrow(
      'CYANPRINT_REGISTRY_TIMEOUT_MS',
    );
  });
});

describe('registry client batchResolve chunking', () => {
  const refsOf = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ kind: 'template', owner: 'cyanprint', name: `n${index}` }));
  const isEven = (name: string) => Number(name.slice(1)) % 2 === 0;
  // Resolves every even-indexed ref and reports the odd ones as missing.
  const answer = async (request: Request) => {
    const { refs } = (await request.json()) as BatchResolveRequest;
    return Response.json({
      resolved: refs.filter(item => isEven(item.name)),
      missing: refs.filter(item => !isEven(item.name)),
    });
  };

  test('sends one request when refs fit the server cap', async () => {
    const server = serve(answer);
    await new RegistryClient(server.url, undefined, undefined, fast).batchResolve({
      refs: refsOf(MAX_BATCH_RESOLVE_REFS),
    });
    expect(server.hits()).toBe(1);
  });

  test('chunks larger sets and merges results in order', async () => {
    const sizes: number[] = [];
    const server = serve(async request => {
      sizes.push(((await request.clone().json()) as BatchResolveRequest).refs.length);
      return answer(request);
    });
    const total = MAX_BATCH_RESOLVE_REFS * 2 + 7;
    const result = await new RegistryClient(server.url, undefined, undefined, fast).batchResolve({
      refs: refsOf(total),
    });
    expect(sizes).toEqual([MAX_BATCH_RESOLVE_REFS, MAX_BATCH_RESOLVE_REFS, 7]);
    expect(result.resolved.map(item => item.name)).toEqual(
      refsOf(total)
        .map(item => item.name)
        .filter(isEven),
    );
    expect(result.missing.length + result.resolved.length).toBe(total);
  });

  test('retries a failing chunk independently and keeps results order-stable', async () => {
    const chunkHits = new Map<string, number>();
    const server = serve(async request => {
      const { refs } = (await request.clone().json()) as BatchResolveRequest;
      const first = refs[0]!.name;
      const seen = (chunkHits.get(first) ?? 0) + 1;
      chunkHits.set(first, seen);
      // The second chunk fails once with a 503, then succeeds.
      if (first === `n${MAX_BATCH_RESOLVE_REFS}` && seen === 1) {
        return new Response('unavailable', { status: 503 });
      }
      return answer(request);
    });
    const total = MAX_BATCH_RESOLVE_REFS * 2 + 7;
    const result = await new RegistryClient(server.url, undefined, undefined, fast).batchResolve({
      refs: refsOf(total),
    });
    expect(server.hits()).toBe(4);
    expect(chunkHits.get('n0')).toBe(1);
    expect(chunkHits.get(`n${MAX_BATCH_RESOLVE_REFS}`)).toBe(2);
    expect(chunkHits.get(`n${MAX_BATCH_RESOLVE_REFS * 2}`)).toBe(1);
    expect(result.resolved.map(item => item.name)).toEqual(
      refsOf(total)
        .map(item => item.name)
        .filter(isEven),
    );
  });
});
