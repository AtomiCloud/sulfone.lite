import app from '../../apps/worker/src/index';

const targets = [
  'examples/artifacts/processor-default',
  'examples/artifacts/processor-uppercase',
  'examples/artifacts/plugin-footer',
  'examples/artifacts/resolver-keep-user',
  'examples/templates/new',
  'examples/templates/workspace',
  'examples/templates/nix',
  'examples/templates/with-artifacts',
  'examples/template-groups/basic',
];

const workerEnv = { CYANPRINT_ENABLE_LOCAL_AUTH: '1', CYANPRINT_LOCAL_DEV_SECRET: 'cyanprint-local-dev' };
const server = Bun.serve({ port: 0, fetch: request => app.fetch(request, workerEnv) });
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
  body: JSON.stringify({ name: 'push-e2e' }),
});
const token = ((await tokenResponse.json()) as { token: string }).token;

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

try {
  for (const target of targets) {
    await run(['bun', 'run', 'cyan', '--', 'push', target, '--registry', registry, '--json'], {
      ...process.env,
      CYANPRINT_TOKEN: token,
    });
  }

  const listed = await fetch(`${registry}/artifacts`);
  const body = (await listed.json()) as { artifacts: unknown[] };
  if (body.artifacts.length < targets.length) {
    throw new Error('published artifacts were not visible in registry');
  }
  const bumpTargets = [
    { path: 'examples/templates/with-artifacts', kind: 'template', owner: 'cyanprint', name: 'with-artifacts' },
    { path: 'examples/artifacts/plugin-footer', kind: 'plugin', owner: 'cyanprint', name: 'footer' },
    { path: 'examples/artifacts/processor-default', kind: 'processor', owner: 'cyan', name: 'default' },
    { path: 'examples/artifacts/resolver-keep-user', kind: 'resolver', owner: 'cyanprint', name: 'keep-user' },
  ];
  for (const target of bumpTargets) {
    const before = (await (
      await fetch(`${registry}/artifacts/${target.kind}/${target.owner}/${target.name}/versions`)
    ).json()) as { artifacts: Array<{ version: string }> };
    const previousLatest = Math.max(0, ...before.artifacts.map(artifact => Number(artifact.version)));
    const output = await run(['bun', 'run', 'cyan', '--', 'push', target.path, '--registry', registry, '--json'], {
      ...process.env,
      CYANPRINT_TOKEN: token,
    });
    const published = JSON.parse(output) as { artifact: { version: string } };
    const expectedVersion = String(previousLatest + 1);
    if (published.artifact.version !== expectedVersion) {
      throw new Error(
        `Repeated push assigned ${target.kind}:${target.owner}/${target.name}@${published.artifact.version}, expected @${expectedVersion}.`,
      );
    }
    const versions = (await (
      await fetch(`${registry}/artifacts/${target.kind}/${target.owner}/${target.name}/versions`)
    ).json()) as { artifacts: Array<{ version: string }> };
    if (!versions.artifacts.some(artifact => artifact.version === expectedVersion)) {
      throw new Error(
        `Repeated push did not expose ${target.kind}:${target.owner}/${target.name}@${expectedVersion} in versions.`,
      );
    }
  }
  console.log(
    JSON.stringify({
      status: 'done',
      tokenMinted: true,
      published: targets.length,
      versionBumps: bumpTargets.length,
      workerValidatedPins: true,
    }),
  );
} finally {
  server.stop(true);
}
