// Standalone driver for the "user edits survive a version move" story (bun run
// e2e:update:user-edits). Local projects move to a new template version by RE-CREATING
// the new template dir into the existing project: same owner/name upserts into
// `.cyan_state.yaml`, and a real git three-way merge (base = old source with saved
// answers, theirs = the new dir, ours = disk) leaves genuine divergence as standard
// in-file `<<<<<<<` conflict markers with a non-zero exit.

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

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

// Re-create with the new template version (same owner/name ⇒ upsert + three-way merge).
result = Bun.spawnSync([
  'bun',
  'run',
  'cyan',
  '--',
  'create',
  'examples/templates/update-v2',
  '--out',
  out,
  '--headless',
  '--answers',
  'examples/templates/update-v2/answers.json',
  '--json',
]);
if (result.success) {
  throw new Error('conflicting re-create unexpectedly exited successfully');
}
const report = JSON.parse(result.stdout.toString()) as { status: string; conflicts: string[] };
if (report.status !== 'conflict') {
  throw new Error('re-create did not report a conflict');
}
if (!report.conflicts.includes('README.md')) {
  throw new Error('README.md was not listed as conflicted');
}

const readme = await Bun.file(join(out, 'README.md')).text();
for (const piece of ['<<<<<<<', 'Keep me.', 'Version two.']) {
  if (!readme.includes(piece)) {
    throw new Error(`README.md conflict markers are missing: ${piece}`);
  }
}

// With conflicts pending, state must NOT advance — the retry below re-merges from the
// original base rather than treating the half-accepted incoming tree as the baseline.
const pending = YAML.parse(await Bun.file(join(out, '.cyan_state.yaml')).text()) as {
  templates: Array<{ name: string; history: unknown[] }>;
};
if (pending.templates.length !== 1 || pending.templates[0]?.history.length !== 1) {
  throw new Error('conflicted upsert advanced .cyan_state.yaml before conflicts were resolved');
}

// Resolve the markers (accept incoming) and re-run: only now install #2 is recorded.
await writeFile(join(out, 'README.md'), '# Update Project\n\nUpdated with pinned answers.\n\nVersion two.\n', 'utf8');
result = Bun.spawnSync([
  'bun',
  'run',
  'cyan',
  '--',
  'create',
  'examples/templates/update-v2',
  '--out',
  out,
  '--headless',
  '--answers',
  'examples/templates/update-v2/answers.json',
  '--json',
]);
if (!result.success) {
  throw new Error(result.stderr.toString());
}
const state = YAML.parse(await Bun.file(join(out, '.cyan_state.yaml')).text()) as {
  templates: Array<{ name: string; history: unknown[] }>;
};
if (state.templates.length !== 1 || state.templates[0]?.history.length !== 2) {
  throw new Error('resolved re-create did not record a second history entry for the template');
}

console.log(
  JSON.stringify({
    status: 'done',
    userEditRetainedInMarkers: true,
    conflict: true,
    statePendingUntilResolved: true,
    historyLengthAfterResolve: 2,
  }),
);
