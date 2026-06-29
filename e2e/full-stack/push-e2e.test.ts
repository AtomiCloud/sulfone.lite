import { expect, test } from 'bun:test';

async function runScript(): Promise<string> {
  const proc = Bun.spawn(['bun', 'run', 'e2e/full-stack/push-e2e.ts'], {
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

test('e2e command flow: cyan push publishes template/plugin/processor/resolver and bumps repeated versions', async () => {
  const output = await runScript();
  const result = JSON.parse(output.trim()) as Record<string, unknown>;

  expect(result).toEqual({
    status: 'done',
    tokenMinted: true,
    published: 9,
    versionBumps: 4,
    workerValidatedPins: true,
  });
}, 120_000);
