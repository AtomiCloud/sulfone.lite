import { beforeEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readdir } from 'node:fs/promises';
import { sha256 } from '@cyanprint/core';
import { artifactIntegrity, artifactVersionId } from '@cyanprint/contracts';
import { seedArtifacts, seedObjectPayloads } from '@cyanprint/registry-client';
import { createApp, storageForEnv } from './index';
import { createCloudflareBindingStorage, type WorkerBindings } from './storage/cloudflare-binding-storage';
import { createCloudflareLocalStorage } from './storage/cloudflare-local-storage';

let app: ReturnType<typeof createApp>;
const testEnv = {
  CYANPRINT_ENABLE_LOCAL_AUTH: '1',
  CYANPRINT_ENABLE_REGISTRY_SEEDS: '1',
  CYANPRINT_LOCAL_DEV_SECRET: 'cyanprint-local-dev',
};
const githubOAuthEnv = {
  CYANPRINT_GITHUB_CLIENT_ID: 'github-client',
  CYANPRINT_GITHUB_CLIENT_SECRET: 'github-secret',
  CYANPRINT_GITHUB_ADMIN_LOGINS: 'octouser',
  CYANPRINT_AUTH_RETURN_ORIGINS: 'https://cyanprint.dev',
  CYANPRINT_WEB_URL: 'https://cyanprint.dev',
};

beforeEach(() => {
  app = createApp(createCloudflareLocalStorage(seedArtifacts, seedObjectPayloads));
});

async function localSession(userId = 'user_local'): Promise<string> {
  const response = await app.request(
    '/auth/local-session',
    {
      method: 'POST',
      headers: { 'x-cyanprint-dev-secret': 'cyanprint-local-dev' },
      body: JSON.stringify({ userId }),
    },
    testEnv,
  );
  return ((await response.json()) as { session: string }).session;
}

async function localToken(
  name: string,
  userId = 'user_local',
): Promise<{ id: string; token: string; session: string }> {
  const session = await localSession(userId);
  const response = await app.request('/tokens', {
    method: 'POST',
    headers: { 'x-cyanprint-session': session },
    body: JSON.stringify({ name }),
  });
  const token = (await response.json()) as { id: string; token: string };
  return { ...token, session };
}

async function githubSession(env: WorkerBindings): Promise<string> {
  const start = await app.request(
    '/auth/github/start?return_to=https%3A%2F%2Fcyanprint.dev%2Fauth%2Fcallback',
    {},
    env,
  );
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location') ?? '');
  const callback = await app.request(
    `/auth/github/callback?code=oauth-code&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`,
    {},
    env,
  );
  expect(callback.status).toBe(302);
  const returned = new URL(callback.headers.get('location') ?? '');
  const handoff = returned.searchParams.get('handoff') ?? '';
  const consumed = await app.request(
    '/auth/github/consume',
    {
      method: 'POST',
      body: JSON.stringify({ handoff }),
    },
    env,
  );
  expect(consumed.status).toBe(200);
  return ((await consumed.json()) as { session: string }).session;
}

async function withMockGitHubOAuth<T>(fn: (env: WorkerBindings) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'gho_test' });
    }
    if (url === 'https://api.github.com/user') {
      return Response.json({ id: 12345, login: 'OctoUser' });
    }
    return originalFetch(input);
  }) as typeof fetch;
  try {
    return await fn(githubOAuthEnv);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function uploadObject(
  token: string,
  name: string,
  owner = 'cyanprint',
  variant?: string,
): Promise<{
  bucket: string;
  key: string;
  sha256: string;
  size: number;
}> {
  const payload = JSON.stringify({
    cyanprint: 4,
    files: [
      {
        path: 'cyan.yaml',
        content: `cyanprint: 4\nkind: template\nowner: ${owner}\nname: ${name}\nbundledEntry: cyan.ts\n`,
      },
      {
        path: 'cyan.ts',
        content: `export default async () => ({ metadata: ${JSON.stringify(variant ?? '')} });\n`,
      },
    ],
  });
  const object = {
    bucket: 'cyanprint-local-r2',
    key: `template/${owner}/${name}/${sha256(payload)}.cyanpkg.json`,
    sha256: sha256(payload),
    size: byteLength(payload),
  };
  const upload = await app.request('/objects', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ ref: object, payload }),
  });
  expect(upload.status).toBe(201);
  return object;
}

function artifactId(kind: string, owner: string, name: string, version: string): string {
  return artifactVersionId(kind, owner, name, version);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function uploadUrl(urls: Record<string, string>, part: string): string {
  const url = urls[part];
  if (!url) {
    throw new Error(`missing upload url: ${part}`);
  }
  return url;
}

async function putUploadPart(
  urls: Record<string, string>,
  part: string,
  token: string,
  body: BodyInit,
): Promise<Response> {
  return await app.request(uploadUrl(urls, part), {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body,
  });
}

async function createTestCloudflareBindings(
  options: { seed?: boolean } = {},
): Promise<WorkerBindings & { close(): void }> {
  const db = new Database(':memory:');
  const migrationDir = 'apps/worker/migrations';
  const migrationFiles = (await readdir(migrationDir)).filter(file => file.endsWith('.sql')).sort();
  for (const file of migrationFiles) {
    for (const statement of (await Bun.file(`${migrationDir}/${file}`).text()).split(';')) {
      if (statement.trim()) {
        db.run(statement);
      }
    }
  }
  const kv = new Map<string, string>();
  const r2 = new Map<string, Uint8Array>();
  const bindings: WorkerBindings & { close(): void } = {
    DB: {
      prepare(sql: string) {
        return createD1Statement(db, sql);
      },
    },
    R2: {
      async get(key: string) {
        const value = r2.get(key);
        return value
          ? {
              async text() {
                return new TextDecoder().decode(value);
              },
              async arrayBuffer() {
                return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
              },
            }
          : null;
      },
      async put(key: string, value: string | Uint8Array) {
        r2.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
      },
    },
    KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    },
    close() {
      db.close();
    },
  };
  if (options.seed ?? true) {
    bindings.CYANPRINT_ENABLE_REGISTRY_SEEDS = '1';
  }
  return bindings;
}

function createD1Statement(db: Database, sql: string) {
  let bindings: SQLQueryBindings[] = [];
  return {
    bind(...values: SQLQueryBindings[]) {
      bindings = values;
      return this;
    },
    async first<T = Record<string, unknown>>(): Promise<T | null> {
      return (db.query(sql).get(...bindings) as T | null) ?? null;
    },
    async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
      return { results: db.query(sql).all(...bindings) as T[] };
    },
    async run(): Promise<unknown> {
      const result = db.query(sql).run(...bindings);
      return { meta: { changes: result.changes } };
    },
  };
}

