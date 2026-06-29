import { expect, test } from 'bun:test';

async function runScript(): Promise<string> {
  const proc = Bun.spawn(['bun', 'run', 'e2e/full-stack/run-full-e2e.ts'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  return stdout;
}

test('e2e command flow: cyan create/update/try/test with local registry templates and dependencies', async () => {
  const output = await runScript();
  const result = JSON.parse(output.trim()) as Record<string, unknown>;

  expect(result).toEqual({
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
  });
}, 120_000);
