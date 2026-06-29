import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const mode = Bun.argv.at(-1) ?? 'all';
const root = process.cwd();

async function timed(
  name: string,
  args: string[],
  options: { expectFailure?: boolean } = {},
): Promise<{ name: string; ms: number }> {
  const start = performance.now();
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [_stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (!options.expectFailure && exitCode !== 0) {
    throw new Error(`${name} failed: ${stderr}`);
  }
  if (options.expectFailure && exitCode === 0) {
    throw new Error(`${name} unexpectedly succeeded`);
  }
  return { name, ms: Math.round(performance.now() - start) };
}

const timings: Array<{ name: string; ms: number }> = [];

if (mode === 'all' || mode === 'create' || mode === 'try-test') {
  const coldOut = join(root, '.tmp/e2e/timed-create-cold');
  const warmOut = join(root, '.tmp/e2e/timed-create-warm');
  await rm(coldOut, { recursive: true, force: true });
  await rm(warmOut, { recursive: true, force: true });
  timings.push(
    await timed('create:cold', [
      'bun',
      'run',
      'cyan',
      '--',
      'create',
      'examples/templates/hello',
      '--out',
      coldOut,
      '--headless',
      '--answers',
      'examples/templates/hello/answers.json',
      '--json',
    ]),
  );
  timings.push(
    await timed('create:warm', [
      'bun',
      'run',
      'cyan',
      '--',
      'create',
      'examples/templates/hello',
      '--out',
      warmOut,
      '--headless',
      '--answers',
      'examples/templates/hello/answers.json',
      '--json',
    ]),
  );
}

if (mode === 'all' || mode === 'try-test') {
  await rm(join(root, '.tmp/e2e/timed-try'), { recursive: true, force: true });
  timings.push(
    await timed('try:template', [
      'bun',
      'run',
      'cyan',
      '--',
      'try',
      'examples/templates/hello',
      '--out',
      '.tmp/e2e/timed-try',
      '--headless',
      '--answers',
      'examples/templates/hello/answers.json',
      '--json',
    ]),
  );
  await rm(join(root, '.tmp/e2e/timed-test'), { recursive: true, force: true });
  timings.push(
    await timed('test:template', [
      'bun',
      'run',
      'cyan',
      '--',
      'test',
      'examples/templates/with-artifacts',
      '--answers',
      'examples/templates/with-artifacts/answers.json',
      '--out',
      '.tmp/e2e/timed-test',
    ]),
  );
}

if (mode === 'all' || mode === 'update') {
  const updateOut = join(root, '.tmp/e2e/timed-update');
  await rm(updateOut, { recursive: true, force: true });
  await timed('update:setup', [
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
  timings.push(
    await timed(
      'update',
      [
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
      ],
      { expectFailure: true },
    ),
  );
}

const coldMs = timings.find(entry => entry.name === 'create:cold')?.ms;
const warmMs = timings.find(entry => entry.name === 'create:warm')?.ms;
console.log(
  JSON.stringify({
    status: 'done',
    mode,
    coldMs,
    warmMs,
    timings,
    docker: false,
    daemon: false,
    remoteExecution: false,
  }),
);
