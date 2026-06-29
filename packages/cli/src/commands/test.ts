import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadManifest, runArtifactTests, runTemplateTest } from '@cyanprint/core';
import { parseFlags, flagBool, flagString } from '../args';
import { failure, kv, printJson, printSection, success } from '../ui';

export async function testCommand(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const target = positional[0];
  if (!target) {
    throw new Error('test requires an artifact or template path');
  }
  const { manifest } = await loadManifest(target);
  const report =
    manifest.kind === 'template' || manifest.kind === 'template-group'
      ? await runTemplateTest({
          template: target,
          answers: flagString(flags, 'answers') ?? (await defaultTemplateAnswers(target)),
          outDir: flagString(flags, 'out', '.tmp/cyanprint-test')!,
          snapshot: flagString(flags, 'snapshot') ?? (await defaultTemplateSnapshot(target)),
          updateSnapshots: flagBool(flags, 'update-snapshots'),
        })
      : await runArtifactTests({
          artifactDir: target,
          testsDir: flagString(flags, 'tests'),
          updateSnapshots: flagBool(flags, 'update-snapshots'),
        });
  const reportPath = flagString(flags, 'report');
  if (reportPath) {
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  }
  if (flagBool(flags, 'json')) {
    printJson(report);
  } else {
    console.log(report.failed > 0 ? failure(`failed ${target}`) : success(`passed ${target}`));
    printSection('Results', [
      kv('passed', report.passed),
      kv('failed', report.failed),
      kv('skipped', report.skipped),
      kv('snapshots', report.snapshotUpdated),
    ]);
  }
  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

async function defaultTemplateSnapshot(target: string): Promise<string> {
  const expected = join(target, 'expected/README.md');
  return (await Bun.file(expected).exists()) ? expected : join(target, 'snapshots/basic/README.md');
}

async function defaultTemplateAnswers(target: string): Promise<string | undefined> {
  const answers = join(target, 'answers.json');
  return (await Bun.file(answers).exists()) ? answers : undefined;
}
