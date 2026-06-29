import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import app from '../../apps/worker/src/index';

const root = process.cwd();
const out = join(root, '.tmp/e2e/full-create');
const updateOut = join(root, '.tmp/e2e/full-update');
const workerEnv = { CYANPRINT_ENABLE_LOCAL_AUTH: '1', CYANPRINT_LOCAL_DEV_SECRET: 'cyanprint-local-dev' };
await rm(out, { recursive: true, force: true });
await rm(updateOut, { recursive: true, force: true });

const server = Bun.serve({ port: 0, fetch: request => app.fetch(request, workerEnv) });
const registry = server.url.toString().replace(/\/$/, '');

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

async function runExpectingFailure(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: env ?? process.env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) {
    throw new Error('Expected command to fail, but it succeeded.');
  }
  return stdout || stderr;
}

async function writeArtifactFile(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function writeTriResolver(root: string, marker: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await writeArtifactFile(
    root,
    'cyan.yaml',
    [
      'cyanprint: 4',
      'kind: resolver',
      'owner: cyanprint',
      'name: tri-merge',
      'entry: src/index.ts',
      'bundledEntry: dist/index.js',
      '',
    ].join('\n'),
  );
  await writeArtifactFile(root, 'README.md', '# Tri Merge Resolver\n');
  await writeArtifactFile(
    root,
    'src/index.ts',
    `export function resolver(input) {
  const lines = input.files
    .sort((left, right) => left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template))
    .flatMap(file => String(file.content ?? '').split('\\n'))
    .map(value => value.trim())
    .filter(Boolean);
  return [...new Set(lines)].join('\\n') + '\\n';
}
`,
  );
}

async function writeTriChild(root: string, name: string, files: Record<string, string>): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await writeArtifactFile(
    root,
    'cyan.yaml',
    [
      'cyanprint: 4',
      'kind: template',
      'owner: cyanprint',
      `name: ${name}`,
      'bundledEntry: cyan.ts',
      '',
      'processors:',
      '  - cyan/default',
      '',
      'resolvers:',
      '  - cyanprint/tri-merge',
      '',
    ].join('\n'),
  );
  await writeArtifactFile(root, 'README.md', `# ${name}\n`);
  await writeArtifactFile(
    root,
    'cyan.ts',
    `export default async function cyan(prompt, ctx) {
  return {
    processors: [{ name: 'cyan/default', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }],
    resolvers: [{ name: 'cyanprint/tri-merge', config: { paths: ['shared.txt'] } }],
  };
}
`,
  );
  for (const [path, content] of Object.entries(files)) {
    await writeArtifactFile(root, `template/${path}`, content);
  }
}

