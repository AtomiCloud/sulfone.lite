import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  // The CLI runs test cases in parallel by default; --parallel N overrides the worker count.
  const concurrency = parseParallel(flagString(flags, 'parallel')) ?? 4;
  const explicitOut = flagString(flags, 'out');
  const tempOut =
    !explicitOut && (manifest.kind === 'template' || manifest.kind === 'template-group')
      ? await mkdtemp(join(tmpdir(), 'cyanprint-test-'))
      : undefined;
  let report;
  try {
    report =
      manifest.kind === 'template' || manifest.kind === 'template-group'
        ? await runTemplateTest({
            template: target,
            answers: flagString(flags, 'answers') ?? (await defaultTemplateAnswers(target)),
            outDir: explicitOut ?? tempOut!,
            snapshot: flagString(flags, 'snapshot'),
            updateSnapshots: flagBool(flags, 'update-snapshots'),
            concurrency,
          })
        : await runArtifactTests({
            artifactDir: target,
            testsDir: flagString(flags, 'tests'),
            updateSnapshots: flagBool(flags, 'update-snapshots'),
            concurrency,
          });
  } finally {
    if (tempOut) {
      await rm(tempOut, { recursive: true, force: true });
    }
  }
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
      kv('expected outputs updated', report.snapshotUpdated),
    ]);
  }
  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

async function defaultTemplateAnswers(target: string): Promise<string | undefined> {
  const answers = join(target, 'answers.json');
  return (await Bun.file(answers).exists()) ? answers : undefined;
}

function parseParallel(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--parallel must be a positive integer, got "${value}"`);
  }
  return parsed;
}
