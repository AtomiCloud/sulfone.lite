import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import app from '../../apps/worker/src/index';

const cacheDir = join(process.cwd(), '.tmp/e2e/cache');
await mkdir(cacheDir, { recursive: true });
await writeFile(join(cacheDir, 'corrupt-entry'), 'bad', 'utf8');

const result = Bun.spawnSync(['bun', 'run', 'cyan', '--', 'cache', 'inspect', '--cache-dir', cacheDir, '--json']);
if (!result.success) {
  throw new Error(result.stderr.toString());
}
const body = JSON.parse(result.stdout.toString()) as { cacheDir: string };
if (body.cacheDir !== cacheDir) {
  throw new Error('cache inspect did not honor --cache-dir');
}
const clean = Bun.spawnSync(['bun', 'run', 'cyan', '--', 'cache', 'clean', '--cache-dir', cacheDir, '--json']);
if (!clean.success || (await Bun.file(join(cacheDir, 'corrupt-entry')).exists())) {
  throw new Error('cache clean did not remove corrupt entry');
}

async function run(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: env ?? process.env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
  return stdout;
}

const workerEnv = { CYANPRINT_ENABLE_LOCAL_AUTH: '1', CYANPRINT_LOCAL_DEV_SECRET: 'cyanprint-local-dev' };
const server = Bun.serve({ port: 0, fetch: request => app.fetch(request, workerEnv) });
try {
  const registry = server.url.toString().replace(/\/$/, '');
  const sessionResponse = await fetch(`${registry}/auth/local-session`, {
    method: 'POST',
    headers: { 'x-cyanprint-dev-secret': 'cyanprint-local-dev' },
    body: JSON.stringify({ userId: 'user_local' }),
  });
  const session = ((await sessionResponse.json()) as { session: string }).session;
  const tokenResponse = await fetch(`${registry}/tokens`, {
    method: 'POST',
    headers: { 'x-cyanprint-session': session },
    body: JSON.stringify({ name: 'cache-e2e' }),
  });
  const token = ((await tokenResponse.json()) as { token: string }).token;
  const push = Bun.spawn(
    ['bun', 'run', 'cyan', '--', 'push', 'examples/templates/hello', '--registry', registry, '--json'],
    { env: { ...process.env, CYANPRINT_TOKEN: token }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [_pushStdout, pushStderr, pushExitCode] = await Promise.all([
    new Response(push.stdout).text(),
    new Response(push.stderr).text(),
    push.exited,
  ]);
  if (pushExitCode !== 0) {
    throw new Error(pushStderr);
  }
  const proc = Bun.spawn(
    [
      'bun',
      'run',
      'cyan',
      '--',
      'create',
      'cyanprint/hello',
      '--registry',
      registry,
      '--trust-fixture',
      'local-registry',
      '--cache-dir',
      cacheDir,
      '--bypass-cache',
      '--out',
      '.tmp/e2e/cache-create',
      '--headless',
      '--answers',
      'examples/templates/hello/answers.json',
      '--json',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
  const createBody = JSON.parse(stdout) as { cacheHydrated?: boolean };
  if (!createBody.cacheHydrated) {
    throw new Error('registry create did not hydrate cache');
  }
  const templateCacheRoot = join(cacheDir, 'template');
  const templateCacheEntry = (await readdir(templateCacheRoot)).sort()[0];
  if (!templateCacheEntry) {
    throw new Error('template cache entry was not written');
  }
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'cyanprint/hello',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--cache-dir',
    cacheDir,
    '--out',
    '.tmp/e2e/cache-create-warm',
    '--headless',
    '--answers',
    'examples/templates/hello/answers.json',
    '--json',
  ]);
  const warmTemplateCacheEntry = (await readdir(templateCacheRoot)).sort()[0];
  if (warmTemplateCacheEntry !== templateCacheEntry) {
    throw new Error('repeat create did not reuse the same template cache key');
  }
  await writeFile(
    join(templateCacheRoot, templateCacheEntry, 'cyan.ts'),
    "export default function cyan() { return { metadata: 'Tampered Cache' }; }\n",
    'utf8',
  );
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'cyanprint/hello',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--cache-dir',
    cacheDir,
    '--out',
    '.tmp/e2e/cache-create-tamper-rehydrated',
    '--headless',
    '--answers',
    'examples/templates/hello/answers.json',
    '--json',
  ]);
  const tamperReadme = await Bun.file('.tmp/e2e/cache-create-tamper-rehydrated/README.md').text();
  if (tamperReadme.includes('Tampered Cache')) {
    throw new Error('warm cache tampering was executed instead of rehydrated');
  }
  const integrityPath = join(templateCacheRoot, templateCacheEntry, '.cyan_cache_integrity');
  await writeFile(integrityPath, 'corrupt', 'utf8');
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'cyanprint/hello',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--cache-dir',
    cacheDir,
    '--out',
    '.tmp/e2e/cache-create-rehydrated',
    '--headless',
    '--answers',
    'examples/templates/hello/answers.json',
    '--json',
  ]);
  if ((await Bun.file(integrityPath).text()) === 'corrupt') {
    throw new Error('corrupt registry cache entry was not rehydrated');
  }
  await rm(join(templateCacheRoot, templateCacheEntry), { recursive: true, force: true });
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'cyanprint/hello',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--cache-dir',
    cacheDir,
    '--out',
    '.tmp/e2e/cache-create-deleted',
    '--headless',
    '--answers',
    'examples/templates/hello/answers.json',
    '--json',
  ]);
  const rehydratedTemplateCacheEntry = (await readdir(templateCacheRoot)).sort()[0];
  if (rehydratedTemplateCacheEntry !== templateCacheEntry) {
    throw new Error('deleted cache entry did not rehydrate to the same template cache key');
  }
} finally {
  server.stop(true);
}

console.log(
  JSON.stringify({
    status: 'done',
    cacheDirOverride: true,
    corruptEntryRemoved: true,
    registryCacheHydrated: true,
    bypassCache: true,
    repeatCreateStableCacheKey: true,
    tamperedCacheRehydrated: true,
    corruptCacheRehydrated: true,
    deletedCacheRehydratedStableKey: true,
  }),
);
