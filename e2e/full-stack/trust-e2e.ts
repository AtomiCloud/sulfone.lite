import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactIntegrity, type ArtifactVersion } from '@cyanprint/contracts';
import { pinsFingerprint } from '@cyanprint/core';
import app from '../../apps/worker/src/index';

const root = process.cwd();
const workerEnv = { CYANPRINT_ENABLE_LOCAL_AUTH: '1', CYANPRINT_LOCAL_DEV_SECRET: 'cyanprint-local-dev' };
const trustRoot = join(root, '.tmp/e2e/trust-store');
await rm(trustRoot, { recursive: true, force: true });

const server = Bun.serve({ port: 0, fetch: request => app.fetch(request, workerEnv) });
const registry = server.url.toString().replace(/\/$/, '');

async function run(args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: env ?? process.env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr || stdout);
  }
  return { stdout, stderr };
}

async function fails(args: string[]): Promise<boolean> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await proc.exited;
  return exitCode !== 0;
}

try {
  const sessionResponse = await fetch(`${registry}/auth/local-session`, {
    method: 'POST',
    headers: { 'x-cyanprint-dev-secret': 'cyanprint-local-dev' },
    body: JSON.stringify({ userId: 'user_local' }),
  });
  const session = ((await sessionResponse.json()) as { session: string }).session;
  const tokenResponse = await fetch(`${registry}/tokens`, {
    method: 'POST',
    headers: { 'x-cyanprint-session': session },
    body: JSON.stringify({ name: 'trust-e2e' }),
  });
  const token = ((await tokenResponse.json()) as { token: string }).token;

  for (const artifactDir of [
    'examples/artifacts/processor-uppercase',
    'examples/artifacts/plugin-footer',
    'examples/artifacts/resolver-keep-user',
    'examples/templates/hello',
    'examples/templates/with-artifacts',
  ]) {
    await run(['bun', 'run', 'cyan', '--', 'push', artifactDir, '--registry', registry, '--json'], {
      ...process.env,
      CYANPRINT_TOKEN: token,
    });
  }
  const resolvedResponse = await fetch(`${registry}/batch-resolve`, {
    method: 'POST',
    body: JSON.stringify({ refs: [{ kind: 'template', owner: 'cyanprint', name: 'with-artifacts' }] }),
  });
  const artifact = ((await resolvedResponse.json()) as { resolved: ArtifactVersion[] }).resolved[0];
  if (!artifact) {
    throw new Error('trust e2e could not resolve pushed template');
  }
  const integrity = artifactIntegrity(artifact);
  const fingerprint = pinsFingerprint(artifact.resolvedPins);
  const baseCreate = [
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'cyanprint/with-artifacts',
    '--registry',
    registry,
    '--headless',
    '--answers',
    'examples/templates/with-artifacts/answers.json',
  ];

  if (!(await fails([...baseCreate, '--out', '.tmp/e2e/trust-denied', '--trust-dir', join(trustRoot, 'denied')]))) {
    throw new Error('untrusted registry create unexpectedly succeeded');
  }

  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'trust',
    'approve',
    '--scope',
    'organization',
    '--ref',
    'cyanprint',
    '--trust-dir',
    join(trustRoot, 'org'),
  ]);
  await run([...baseCreate, '--out', '.tmp/e2e/trust-org', '--trust-dir', join(trustRoot, 'org')]);

  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'trust',
    'approve',
    '--scope',
    'template',
    '--ref',
    'cyanprint/with-artifacts',
    '--trust-dir',
    join(trustRoot, 'template'),
  ]);
  await run([...baseCreate, '--out', '.tmp/e2e/trust-template', '--trust-dir', join(trustRoot, 'template')]);

  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'trust',
    'approve',
    '--scope',
    'version',
    '--ref',
    `cyanprint/with-artifacts@${artifact.version}`,
    '--integrity',
    integrity,
    '--pins-fingerprint',
    fingerprint,
    '--trust-dir',
    join(trustRoot, 'version'),
  ]);
  await run([...baseCreate, '--out', '.tmp/e2e/trust-version', '--trust-dir', join(trustRoot, 'version')]);

  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'trust',
    'approve',
    '--scope',
    'version',
    '--ref',
    `cyanprint/with-artifacts@${artifact.version}`,
    '--integrity',
    integrity,
    '--trust-dir',
    join(trustRoot, 'version-no-pins'),
  ]);
  if (
    !(await fails([
      ...baseCreate,
      '--out',
      '.tmp/e2e/trust-version-no-pins',
      '--trust-dir',
      join(trustRoot, 'version-no-pins'),
    ]))
  ) {
    throw new Error('version trust without matching pin fingerprint unexpectedly succeeded');
  }

  const inspected = await run([
    'bun',
    'run',
    'cyan',
    '--',
    'trust',
    'inspect',
    '--trust-dir',
    join(trustRoot, 'version'),
  ]);
  if (!inspected.stdout.includes(integrity)) {
    throw new Error('trust inspect did not include version integrity');
  }

  console.log(JSON.stringify({ status: 'done', organization: true, template: true, version: true }));
} finally {
  server.stop(true);
}
