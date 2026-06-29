import { rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const out = join(process.cwd(), '.tmp/e2e/update-project');
await rm(out, { recursive: true, force: true });

let result = Bun.spawnSync([
  'bun',
  'run',
  'cyan',
  '--',
  'create',
  'examples/templates/update-v1',
  '--out',
  out,
  '--headless',
  '--answers',
  'examples/templates/update-v1/answers.json',
  '--json',
]);
if (!result.success) {
  throw new Error(result.stderr.toString());
}
await writeFile(join(out, 'README.md'), '# User Edit\n\nKeep me.\n', 'utf8');

result = Bun.spawnSync([
  'bun',
  'run',
  'cyan',
  '--',
  'update',
  out,
  '--template',
  'examples/templates/update-v2',
  '--headless',
  '--answers',
  'examples/templates/update-v2/answers.json',
  '--json',
]);
if (result.success) {
  throw new Error('update conflict unexpectedly exited successfully');
}
const updateReport = JSON.parse(result.stdout.toString()) as { status: string };
if (updateReport.status !== 'conflict') {
  throw new Error('update did not report a conflict');
}

const readme = await Bun.file(join(out, 'README.md')).text();
if (!readme.includes('User Edit')) {
  throw new Error('user edit was overwritten');
}
if (!(await Bun.file(join(out, '.cyan_conflicts/README.md.target')).exists())) {
  throw new Error('conflict target was not written');
}
console.log(JSON.stringify({ status: 'done', userEditedFileRetained: true, conflict: true }));
