import { sha256 } from '@cyanprint/core';
import { rm, writeFile } from 'node:fs/promises';

const port = 18787;
const textEncoder = new TextEncoder();
await rm('apps/worker/.wrangler/state', { recursive: true, force: true });
await writeFile(
  'apps/worker/.dev.vars',
  'CYANPRINT_ENABLE_LOCAL_AUTH=1\nCYANPRINT_ENABLE_REGISTRY_SEEDS=1\nCYANPRINT_LOCAL_DEV_SECRET=cyanprint-local-dev\n',
  'utf8',
);
const migrate = Bun.spawnSync(['bun', 'run', '--filter', '@cyanprint/worker', 'db:migrate:local']);
if (!migrate.success) {
  throw new Error(migrate.stderr.toString());
}

const proc = Bun.spawn(
  ['bun', 'run', '--filter', '@cyanprint/worker', 'dev', '--', '--local', '--port', String(port)],
  {
    stdout: 'ignore',
    stderr: 'ignore',
    env: process.env,
  },
);

async function waitForHealth(registry: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${registry}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error('wrangler registry did not become healthy');
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function uploadUrl(urls: Record<string, string>, part: string): string {
  const url = urls[part];
  if (!url) {
    throw new Error(`missing upload url: ${part}`);
  }
  return url;
}

async function publishTemplate(args: {
  registry: string;
  token: string;
  owner: string;
  name: string;
  bundle: string;
  readme?: string;
}): Promise<{
  version: string;
  artifactObjects: {
    manifest: { sha256: string; size: number; key: string };
    bundle: { sha256: string; size: number; key: string };
    archive: { sha256: string; size: number; key: string };
  };
}> {
  const manifest = [
    'cyanprint: 4',
    'kind: template',
    `owner: ${args.owner}`,
    `name: ${args.name}`,
    'bundledEntry: cyan.ts',
    '',
  ].join('\n');
  const archive = JSON.stringify({
    cyanArchive: 1,
    files: [
      { path: 'cyan.yaml', bytesBase64: Buffer.from(manifest).toString('base64') },
      { path: 'cyan.ts', bytesBase64: Buffer.from(args.bundle).toString('base64') },
    ],
  });
  const objects = {
    manifest: { sha256: sha256(manifest), size: byteLength(manifest) },
    bundle: { sha256: sha256(args.bundle), size: byteLength(args.bundle) },
    archive: { sha256: sha256(archive), size: byteLength(archive) },
  };
  const startResponse = await fetch(`${args.registry}/uploads/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${args.token}` },
    body: JSON.stringify({
      kind: 'template',
      owner: args.owner,
      name: args.name,
      objects,
    }),
  });
  if (!startResponse.ok) {
    throw new Error(await startResponse.text());
  }
  const upload = (await startResponse.json()) as {
    uploadId: string;
    urls: Record<string, string>;
  };
  for (const [part, payload] of Object.entries({ manifest, bundle: args.bundle, archive })) {
    const put = await fetch(`${args.registry}${uploadUrl(upload.urls, part)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${args.token}` },
      body: payload,
    });
    if (!put.ok) {
      throw new Error(await put.text());
    }
  }
  const finalizeResponse = await fetch(`${args.registry}/uploads/finalize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${args.token}` },
    body: JSON.stringify({
      uploadId: upload.uploadId,
      artifact: {
        kind: 'template',
        owner: args.owner,
        name: args.name,
        readme: args.readme ?? '',
        dependencies: [],
        resolvedPins: [],
      },
    }),
  });
  if (!finalizeResponse.ok) {
    throw new Error(await finalizeResponse.text());
  }
  return (
    (await finalizeResponse.json()) as {
      artifact: {
        version: string;
        artifactObjects: {
          manifest: { sha256: string; size: number; key: string };
          bundle: { sha256: string; size: number; key: string };
          archive: { sha256: string; size: number; key: string };
        };
      };
    }
  ).artifact;
}

const registry = `http://127.0.0.1:${port}`;
try {
  await waitForHealth(registry);
  const sessionResponse = await fetch(`${registry}/auth/local-session`, {
    method: 'POST',
    headers: { 'x-cyanprint-dev-secret': 'cyanprint-local-dev' },
    body: JSON.stringify({ userId: 'user_local' }),
  });
  if (!sessionResponse.ok) {
    throw new Error(await sessionResponse.text());
  }
  const session = ((await sessionResponse.json()) as { session: string }).session;
  const tokenResponse = await fetch(`${registry}/tokens`, {
    method: 'POST',
    headers: { 'x-cyanprint-session': session },
    body: JSON.stringify({ name: 'wrangler-e2e' }),
  });
  if (!tokenResponse.ok) {
    throw new Error(await tokenResponse.text());
  }
  const token = ((await tokenResponse.json()) as { token: string }).token;
  const firstBundle = 'export default async () => ({ files: {} });\n';
  const firstArtifact = await publishTemplate({
    registry,
    token,
    owner: 'cyanprint',
    name: 'wrangler-e2e',
    bundle: firstBundle,
  });
  const followupArtifact = await publishTemplate({
    registry,
    token,
    owner: 'cyanprint',
    name: 'wrangler-e2e',
    bundle: 'export default async () => ({ metadata: "# v5" });\n',
  });
  if (followupArtifact.version !== '2') {
    throw new Error(`wrangler D1 did not assign version 2 after first publish: ${followupArtifact.version}`);
  }
  const downloadResponse = await fetch(`${registry}/objects/download`, {
    method: 'POST',
    headers: { accept: 'application/octet-stream' },
    body: JSON.stringify({ ref: firstArtifact.artifactObjects.bundle }),
  });
  if (!downloadResponse.ok) {
    throw new Error(await downloadResponse.text());
  }
  const downloaded = await downloadResponse.text();
  if (downloaded !== firstBundle) {
    throw new Error('wrangler R2 bundle did not round trip');
  }
  const seededBundle = 'export default async () => ({ files: {} });\n';
  const seededArtifact = await publishTemplate({
    registry,
    token,
    owner: 'cyanprint',
    name: 'hello',
    bundle: seededBundle,
  });
  const seededResolveResponse = await fetch(`${registry}/batch-resolve`, {
    method: 'POST',
    body: JSON.stringify({ refs: [{ kind: 'template', owner: 'cyanprint', name: 'hello', version: '5' }] }),
  });
  const seededResolved = (await seededResolveResponse.json()) as {
    resolved: Array<{ artifactObjects?: { bundle?: { sha256: string } } }>;
  };
  if (
    seededArtifact.version !== '5' ||
    seededResolved.resolved[0]?.artifactObjects?.bundle?.sha256 !== seededArtifact.artifactObjects.bundle.sha256
  ) {
    throw new Error('wrangler seeded artifact replacement did not resolve the published folder-first objects');
  }
  console.log(JSON.stringify({ status: 'done', wrangler: true, d1: true, kv: true, r2: true }));
} finally {
  proc.kill('SIGINT');
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(1000).then(() => false)]);
  if (!exited) {
    proc.kill('SIGKILL');
    await proc.exited;
  }
  await rm('apps/worker/.dev.vars', { force: true });
}