async function writeTriSuite(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await writeArtifactFile(
    root,
    'cyan.yaml',
    [
      'cyanprint: 4',
      'kind: template',
      'owner: cyanprint',
      'name: tri-suite',
      'bundledEntry: cyan.ts',
      '',
      'templates:',
      '  - cyanprint/tri-a',
      '  - cyanprint/tri-b',
      '  - cyanprint/tri-c',
      '',
    ].join('\n'),
  );
  await writeArtifactFile(root, 'README.md', '# Tri Suite\n');
  await writeArtifactFile(
    root,
    'cyan.ts',
    `export default async function cyan(prompt, ctx) {
  return {
    templates: [
      { name: 'cyanprint/tri-a' },
      { name: 'cyanprint/tri-b' },
      { name: 'cyanprint/tri-c' },
    ],
  };
}
`,
  );
  await writeArtifactFile(root, 'template/.keep', 'archive required\n');
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
    body: JSON.stringify({ name: 'full-e2e' }),
  });
  const token = ((await tokenResponse.json()) as { token: string }).token;

  for (const artifactDir of [
    'examples/artifacts/processor-default',
    'examples/artifacts/processor-uppercase',
    'examples/artifacts/plugin-footer',
    'examples/artifacts/resolver-keep-user',
    'examples/artifacts/resolver1',
    'examples/artifacts/resolver2',
  ]) {
    await run(['bun', 'run', 'cyan', '--', 'push', artifactDir, '--registry', registry, '--json'], {
      ...process.env,
      CYANPRINT_TOKEN: token,
    });
  }

  const triRoot = join(root, '.tmp/e2e/three-template-artifacts');
  const triOut = join(root, '.tmp/e2e/three-template-output');
  const triConflictOut = join(root, '.tmp/e2e/three-template-conflict-output');
  await rm(triRoot, { recursive: true, force: true });
  await rm(triOut, { recursive: true, force: true });
  await rm(triConflictOut, { recursive: true, force: true });
  await writeTriResolver(join(triRoot, 'resolver'), 'v1');
  await run(['bun', 'run', 'cyan', '--', 'push', join(triRoot, 'resolver'), '--registry', registry, '--json'], {
    ...process.env,
    CYANPRINT_TOKEN: token,
  });
  await writeTriChild(join(triRoot, 'tri-a'), 'tri-a', {
    'shared.txt': 'a1\n',
    'clean.txt': 'clean v1\n',
    'remove-a.txt': 'remove me\n',
  });
  await writeTriChild(join(triRoot, 'tri-b'), 'tri-b', {
    'shared.txt': 'b1\n',
    'conflict.txt': 'generated conflict v1\n',
  });
  await writeTriChild(join(triRoot, 'tri-c'), 'tri-c', { 'shared.txt': 'c1\n' });
  await writeTriSuite(join(triRoot, 'tri-suite'));
  for (const artifactDir of ['tri-a', 'tri-b', 'tri-c', 'tri-suite']) {
    await run(['bun', 'run', 'cyan', '--', 'push', join(triRoot, artifactDir), '--registry', registry, '--json'], {
      ...process.env,
      CYANPRINT_TOKEN: token,
    });
  }
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'cyanprint/tri-suite@1',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--out',
    triOut,
    '--headless',
    '--json',
  ]);
  await writeFile(join(triOut, 'shared.txt'), 'user shared edit\n', 'utf8');
  await writeTriResolver(join(triRoot, 'resolver'), 'v2');
  await run(['bun', 'run', 'cyan', '--', 'push', join(triRoot, 'resolver'), '--registry', registry, '--json'], {
    ...process.env,
    CYANPRINT_TOKEN: token,
  });
  await writeTriChild(join(triRoot, 'tri-a'), 'tri-a', {
    'shared.txt': 'a2\n',
    'clean.txt': 'clean v2\n',
  });
  await writeTriChild(join(triRoot, 'tri-b'), 'tri-b', {
    'shared.txt': 'b2\n',
    'conflict.txt': 'generated conflict v2\n',
  });
  await writeTriChild(join(triRoot, 'tri-c'), 'tri-c', { 'shared.txt': 'c2\n' });
  await writeTriSuite(join(triRoot, 'tri-suite'));
  for (const artifactDir of ['tri-a', 'tri-b', 'tri-c', 'tri-suite']) {
    await run(['bun', 'run', 'cyan', '--', 'push', join(triRoot, artifactDir), '--registry', registry, '--json'], {
      ...process.env,
      CYANPRINT_TOKEN: token,
    });
  }
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'update',
    triOut,
    '--template',
    'cyanprint/tri-suite',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--headless',
    '--json',
  ]);
  const triShared = await Bun.file(join(triOut, 'shared.txt')).text();
  for (const expected of ['user shared edit', 'a2', 'b2', 'c2']) {
    if (!triShared.includes(expected)) {
      throw new Error(`Three-template resolver update missed merged shared content: ${expected}`);
    }
  }
  if ((await Bun.file(join(triOut, 'clean.txt')).text()) !== 'clean v2\n') {
    throw new Error('Three-template resolver update missed clean three-way output.');
  }
  if (await Bun.file(join(triOut, 'remove-a.txt')).exists()) {
    throw new Error('Three-template resolver update did not remove deleted target file.');
  }
  const triState = await Bun.file(join(triOut, '.cyan_state.yaml')).text();
  if (!triState.includes('name: tri-merge') || !triState.includes('version: "2"')) {
    throw new Error('Three-template resolver update did not record the upgraded resolver pin.');
  }
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'cyanprint/tri-suite@1',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--out',
    triConflictOut,
    '--headless',
    '--json',
  ]);
  await writeFile(join(triConflictOut, 'conflict.txt'), 'user conflict edit\n', 'utf8');
  await runExpectingFailure([
    'bun',
    'run',
    'cyan',
    '--',
    'update',
    triConflictOut,
    '--template',
    'cyanprint/tri-suite',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--headless',
    '--json',
  ]);
  if (!(await Bun.file(join(triConflictOut, '.cyan_conflicts/conflict.txt.target')).exists())) {
    throw new Error('Three-template resolver update did not record the expected conflict.');
  }

  for (const templateDir of ['examples/templates/hello', 'examples/templates/with-artifacts']) {
    await run(['bun', 'run', 'cyan', '--', 'push', templateDir, '--registry', registry, '--json'], {
      ...process.env,
      CYANPRINT_TOKEN: token,
    });
  }
  for (const templateDir of ['examples/templates/template-resolver-1', 'examples/templates/template-resolver-2']) {
    await run(['bun', 'run', 'cyan', '--', 'push', templateDir, '--registry', registry, '--json'], {
      ...process.env,
      CYANPRINT_TOKEN: token,
    });
  }
  await run(['bun', 'run', 'cyan', '--', 'push', 'examples/template-groups/basic', '--registry', registry, '--json'], {
    ...process.env,
    CYANPRINT_TOKEN: token,
  });
  await run(['bun', 'run', 'cyan', '--', 'push', 'examples/templates/update-v2', '--registry', registry, '--json'], {
    ...process.env,
    CYANPRINT_TOKEN: token,
  });
  for (const templateDir of ['examples/templates/new', 'examples/templates/workspace', 'examples/templates/nix']) {
    await run(['bun', 'run', 'cyan', '--', 'push', templateDir, '--registry', registry, '--json'], {
      ...process.env,
      CYANPRINT_TOKEN: token,
    });
  }

  const resolveResponse = await fetch(`${registry}/batch-resolve`, {
    method: 'POST',
    body: JSON.stringify({
      refs: [{ kind: 'template', owner: 'cyanprint', name: 'with-artifacts' }],
    }),
  });
  const resolved = (await resolveResponse.json()) as { resolved: unknown[] };
  if (resolved.resolved.length !== 1) {
    throw new Error('Published template did not resolve from registry.');
  }

  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'cyanprint/with-artifacts',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--out',
    out,
    '--headless',
    '--answers',
    'examples/templates/with-artifacts/answers.json',
    '--json',
  ]);

  const readme = await Bun.file(join(out, 'README.md')).text();
  if (!readme.includes('ARTIFACT PROJECT') || !readme.includes('Generated locally.')) {
    throw new Error('Full e2e output did not include processor/plugin output.');
  }

  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'try',
    'cyanprint/with-artifacts',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--headless',
    '--answers',
    'examples/templates/with-artifacts/answers.json',
    '--json',
  ]);

  const groupOut = join(root, '.tmp/e2e/full-group-create');
  await rm(groupOut, { recursive: true, force: true });
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'cyanprint/basic-group',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--out',
    groupOut,
    '--headless',
    '--answers',
    'examples/template-groups/basic/answers.json',
    '--json',
  ]);
  const groupReadme = await Bun.file(join(groupOut, 'README.md')).text();
  if (!groupReadme.includes('ARTIFACT PROJECT') || !(await Bun.file(join(groupOut, 'GROUP.md')).exists())) {
    throw new Error('Registry template-group create did not compose child template output.');
  }
  await writeFile(join(groupOut, 'README.md'), '# User Group Edit\n\nKeep this nested resolver edit.\n', 'utf8');
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'update',
    groupOut,
    '--template',
    'cyanprint/basic-group',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--headless',
    '--answers',
    'examples/template-groups/basic/answers.json',
    '--json',
  ]);
  const nestedResolverReadme = await Bun.file(join(groupOut, 'README.md')).text();
  if (!nestedResolverReadme.includes('Keep this nested resolver edit.')) {
    throw new Error('Registry template-group update did not use the nested child resolver.');
  }

  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'test',
    'examples/templates/with-artifacts',
    '--answers',
    'examples/templates/with-artifacts/answers.json',
    '--out',
    '.tmp/e2e/full-test',
  ]);

  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'examples/templates/update-v1',
    '--out',
    updateOut,
    '--headless',
    '--answers',
    'examples/templates/update-v1/answers.json',
    '--json',
  ]);
  await writeFile(join(updateOut, 'README.md'), '# User Edit\n\nKeep me.\n', 'utf8');
  await runExpectingFailure([
    'bun',
    'run',
    'cyan',
    '--',
    'update',
    updateOut,
    '--template',
    'examples/templates/update-v2',
    '--headless',
    '--answers',
    'examples/templates/update-v2/answers.json',
    '--json',
  ]);
  if (!(await Bun.file(join(updateOut, '.cyan_conflicts/README.md.target')).exists())) {
    throw new Error('Update did not produce a conflict target for user-edited README.');
  }

  const registryUpdateOut = join(root, '.tmp/e2e/full-registry-update');
  await rm(registryUpdateOut, { recursive: true, force: true });
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'examples/templates/update-v1',
    '--out',
    registryUpdateOut,
    '--headless',
    '--answers',
    'examples/templates/update-v1/answers.json',
    '--json',
  ]);
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'update',
    registryUpdateOut,
    '--template',
    'cyanprint/update-example',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--headless',
    '--answers',
    'examples/templates/update-v2/answers.json',
    '--json',
  ]);
  const registryUpdateReadme = await Bun.file(join(registryUpdateOut, 'README.md')).text();
  if (!registryUpdateReadme.includes('Version two.')) {
    throw new Error('Registry-backed update did not apply template v2 output.');
  }

  const registryResolverOut = join(root, '.tmp/e2e/full-registry-resolver-update');
  await rm(registryResolverOut, { recursive: true, force: true });
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'cyanprint/template-resolver-1',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--out',
    registryResolverOut,
    '--headless',
    '--json',
  ]);
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'update',
    registryResolverOut,
    '--template',
    'cyanprint/template-resolver-2',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--headless',
    '--json',
  ]);
  if (await Bun.file(join(registryResolverOut, 'from-1.txt')).exists()) {
    throw new Error('Registry resolver update did not remove deleted template file.');
  }
  if (!(await Bun.file(join(registryResolverOut, 'from-2.txt')).exists())) {
    throw new Error('Registry resolver update did not add new template file.');
  }

  const registryResolverConflictOut = join(root, '.tmp/e2e/full-registry-resolver-conflict');
  await rm(registryResolverConflictOut, { recursive: true, force: true });
  await run([
    'bun',
    'run',
    'cyan',
    '--',
    'create',
    'cyanprint/template-resolver-1',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--out',
    registryResolverConflictOut,
    '--headless',
    '--json',
  ]);
  await writeFile(join(registryResolverConflictOut, 'force_conflict.txt'), 'user edit\n', 'utf8');
  await runExpectingFailure([
    'bun',
    'run',
    'cyan',
    '--',
    'update',
    registryResolverConflictOut,
    '--template',
    'cyanprint/template-resolver-2',
    '--registry',
    registry,
    '--trust-fixture',
    'local-registry',
    '--headless',
    '--json',
  ]);
  if (!(await Bun.file(join(registryResolverConflictOut, '.cyan_conflicts/force_conflict.txt.target')).exists())) {
    throw new Error('Registry resolver update did not preserve conflict target.');
  }

  console.log(
    JSON.stringify({
      status: 'done',
      localWorkerStarted: true,
      tokenMinted: true,
      templatePublished: true,
      pinsResolved: true,
      registryTemplateGroupCreate: true,
      registryTemplateGroupUpdateResolver: true,
      threeTemplateDependencyResolverUpgrade: true,
      registryResolverTemplateUpdate: true,
      dependencyAnswerPrefill: true,
      registryTryWithDependencies: true,
      registryUpdateCompleted: true,
      createTestUpdateCompleted: true,
      bundledArtifactsInvoked: true,
      updateConflictVerified: true,
      localOnly: true,
    }),
  );
} finally {
  server.stop(true);
}