describe('tokens user profile session admin permission artifact registry batch resolve pin validation problem responses secret redaction', () => {
  test('health and token flow work without deployed Cloudflare', async () => {
    const health = await app.request('/health');
    expect(health.status).toBe(200);
    const anonymousMe = await app.request('/me');
    expect(anonymousMe.status).toBe(401);
    const disabledLocalSession = await app.request('/auth/local-session', {
      method: 'POST',
      headers: { 'x-cyanprint-dev-secret': 'cyanprint-local-dev' },
      body: JSON.stringify({ userId: 'user_local' }),
    });
    expect(disabledLocalSession.status).toBe(401);
    const anonymous = await app.request('/tokens', { method: 'POST', body: JSON.stringify({ name: 'test' }) });
    expect(anonymous.status).toBe(401);
    const session = await localSession();
    const me = await app.request('/me', { headers: { 'x-cyanprint-session': session } });
    expect(me.status).toBe(200);
    const token = await app.request('/tokens', {
      method: 'POST',
      headers: { 'x-cyanprint-session': session },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(token.status).toBe(200);
    const list = await app.request('/tokens', { headers: { 'x-cyanprint-session': session } });
    expect(await list.text()).not.toContain('secretHash');
  });

  test('GitHub OAuth creates a registry session through a one-time handoff', async () => {
    await withMockGitHubOAuth(async env => {
      const start = await app.request(
        '/auth/github/start?return_to=https%3A%2F%2Fcyanprint.dev%2Fauth%2Fcallback',
        {},
        env,
      );
      expect(start.status).toBe(302);
      const authorize = new URL(start.headers.get('location') ?? '');
      expect(authorize.hostname).toBe('github.com');
      expect(authorize.searchParams.get('client_id')).toBe('github-client');

      const callback = await app.request(
        `/auth/github/callback?code=oauth-code&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`,
        {},
        env,
      );
      expect(callback.status).toBe(302);
      const returned = new URL(callback.headers.get('location') ?? '');
      expect(returned.origin).toBe('https://cyanprint.dev');
      const handoff = returned.searchParams.get('handoff') ?? '';
      expect(handoff.startsWith('cph_')).toBe(true);

      const consumed = await app.request(
        '/auth/github/consume',
        {
          method: 'POST',
          body: JSON.stringify({ handoff }),
        },
        env,
      );
      expect(consumed.status).toBe(200);
      const session = ((await consumed.json()) as { session: string }).session;
      const me = await app.request('/me', { headers: { 'x-cyanprint-session': session } }, env);
      expect(await me.json()).toEqual({
        user: { id: 'github:12345', handle: null, login: 'octouser', admin: true },
      });
      const tokenResponse = await app.request('/tokens', {
        method: 'POST',
        headers: { 'x-cyanprint-session': session },
        body: JSON.stringify({ name: 'github-admin' }),
      });
      const token = ((await tokenResponse.json()) as { token: string }).token;
      const demotedAdmin = await app.request('/admin/artifacts', { headers: { authorization: `Bearer ${token}` } });
      expect(demotedAdmin.status).toBe(403);
      const stillAdmin = await app.request('/admin/artifacts', { headers: { authorization: `Bearer ${token}` } }, env);
      expect(stillAdmin.status).toBe(200);
      const logout = await app.request('/auth/logout', { method: 'POST', headers: { 'x-cyanprint-session': session } });
      expect(logout.status).toBe(200);
      const afterLogout = await app.request('/me', { headers: { 'x-cyanprint-session': session } });
      expect(afterLogout.status).toBe(401);
      const replay = await app.request('/auth/github/consume', {
        method: 'POST',
        body: JSON.stringify({ handoff }),
      });
      expect(replay.status).toBe(401);
    });
  });

  test('GitHub users choose a CyanPrint handle once and it survives re-login', async () => {
    await withMockGitHubOAuth(async env => {
      const firstSession = await githubSession(env);
      const chosen = await app.request(
        '/me',
        {
          method: 'PATCH',
          headers: { 'x-cyanprint-session': firstSession },
          body: JSON.stringify({ handle: 'cyan-admin' }),
        },
        env,
      );
      expect(chosen.status).toBe(200);
      expect(await chosen.json()).toEqual({
        user: { id: 'github:12345', handle: 'cyan-admin', login: 'octouser', admin: true },
      });

      const rename = await app.request(
        '/me',
        {
          method: 'PATCH',
          headers: { 'x-cyanprint-session': firstSession },
          body: JSON.stringify({ handle: 'cyan-rename' }),
        },
        env,
      );
      expect(rename.status).toBe(409);
      expect(await rename.json()).toMatchObject({ code: 'handle_immutable' });

      const tokenResponse = await app.request('/tokens', {
        method: 'POST',
        headers: { 'x-cyanprint-session': firstSession },
        body: JSON.stringify({ name: 'renamed-admin' }),
      });
      const token = ((await tokenResponse.json()) as { token: string }).token;
      const admin = await app.request('/admin/artifacts', { headers: { authorization: `Bearer ${token}` } }, env);
      expect(admin.status).toBe(200);

      const secondSession = await githubSession(env);
      const me = await app.request('/me', { headers: { 'x-cyanprint-session': secondSession } }, env);
      expect(await me.json()).toEqual({
        user: { id: 'github:12345', handle: 'cyan-admin', login: 'octouser', admin: true },
      });
    });
  });

  test('profile handles are validated, unique, and immutable once set', async () => {
    const memberSession = await localSession('user_member');
    const invalid = await app.request('/me', {
      method: 'PATCH',
      headers: { 'x-cyanprint-session': memberSession },
      body: JSON.stringify({ handle: 'no' }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'invalid_handle' });

    const alreadySet = await app.request('/me', {
      method: 'PATCH',
      headers: { 'x-cyanprint-session': memberSession },
      body: JSON.stringify({ handle: 'member-renamed' }),
    });
    expect(alreadySet.status).toBe(409);
    expect(await alreadySet.json()).toMatchObject({ code: 'handle_immutable' });

    await withMockGitHubOAuth(async env => {
      const session = await githubSession(env);
      const duplicate = await app.request(
        '/me',
        {
          method: 'PATCH',
          headers: { 'x-cyanprint-session': session },
          body: JSON.stringify({ handle: 'local' }),
        },
        env,
      );
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ code: 'handle_taken' });

      const stillUnset = await app.request('/me', { headers: { 'x-cyanprint-session': session } }, env);
      expect(await stillUnset.json()).toMatchObject({ user: { handle: null } });
    });
  });

  test('publishing is blocked until a GitHub user chooses a handle', async () => {
    await withMockGitHubOAuth(async () => {
      const env = { ...githubOAuthEnv, CYANPRINT_GITHUB_ADMIN_LOGINS: '' };
      const session = await githubSession(env);
      const tokenResponse = await app.request(
        '/tokens',
        {
          method: 'POST',
          headers: { 'x-cyanprint-session': session },
          body: JSON.stringify({ name: 'handle-gate' }),
        },
        env,
      );
      const token = ((await tokenResponse.json()) as { token: string }).token;
      const manifest = 'cyanprint: 4\nkind: template\nowner: octo-owner\nname: gated\nbundledEntry: cyan.ts\n';
      const bundle = 'export default async () => ({});\n';
      const startBody = JSON.stringify({
        kind: 'template',
        owner: 'octo-owner',
        name: 'gated',
        objects: {
          manifest: { sha256: sha256(manifest), size: byteLength(manifest) },
          bundle: { sha256: sha256(bundle), size: byteLength(bundle) },
        },
      });

      const blocked = await app.request(
        '/uploads/start',
        { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: startBody },
        env,
      );
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({ code: 'owner_required' });

      const chosen = await app.request(
        '/me',
        {
          method: 'PATCH',
          headers: { 'x-cyanprint-session': session },
          body: JSON.stringify({ handle: 'octo-owner' }),
        },
        env,
      );
      expect(chosen.status).toBe(200);

      const allowed = await app.request(
        '/uploads/start',
        { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: startBody },
        env,
      );
      expect(allowed.status).toBe(200);
    });
  });

  test('listing users requires an admin API token', async () => {
    const anonymous = await app.request('/users');
    expect(anonymous.status).toBe(403);

    const memberSession = await localSession('user_member');
    const sessionOnly = await app.request('/users', { headers: { 'x-cyanprint-session': memberSession } });
    expect(sessionOnly.status).toBe(403);

    const memberToken = (await localToken('member-users', 'user_member')).token;
    const nonAdmin = await app.request('/users', { headers: { authorization: `Bearer ${memberToken}` } });
    expect(nonAdmin.status).toBe(403);

    const adminToken = (await localToken('admin-users')).token;
    const admin = await app.request('/users', { headers: { authorization: `Bearer ${adminToken}` } });
    expect(admin.status).toBe(200);
    const body = (await admin.json()) as { users: Array<{ id: string }> };
    expect(body.users.some(user => user.id === 'user_member')).toBe(true);
  });

  test('D1-backed profile handles are set exactly once and reject duplicates', async () => {
    const bindings = await createTestCloudflareBindings();
    try {
      const storage = createCloudflareBindingStorage(bindings);
      await storage.upsertUser({ id: 'user_a', handle: null, admin: false });
      await storage.upsertUser({ id: 'user_b', handle: 'publisher-b', admin: false });
      await storage.createSession('user_a', 'cps_d1_a');
      const d1App = createApp(storage);

      const duplicate = await d1App.request(
        '/me',
        {
          method: 'PATCH',
          headers: { 'x-cyanprint-session': 'cps_d1_a' },
          body: JSON.stringify({ handle: 'publisher-b' }),
        },
        bindings,
      );
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ code: 'handle_taken' });
      expect(await storage.getUser('user_a')).toMatchObject({ handle: null });

      const chosen = await d1App.request(
        '/me',
        {
          method: 'PATCH',
          headers: { 'x-cyanprint-session': 'cps_d1_a' },
          body: JSON.stringify({ handle: 'publisher-a' }),
        },
        bindings,
      );
      expect(chosen.status).toBe(200);
      expect(await chosen.json()).toMatchObject({ user: { handle: 'publisher-a' } });

      const rename = await d1App.request(
        '/me',
        {
          method: 'PATCH',
          headers: { 'x-cyanprint-session': 'cps_d1_a' },
          body: JSON.stringify({ handle: 'publisher-c' }),
        },
        bindings,
      );
      expect(rename.status).toBe(409);
      expect(await rename.json()).toMatchObject({ code: 'handle_immutable' });
      expect(await storage.getUser('user_a')).toMatchObject({ handle: 'publisher-a' });
    } finally {
      bindings.close();
    }
  });

  test('upload sessions validate parts and finalize with server-assigned versions', async () => {
    const token = (await localToken('upload-flow')).token;
    const manifest = 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: upload-flow\nbundledEntry: cyan.ts\n';
    const bundle = 'export default async () => ({ metadata: "# Uploaded" });\n';
    const archive = JSON.stringify({
      cyanArchive: 1,
      files: [
        { path: 'cyan.yaml', bytesBase64: Buffer.from(manifest).toString('base64') },
        { path: 'cyan.ts', bytesBase64: Buffer.from(bundle).toString('base64') },
      ],
    });

    const malformedStart = await app.request('/uploads/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'malformed-upload',
        objects: {
          manifest: { sha256: sha256(manifest), size: byteLength(manifest) },
          bundle: { sha256: sha256(bundle) },
        },
      }),
    });
    expect(malformedStart.status).toBe(400);
    expect(await malformedStart.json()).toMatchObject({ code: 'invalid_upload_part' });

    const malformedHashStart = await app.request('/uploads/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'malformed-hash-upload',
        objects: {
          manifest: { sha256: 'not-a-sha256', size: byteLength(manifest) },
          bundle: { sha256: sha256(bundle), size: byteLength(bundle) },
        },
      }),
    });
    expect(malformedHashStart.status).toBe(400);
    expect(await malformedHashStart.json()).toMatchObject({ code: 'invalid_upload_part' });

    const malformedSizeStart = await app.request('/uploads/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'malformed-size-upload',
        objects: {
          manifest: { sha256: sha256(manifest), size: -1 },
          bundle: { sha256: sha256(bundle), size: byteLength(bundle) },
        },
      }),
    });
    expect(malformedSizeStart.status).toBe(400);
    expect(await malformedSizeStart.json()).toMatchObject({ code: 'invalid_upload_part' });

    const missingArchiveStart = await app.request('/uploads/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'script-required',
        objects: {
          manifest: { sha256: sha256(manifest), size: byteLength(manifest) },
          bundle: { sha256: sha256(bundle), size: byteLength(bundle) },
        },
      }),
    });
    const missingArchive = (await missingArchiveStart.json()) as { uploadId: string; urls: Record<string, string> };
    await putUploadPart(missingArchive.urls, 'manifest', token, manifest);
    await putUploadPart(missingArchive.urls, 'bundle', token, bundle);
    const missingArchiveFinalize = await app.request('/uploads/finalize', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        uploadId: missingArchive.uploadId,
        artifact: {
          kind: 'template',
          owner: 'cyanprint',
          name: 'script-required',
          readme: '',
          dependencies: [],
          resolvedPins: [],
        },
      }),
    });
    expect(missingArchiveFinalize.status).toBe(400);
    expect(await missingArchiveFinalize.json()).toMatchObject({ code: 'invalid_artifact_package' });

    const invalidArchive = JSON.stringify({
      cyanArchive: 1,
      files: [{ path: '../evil.txt', bytesBase64: Buffer.from('bad').toString('base64') }],
    });
    const invalidArchiveStart = await app.request('/uploads/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'invalid-archive',
        objects: {
          manifest: {
            sha256: sha256(
              'cyanprint: 4\nkind: template\nowner: cyanprint\nname: invalid-archive\nbundledEntry: cyan.ts\n',
            ),
            size: byteLength(
              'cyanprint: 4\nkind: template\nowner: cyanprint\nname: invalid-archive\nbundledEntry: cyan.ts\n',
            ),
          },
          bundle: { sha256: sha256(bundle), size: byteLength(bundle) },
          archive: { sha256: sha256(invalidArchive), size: byteLength(invalidArchive) },
        },
      }),
    });
    const invalidArchiveUpload = (await invalidArchiveStart.json()) as {
      uploadId: string;
      urls: Record<string, string>;
    };
    const invalidArchiveManifest =
      'cyanprint: 4\nkind: template\nowner: cyanprint\nname: invalid-archive\nbundledEntry: cyan.ts\n';
    await putUploadPart(invalidArchiveUpload.urls, 'manifest', token, invalidArchiveManifest);
    await putUploadPart(invalidArchiveUpload.urls, 'bundle', token, bundle);
    await putUploadPart(invalidArchiveUpload.urls, 'archive', token, invalidArchive);
    const invalidArchiveFinalize = await app.request('/uploads/finalize', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        uploadId: invalidArchiveUpload.uploadId,
        artifact: {
          kind: 'template',
          owner: 'cyanprint',
          name: 'invalid-archive',
          readme: '# Invalid Archive',
          dependencies: [],
          resolvedPins: [],
        },
      }),
    });
    expect(invalidArchiveFinalize.status).toBe(400);
    expect(await invalidArchiveFinalize.json()).toMatchObject({ code: 'invalid_artifact_package' });

    const corruptZstd = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    const corruptZstdStart = await app.request('/uploads/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'corrupt-zstd',
        objects: {
          manifest: {
            sha256: sha256(
              'cyanprint: 4\nkind: template\nowner: cyanprint\nname: corrupt-zstd\nbundledEntry: cyan.ts\n',
            ),
            size: byteLength(
              'cyanprint: 4\nkind: template\nowner: cyanprint\nname: corrupt-zstd\nbundledEntry: cyan.ts\n',
            ),
          },
          bundle: { sha256: sha256(bundle), size: byteLength(bundle) },
          archive: { sha256: sha256(corruptZstd), size: corruptZstd.byteLength },
        },
      }),
    });
    const corruptZstdUpload = (await corruptZstdStart.json()) as {
      uploadId: string;
      urls: Record<string, string>;
    };
    const corruptZstdManifest =
      'cyanprint: 4\nkind: template\nowner: cyanprint\nname: corrupt-zstd\nbundledEntry: cyan.ts\n';
    await putUploadPart(corruptZstdUpload.urls, 'manifest', token, corruptZstdManifest);
    await putUploadPart(corruptZstdUpload.urls, 'bundle', token, bundle);
    await putUploadPart(corruptZstdUpload.urls, 'archive', token, corruptZstd);
    const corruptZstdFinalize = await app.request('/uploads/finalize', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        uploadId: corruptZstdUpload.uploadId,
        artifact: {
          kind: 'template',
          owner: 'cyanprint',
          name: 'corrupt-zstd',
          readme: '',
          dependencies: [],
          resolvedPins: [],
        },
      }),
    });
    expect(corruptZstdFinalize.status).toBe(400);
    expect(await corruptZstdFinalize.json()).toMatchObject({ code: 'invalid_artifact_package' });

    const start = await app.request('/uploads/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'upload-flow',
        objects: {
          manifest: { sha256: sha256(manifest), size: byteLength(manifest) },
          bundle: { sha256: sha256(bundle), size: byteLength(bundle) },
          archive: { sha256: sha256(archive), size: byteLength(archive) },
        },
      }),
    });
    const upload = (await start.json()) as { uploadId: string; urls: Record<string, string> };
    const unauthenticatedBundle = await app.request(uploadUrl(upload.urls, 'bundle'), { method: 'PUT', body: bundle });
    expect(unauthenticatedBundle.status).toBe(401);
    const badBundle = await putUploadPart(upload.urls, 'bundle', token, 'wrong');
    expect(badBundle.status).toBe(400);
    await putUploadPart(upload.urls, 'manifest', token, manifest);
    await putUploadPart(upload.urls, 'bundle', token, bundle);
    await putUploadPart(upload.urls, 'archive', token, archive);

    const identityMismatch = await app.request('/uploads/finalize', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        uploadId: upload.uploadId,
        artifact: {
          kind: 'template',
          owner: 'cyanprint',
          name: 'wrong-name',
          readme: '',
          dependencies: [],
          resolvedPins: [],
        },
      }),
    });
    expect(identityMismatch.status).toBe(400);
    expect(await identityMismatch.json()).toMatchObject({ code: 'upload_identity_mismatch' });

    const finalized = await app.request('/uploads/finalize', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        uploadId: upload.uploadId,
        artifact: {
          kind: 'template',
          owner: 'cyanprint',
          name: 'upload-flow',
          readme: '# Upload Flow',
          dependencies: [],
          resolvedPins: [],
        },
      }),
    });
    expect(finalized.status).toBe(201);
    const body = (await finalized.json()) as { artifact: { version: string; artifactObjects?: unknown } };
    expect(body.artifact.version).toBe('1');
    expect(body.artifact.artifactObjects).toBeTruthy();

    const emptyReadmeManifest =
      'cyanprint: 4\nkind: template\nowner: cyanprint\nname: empty-readme-upload\nbundledEntry: cyan.ts\n';
    const emptyReadmeArchive = JSON.stringify({
      cyanArchive: 1,
      files: [
        { path: 'cyan.yaml', bytesBase64: Buffer.from(emptyReadmeManifest).toString('base64') },
        { path: 'cyan.ts', bytesBase64: Buffer.from(bundle).toString('base64') },
      ],
    });
    const emptyReadmeStart = await app.request('/uploads/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'empty-readme-upload',
        objects: {
          manifest: { sha256: sha256(emptyReadmeManifest), size: byteLength(emptyReadmeManifest) },
          readme: { sha256: sha256(''), size: 0 },
          bundle: { sha256: sha256(bundle), size: byteLength(bundle) },
          archive: { sha256: sha256(emptyReadmeArchive), size: byteLength(emptyReadmeArchive) },
        },
      }),
    });
    const emptyReadmeUpload = (await emptyReadmeStart.json()) as { uploadId: string; urls: Record<string, string> };
    await putUploadPart(emptyReadmeUpload.urls, 'manifest', token, emptyReadmeManifest);
    await putUploadPart(emptyReadmeUpload.urls, 'readme', token, '');
    await putUploadPart(emptyReadmeUpload.urls, 'bundle', token, bundle);
    await putUploadPart(emptyReadmeUpload.urls, 'archive', token, emptyReadmeArchive);

    const emptyReadmeFinalized = await app.request('/uploads/finalize', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        uploadId: emptyReadmeUpload.uploadId,
        artifact: {
          kind: 'template',
          owner: 'cyanprint',
          name: 'empty-readme-upload',
          readme: '',
          dependencies: [],
          resolvedPins: [],
        },
      }),
    });
    expect(emptyReadmeFinalized.status).toBe(201);
  });

  test('upload finalize uses the authenticated session object instead of a supplied object ref', async () => {
    const token = (await localToken('upload-object-ref')).token;
    const spoofed = await uploadObject(token, 'spoof-source');
    const manifest =
      'cyanprint: 4\nkind: template\nowner: cyanprint\nname: canonical-session-object\nbundledEntry: cyan.ts\n';
    const bundle = 'export default async () => ({ metadata: "# Canonical" });\n';
    const archive = JSON.stringify({
      cyanArchive: 1,
      files: [
        { path: 'cyan.yaml', bytesBase64: Buffer.from(manifest).toString('base64') },
        { path: 'cyan.ts', bytesBase64: Buffer.from(bundle).toString('base64') },
      ],
    });

    const start = await app.request('/uploads/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'canonical-session-object',
        objects: {
          manifest: { sha256: sha256(manifest), size: byteLength(manifest) },
          bundle: { sha256: sha256(bundle), size: byteLength(bundle) },
          archive: { sha256: sha256(archive), size: byteLength(archive) },
        },
      }),
    });
    const upload = (await start.json()) as { uploadId: string; urls: Record<string, string> };
    await putUploadPart(upload.urls, 'manifest', token, manifest);
    await putUploadPart(upload.urls, 'bundle', token, bundle);
    await putUploadPart(upload.urls, 'archive', token, archive);

    const finalized = await app.request('/uploads/finalize', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        uploadId: upload.uploadId,
        artifact: {
          kind: 'template',
          owner: 'cyanprint',
          name: 'canonical-session-object',
          readme: '# Canonical',
          dependencies: [],
          resolvedPins: [],
          object: spoofed,
        },
      }),
    });

    expect(finalized.status).toBe(201);
    const body = (await finalized.json()) as {
      artifact: { object: { key: string }; artifactObjects: { archive: { key: string } } };
    };
    expect(body.artifact.object.key).toBe(body.artifact.artifactObjects.archive.key);
    expect(body.artifact.object.key).not.toBe(spoofed.key);
  });

  test('partial Cloudflare bindings fail fast instead of falling back to memory', () => {
    expect(() => storageForEnv({ DB: {} as never })).toThrow('requires DB, R2, and KV bindings together');
  });

  test('publish mutation requires token and validates integrity', async () => {
    const rejected = await app.request('/artifacts', {
      method: 'POST',
      body: JSON.stringify({
        id: 'bad',
        kind: 'template',
        owner: 'x',
        name: 'x',
        version: '1',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(rejected.status).toBe(401);

    const tokenBody = await localToken('publisher');
    const token = tokenBody.token;
    const payload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: tokened\nbundledEntry: cyan.ts\n',
        },
        { path: 'cyan.ts', content: 'export default async () => ({});\n' },
      ],
    });
    const object = {
      bucket: 'cyanprint-local-r2',
      key: `template/cyanprint/tokened/${sha256(payload)}.cyanpkg.json`,
      sha256: sha256(payload),
      size: byteLength(payload),
    };
    const upload = await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: object, payload }),
    });
    expect(upload.status).toBe(201);
    const accepted = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'tokened',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(accepted.status).toBe(201);

    const revoked = await app.request(`/tokens/${tokenBody.id}`, {
      method: 'DELETE',
      headers: { 'x-cyanprint-session': tokenBody.session },
    });
    expect(revoked.status).toBe(200);
    const tokensAfterRevoke = await app.request('/tokens', { headers: { 'x-cyanprint-session': tokenBody.session } });
    const listedTokens = (
      (await tokensAfterRevoke.json()) as {
        tokens: Array<{ id: string; userId: string; name: string; revoked: boolean }>;
      }
    ).tokens.filter(item => item.id === tokenBody.id);
    expect(listedTokens).toEqual([{ id: tokenBody.id, userId: 'user_local', name: 'publisher', revoked: true }]);
    const rejectedAfterRevoke = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'revoked',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(rejectedAfterRevoke.status).toBe(401);
  });

  test('publish rejects dependency metadata whose versions differ from cyan.yaml', async () => {
    const token = (await localToken('dependency-version')).token;
    const hello = seedArtifacts.find(
      artifact =>
        artifact.kind === 'template' &&
        artifact.owner === 'cyanprint' &&
        artifact.name === 'hello' &&
        artifact.version === '4',
    );
    expect(hello).toBeDefined();
    const payload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: [
            'cyanprint: 4',
            'kind: template',
            'owner: cyanprint',
            'name: dependency-version',
            'bundledEntry: cyan.ts',
            'templates:',
            '  - cyanprint/hello@4',
            '',
          ].join('\n'),
        },
        { path: 'cyan.ts', content: 'export default async () => ({});\n' },
      ],
    });
    const object = {
      bucket: 'cyanprint-local-r2',
      key: `template/cyanprint/dependency-version/${sha256(payload)}.cyanpkg.json`,
      sha256: sha256(payload),
      size: byteLength(payload),
    };
    const upload = await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: object, payload }),
    });
    expect(upload.status).toBe(201);
    const rejected = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'dependency-version',
        readme: '',
        dependencies: [{ kind: 'template', owner: 'cyanprint', name: 'hello', version: '5' }],
        resolvedPins: [
          { kind: 'template', owner: 'cyanprint', name: 'hello', version: '4', integrity: artifactIntegrity(hello!) },
        ],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'invalid_artifact_package' });

    const undeclaredPinPayload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: undeclared-pin\nbundledEntry: cyan.ts\n',
        },
        { path: 'cyan.ts', content: 'export default async () => ({});\n' },
      ],
    });
    const undeclaredPinObject = {
      bucket: 'cyanprint-local-r2',
      key: `template/cyanprint/undeclared-pin/${sha256(undeclaredPinPayload)}.cyanpkg.json`,
      sha256: sha256(undeclaredPinPayload),
      size: byteLength(undeclaredPinPayload),
    };
    const undeclaredUpload = await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: undeclaredPinObject, payload: undeclaredPinPayload }),
    });
    expect(undeclaredUpload.status).toBe(201);
    const undeclaredPin = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'undeclared-pin',
        readme: '',
        dependencies: [],
        resolvedPins: [
          { kind: 'template', owner: 'cyanprint', name: 'hello', version: '4', integrity: artifactIntegrity(hello!) },
        ],
        object: undeclaredPinObject,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(undeclaredPin.status).toBe(400);
    expect(await undeclaredPin.json()).toMatchObject({ code: 'invalid_artifact_package' });
  });

  test('batch resolve is deterministic', async () => {
    const malformed = await app.request('/batch-resolve', {
      method: 'POST',
      body: JSON.stringify({ refs: 'template:cyanprint/hello' }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ category: 'validation', code: 'invalid_batch_resolve' });
    const malformedRef = await app.request('/batch-resolve', {
      method: 'POST',
      body: JSON.stringify({ refs: [null] }),
    });
    expect(malformedRef.status).toBe(400);
    expect(await malformedRef.json()).toMatchObject({ category: 'validation', code: 'invalid_batch_resolve' });

    const response = await app.request('/batch-resolve', {
      method: 'POST',
      body: JSON.stringify({ refs: [{ kind: 'template', owner: 'cyanprint', name: 'hello' }] }),
    });
    const body = (await response.json()) as { resolved: unknown[] };
    expect(body.resolved.length).toBe(1);
  });

  test('batch resolve chooses latest unversioned artifact deterministically', async () => {
    const token = (await localToken('latest-publisher')).token;
    for (const version of ['first', 'second']) {
      const object = await uploadObject(token, 'latest-test', 'cyanprint', version);
      const accepted = await app.request('/artifacts', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          kind: 'template',
          owner: 'cyanprint',
          name: 'latest-test',
          readme: '',
          dependencies: [],
          resolvedPins: [],
          object,
          disabled: false,
          moderationState: 'active',
          downloads: 0,
          likes: 0,
        }),
      });
      expect(accepted.status).toBe(201);
    }

    const response = await app.request('/batch-resolve', {
      method: 'POST',
      body: JSON.stringify({ refs: [{ kind: 'template', owner: 'cyanprint', name: 'latest-test' }] }),
    });
    const body = (await response.json()) as { resolved: Array<{ version: string }> };
    expect(body.resolved[0]?.version).toBe('2');
  });

  test('publish assigns the next integer version in storage', async () => {
    const token = (await localToken('assigned-version')).token;
    const object = await uploadObject(token, 'assigned-version');
    const accepted = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'assigned-version',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(accepted.status).toBe(201);
    const body = (await accepted.json()) as { artifact: { id: string; version: string } };
    expect(body.artifact.version).toBe('1');
    expect(body.artifact.id).toBe(artifactId('template', 'cyanprint', 'assigned-version', '1'));
  });

  test('admin permission protects moderation routes', async () => {
    const memberToken = (await localToken('member-admin-test', 'user_member')).token;
    const rejected = await app.request(
      `/admin/artifacts/${artifactId('template', 'cyanprint', 'hello', '4')}/disable`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${memberToken}` },
      },
    );
    expect(rejected.status).toBe(403);

    const token = (await localToken('admin-test')).token;
    const disabled = await app.request(
      `/admin/artifacts/${artifactId('template', 'cyanprint', 'hello', '4')}/disable`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(disabled.status).toBe(200);
    const listed = await app.request('/artifacts?kind=template');
    const artifacts = ((await listed.json()) as { artifacts: Array<{ id: string }> }).artifacts;
    expect(artifacts.some(artifact => artifact.id === artifactId('template', 'cyanprint', 'hello', '4'))).toBe(false);
    const liked = await app.request(`/artifacts/${artifactId('template', 'cyanprint', 'hello', '4')}/like`, {
      method: 'POST',
      headers: { 'x-cyanprint-session': await localSession() },
    });
    expect(liked.status).toBe(404);

    const missing = await app.request('/admin/artifacts/template__cyanprint__missing__4/disable', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);
  });

  test('artifact search filters by query and paginates at the registry boundary', async () => {
    const first = await app.request('/artifacts?kind=template&q=cyanprint&limit=2');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      artifacts: Array<{ kind: string; name: string }>;
      nextCursor?: string;
    };
    expect(firstBody.artifacts).toHaveLength(2);
    expect(firstBody.artifacts.every(artifact => artifact.kind === 'template')).toBe(true);
    expect(firstBody.nextCursor).toBeString();
    expect(firstBody.nextCursor).not.toBe('2');

    const second = await app.request(
      `/artifacts?kind=template&q=cyanprint&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      artifacts: Array<{ name: string }>;
      nextCursor?: string;
    };
    expect(secondBody.artifacts.length).toBeGreaterThan(0);
    expect(secondBody.artifacts.map(artifact => artifact.name)).not.toEqual(
      firstBody.artifacts.map(artifact => artifact.name),
    );

    const resolver = await app.request('/artifacts?q=keep-user&limit=5');
    const resolverBody = (await resolver.json()) as { artifacts: Array<{ kind: string; name: string }> };
    expect(resolverBody.artifacts).toEqual([expect.objectContaining({ kind: 'resolver', name: 'keep-user' })]);

    const latest = await app.request('/artifacts/latest?kind=template&q=hello&limit=5');
    expect(latest.status).toBe(200);
    const latestBody = (await latest.json()) as { artifacts: Array<{ name: string; version: string }> };
    expect(latestBody.artifacts).toEqual([expect.objectContaining({ name: 'hello', version: '4' })]);

    const exact = await app.request('/artifacts/template/cyanprint/hello');
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ artifact: { kind: 'template', owner: 'cyanprint', name: 'hello' } });

    const versions = await app.request('/artifacts/template/cyanprint/hello/versions');
    expect(versions.status).toBe(200);
    const versionsBody = (await versions.json()) as { artifacts: Array<{ name: string; version: string }> };
    expect(versionsBody.artifacts).toEqual([expect.objectContaining({ name: 'hello', version: '4' })]);

    const adminToken = (await localToken('admin-search')).token;
    const adminList = await app.request('/admin/artifacts?limit=2', {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminList.status).toBe(200);
    const adminBody = (await adminList.json()) as {
      artifacts: Array<{ moderationState: string }>;
      nextCursor?: string;
    };
    expect(adminBody.artifacts).toHaveLength(2);
    expect(adminBody.nextCursor).toBeString();
  });

  test('latest artifacts choose the newest eligible version after active filters', async () => {
    const storage = createCloudflareLocalStorage();
    const older = seedArtifacts.find(artifact => artifact.id === artifactId('template', 'cyanprint', 'hello', '4'));
    if (!older) {
      throw new Error('missing hello seed artifact');
    }
    storage.addArtifact(older);
    storage.addArtifact({
      ...older,
      id: artifactId('template', 'cyanprint', 'hello', '5'),
      version: '5',
      disabled: true,
      moderationState: 'disabled',
      readme: `${older.readme}\n\nnewer disabled`,
    });
    const latestApp = createApp(storage);
    const response = await latestApp.request('/artifacts/latest?kind=template&q=hello');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { artifacts: Array<{ name: string; version: string }> };
    expect(body.artifacts).toEqual([expect.objectContaining({ name: 'hello', version: '4' })]);
  });

  test('D1-backed artifact search latest exact lookup and pagination match registry semantics', async () => {
    const bindings = await createTestCloudflareBindings();
    try {
      const storage = createCloudflareBindingStorage(bindings);
      const d1App = createApp(storage);
      const first = await d1App.request('/artifacts?kind=template&q=cyanprint&limit=2', {}, bindings);
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        artifacts: Array<{ kind: string; name: string }>;
        nextCursor?: string;
      };
      expect(firstBody.artifacts).toHaveLength(2);
      expect(firstBody.artifacts.every(artifact => artifact.kind === 'template')).toBe(true);
      expect(firstBody.nextCursor).toBeString();
      expect(firstBody.nextCursor).not.toBe('2');

      const second = await d1App.request(
        `/artifacts?kind=template&q=cyanprint&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
        {},
        bindings,
      );
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { artifacts: Array<{ name: string }> };
      expect(secondBody.artifacts.map(artifact => artifact.name)).not.toEqual(
        firstBody.artifacts.map(artifact => artifact.name),
      );

      const hello = seedArtifacts.find(artifact => artifact.id === artifactId('template', 'cyanprint', 'hello', '4'));
      if (!hello) {
        throw new Error('missing hello seed artifact');
      }
      await storage.addArtifact({
        ...hello,
        id: artifactId('template', 'cyanprint', 'hello', '5'),
        version: '5',
        disabled: true,
        moderationState: 'disabled',
        readme: `${hello.readme}\n\nnewer disabled`,
      });

      const latest = await d1App.request('/artifacts/latest?kind=template&q=hello', {}, bindings);
      expect(latest.status).toBe(200);
      const latestBody = (await latest.json()) as { artifacts: Array<{ name: string; version: string }> };
      expect(latestBody.artifacts).toEqual([expect.objectContaining({ name: 'hello', version: '4' })]);

      const exact = await d1App.request('/artifacts/template/cyanprint/hello', {}, bindings);
      expect(exact.status).toBe(200);
      expect(await exact.json()).toMatchObject({ artifact: { kind: 'template', owner: 'cyanprint', name: 'hello' } });

      const reordered = await d1App.request('/artifacts?kind=template&q=template%20hello', {}, bindings);
      expect(reordered.status).toBe(200);
      const reorderedBody = (await reordered.json()) as { artifacts: Array<{ name: string }> };
      expect(reorderedBody.artifacts).toEqual([expect.objectContaining({ name: 'hello' })]);

      const adminToken = 'cp4_d1_admin';
      await storage.createToken({
        id: 'token_d1_admin',
        userId: 'user_local',
        name: 'd1-admin',
        secretHash: sha256(adminToken),
        revoked: false,
      });
      const adminList = await d1App.request(
        '/admin/artifacts?kind=template&q=disabled',
        {
          headers: { authorization: `Bearer ${adminToken}` },
        },
        bindings,
      );
      expect(adminList.status).toBe(200);
      const adminBody = (await adminList.json()) as { artifacts: Array<{ moderationState: string; version: string }> };
      expect(adminBody.artifacts).toEqual([expect.objectContaining({ moderationState: 'disabled', version: '5' })]);
    } finally {
      bindings.close();
    }
  });

  test('D1-backed production storage does not seed local users or fixture artifacts by default', async () => {
    const bindings = await createTestCloudflareBindings({ seed: false });
    try {
      const storage = createCloudflareBindingStorage(bindings);
      const productionApp = createApp(storage);

      const health = await productionApp.request('/health', {}, bindings);
      expect(health.status).toBe(200);

      const artifacts = await productionApp.request('/artifacts', {}, bindings);
      expect(artifacts.status).toBe(200);
      expect(await artifacts.json()).toMatchObject({ artifacts: [] });
      expect(await storage.getUser('user_local')).toBeUndefined();
    } finally {
      bindings.close();
    }
  });

  test('owner permission rejects non-admin publishes for other owners', async () => {
    const token = (await localToken('member-publish', 'user_member')).token;
    const rejected = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'wrong-owner',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(rejected.status).toBe(403);
  });

  test('non-admin owners publish a new version after a prior version is moderated', async () => {
    const memberToken = (await localToken('member-lock', 'user_member')).token;
    const object = await uploadObject(memberToken, 'locked', 'member');
    const published = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'member',
        name: 'locked',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(published.status).toBe(201);
    const publishedBody = (await published.json()) as { artifact: { id: string } };

    const adminToken = (await localToken('admin-lock')).token;
    const disabled = await app.request(`/admin/artifacts/${publishedBody.artifact.id}/disable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(disabled.status).toBe(200);

    const republished = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'member',
        name: 'locked',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(republished.status).toBe(201);
    const republishedBody = (await republished.json()) as { artifact: { version: string } };
    expect(republishedBody.artifact.version).toBe('2');
  });

  test('pin validation rejects malformed payloads, missing objects, and wrong pin integrity', async () => {
    const token = (await localToken('validation')).token;
    const malformedObject = await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{',
    });
    expect(malformedObject.status).toBe(400);
    const malformedObjectRef = await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: {}, payload: '' }),
    });
    expect(malformedObjectRef.status).toBe(400);
    const malformedDownload = await app.request('/objects/download', {
      method: 'POST',
      body: '{',
    });
    expect(malformedDownload.status).toBe(400);

    const malformed = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: 'bad' }),
    });
    expect(malformed.status).toBe(400);

    const missingObject = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'missing-object',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object: { bucket: 'cyanprint-local-r2', key: 'missing', sha256: 'abc123abc123abc123', size: 5 },
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(missingObject.status).toBe(400);

    const wrongPinObject = await uploadObject(token, 'wrong-pin');
    const wrongPin = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'wrong-pin',
        readme: '',
        dependencies: [],
        resolvedPins: [
          { kind: 'template', owner: 'cyanprint', name: 'hello', version: '4', integrity: 'wrong-integrity' },
        ],
        object: wrongPinObject,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(wrongPin.status).toBe(400);
  });

  test('likes and downloads update artifact counters', async () => {
    const session = await localSession();
    const liked = await app.request(`/artifacts/${artifactId('plugin', 'cyanprint', 'footer', '4')}/like`, {
      method: 'POST',
      headers: { 'x-cyanprint-session': session },
    });
    expect(liked.status).toBe(200);
    expect(((await liked.json()) as { artifact: { likes: number } }).artifact.likes).toBeGreaterThan(0);

    const token = (await localToken('download-counter')).token;
    const payload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: counted\nbundledEntry: cyan.ts\n',
        },
        { path: 'cyan.ts', content: 'export default async () => ({});\n' },
      ],
    });
    const object = {
      bucket: 'cyanprint-local-r2',
      key: `template/cyanprint/counted/${sha256(payload)}.cyanpkg.json`,
      sha256: sha256(payload),
      size: byteLength(payload),
    };
    await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: object, payload }),
    });
    const published = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'counted',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    const publishedBody = (await published.json()) as { artifact: { id: string } };
    const downloaded = await app.request('/objects/download', {
      method: 'POST',
      body: JSON.stringify({ ref: object }),
    });
    expect(downloaded.status).toBe(200);
    const listed = await app.request('/artifacts?kind=template');
    const artifact = ((await listed.json()) as { artifacts: Array<{ id: string; downloads: number }> }).artifacts.find(
      item => item.id === publishedBody.artifact.id,
    );
    expect(artifact?.downloads).toBe(1);
  });

  test('folder-first artifact object downloads count once per artifact hydration', async () => {
    const hello = seedArtifacts.find(artifact => artifact.id === artifactId('template', 'cyanprint', 'hello', '4'));
    expect(hello?.artifactObjects?.manifest).toBeDefined();
    expect(hello?.artifactObjects?.bundle).toBeDefined();
    expect(hello?.artifactObjects?.archive).toBeDefined();

    const manifest = await app.request('/objects/download', {
      method: 'POST',
      headers: { accept: 'application/octet-stream' },
      body: JSON.stringify({ ref: hello?.artifactObjects?.manifest }),
    });
    expect(manifest.status).toBe(200);

    const bundle = await app.request('/objects/download', {
      method: 'POST',
      headers: { accept: 'application/octet-stream' },
      body: JSON.stringify({ ref: hello?.artifactObjects?.bundle }),
    });
    expect(bundle.status).toBe(200);

    const archive = await app.request('/objects/download', {
      method: 'POST',
      headers: { accept: 'application/octet-stream' },
      body: JSON.stringify({ ref: hello?.artifactObjects?.archive }),
    });
    expect(archive.status).toBe(200);

    const listed = await app.request('/artifacts/latest?kind=template&q=hello');
    const artifact = ((await listed.json()) as { artifacts: Array<{ id: string; downloads: number }> }).artifacts.find(
      item => item.id === hello?.id,
    );
    expect(artifact?.downloads).toBe((hello?.downloads ?? 0) + 1);
  });

  test('published objects are immutable by content ref', async () => {
    const token = (await localToken('object-immutability')).token;
    const firstPayload = 'first payload';
    const secondPayload = 'second payload';
    const firstObject = {
      bucket: 'cyanprint-local-r2',
      key: 'templates/immutable.cyanpkg.json',
      sha256: sha256(firstPayload),
      size: byteLength(firstPayload),
    };
    const secondObject = {
      ...firstObject,
      sha256: sha256(secondPayload),
      size: byteLength(secondPayload),
    };

    const firstUpload = await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: firstObject, payload: firstPayload }),
    });
    expect(firstUpload.status).toBe(201);

    const duplicateUpload = await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: firstObject, payload: firstPayload }),
    });
    expect(duplicateUpload.status).toBe(409);

    const secondUpload = await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: secondObject, payload: secondPayload }),
    });
    expect(secondUpload.status).toBe(201);

    const firstDownload = await app.request('/objects/download', {
      method: 'POST',
      body: JSON.stringify({ ref: firstObject }),
    });
    expect(firstDownload.status).toBe(404);
  });

  test('publish does not trust client-provided counters', async () => {
    const token = (await localToken('counter-reset')).token;
    const object = await uploadObject(token, 'fake-counters');
    const accepted = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'fake-counters',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 999,
        likes: 999,
      }),
    });
    expect(accepted.status).toBe(201);
    const body = (await accepted.json()) as { artifact: { downloads: number; likes: number } };
    expect(body.artifact.downloads).toBe(0);
    expect(body.artifact.likes).toBe(0);
  });

  test('publish rejects ids that do not match canonical version identity', async () => {
    const token = (await localToken('canonical-id')).token;
    const object = await uploadObject(token, 'canonical-id');
    const rejected = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: 'template_cyanprint_canonical_id_999',
        kind: 'template',
        owner: 'cyanprint',
        name: 'canonical-id',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'invalid_artifact_payload' });
  });

  test('publish rejects object keys that do not match artifact identity', async () => {
    const token = (await localToken('object-key')).token;
    const object = await uploadObject(token, 'other-name');
    const rejected = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'object-key',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'invalid_object_key' });
  });

  test('publish rejects packages whose cyan.yaml identity does not match metadata', async () => {
    const token = (await localToken('package-identity')).token;
    const payload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: different\nbundledEntry: cyan.ts\n',
        },
        { path: 'cyan.ts', content: 'export default async () => ({});\n' },
      ],
    });
    const object = {
      bucket: 'cyanprint-local-r2',
      key: `template/cyanprint/package-identity/${sha256(payload)}.cyanpkg.json`,
      sha256: sha256(payload),
      size: byteLength(payload),
    };
    const upload = await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: object, payload }),
    });
    expect(upload.status).toBe(201);
    const rejected = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'package-identity',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'invalid_artifact_package' });
  });

  test('publish rejects packages with unsafe file paths', async () => {
    const token = (await localToken('package-paths')).token;
    const payload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: package-paths\nbundledEntry: cyan.ts\n',
        },
        { path: '../escape.txt', content: 'bad' },
      ],
    });
    const object = {
      bucket: 'cyanprint-local-r2',
      key: `template/cyanprint/package-paths/${sha256(payload)}.cyanpkg.json`,
      sha256: sha256(payload),
      size: byteLength(payload),
    };
    const upload = await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: object, payload }),
    });
    expect(upload.status).toBe(201);
    const rejected = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'package-paths',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'invalid_artifact_package' });
  });

  test('publish rejects packages with duplicate file paths', async () => {
    const token = (await localToken('package-duplicates')).token;
    const payload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: package-duplicates\nbundledEntry: cyan.ts\n',
        },
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: spoof\nbundledEntry: cyan.ts\n',
        },
        { path: 'cyan.ts', content: 'export default async () => ({});\n' },
      ],
    });
    const object = {
      bucket: 'cyanprint-local-r2',
      key: `template/cyanprint/package-duplicates/${sha256(payload)}.cyanpkg.json`,
      sha256: sha256(payload),
      size: byteLength(payload),
    };
    const upload = await app.request('/objects', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: object, payload }),
    });
    expect(upload.status).toBe(201);
    const rejected = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'package-duplicates',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'invalid_artifact_package' });
  });

  test('disabled artifact objects are not downloadable', async () => {
    const token = (await localToken('disabled-download')).token;
    const object = await uploadObject(token, 'disabled-download');
    const published = await app.request('/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: 'template',
        owner: 'cyanprint',
        name: 'disabled-download',
        readme: '',
        dependencies: [],
        resolvedPins: [],
        object,
        disabled: false,
        moderationState: 'active',
        downloads: 0,
        likes: 0,
      }),
    });
    expect(published.status).toBe(201);
    const publishedBody = (await published.json()) as { artifact: { id: string } };
    const adminToken = (await localToken('disable-download')).token;
    const disabled = await app.request(`/admin/artifacts/${publishedBody.artifact.id}/disable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(disabled.status).toBe(200);
    const downloaded = await app.request('/objects/download', {
      method: 'POST',
      body: JSON.stringify({ ref: object }),
    });
    expect(downloaded.status).toBe(404);
    expect(await downloaded.json()).toMatchObject({ code: 'object_not_published' });
  });

  test('seed artifacts are isolated between local storage instances', async () => {
    const firstStorage = createCloudflareLocalStorage(seedArtifacts, seedObjectPayloads);
    const secondStorage = createCloudflareLocalStorage(seedArtifacts, seedObjectPayloads);
    const seededObject = seedObjectPayloads[0]!;
    const originalBytes = await secondStorage.getObjectBytes(seededObject.ref);
    const mutableBytes = await firstStorage.getObjectBytes(seededObject.ref);
    if (!originalBytes || !mutableBytes) {
      throw new Error('expected seeded object bytes');
    }
    mutableBytes[0] = (mutableBytes[0] ?? 0) ^ 0xff;
    expect(await firstStorage.getObjectBytes(seededObject.ref)).toEqual(originalBytes);
    expect(await secondStorage.getObjectBytes(seededObject.ref)).toEqual(originalBytes);

    const first = createApp(firstStorage);
    const second = createApp(secondStorage);
    const sessionResponse = await first.request(
      '/auth/local-session',
      {
        method: 'POST',
        headers: { 'x-cyanprint-dev-secret': 'cyanprint-local-dev' },
        body: JSON.stringify({ userId: 'user_local' }),
      },
      testEnv,
    );
    const session = ((await sessionResponse.json()) as { session: string }).session;
    const tokenResponse = await first.request('/tokens', {
      method: 'POST',
      headers: { 'x-cyanprint-session': session },
      body: JSON.stringify({ name: 'seed-isolation' }),
    });
    const token = ((await tokenResponse.json()) as { token: string }).token;
    const disabled = await first.request(
      `/admin/artifacts/${artifactId('template', 'cyanprint', 'hello', '4')}/disable`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(disabled.status).toBe(200);

    const listed = await second.request('/artifacts?kind=template');
    const artifacts = ((await listed.json()) as { artifacts: Array<{ id: string }> }).artifacts;
    expect(artifacts.some(artifact => artifact.id === artifactId('template', 'cyanprint', 'hello', '4'))).toBe(true);
  });
});
