import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST_GENERATION_TIMEOUT_ENV, runPostGenerationCommand } from './post-generation-command';

const dirs: string[] = [];
const originalEnv = process.env[POST_GENERATION_TIMEOUT_ENV];

afterEach(async () => {
  if (originalEnv === undefined) {
    delete process.env[POST_GENERATION_TIMEOUT_ENV];
  } else {
    process.env[POST_GENERATION_TIMEOUT_ENV] = originalEnv;
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cyanprint-postgen-test-'));
  dirs.push(dir);
  return dir;
}

describe('runPostGenerationCommand', () => {
  test('captures output and exit code of a normal command', async () => {
    const cwd = await tempDir();
    const result = await runPostGenerationCommand({ command: 'sh', args: ['-c', 'echo hi; exit 3'], allow: true, cwd });
    expect(result).toMatchObject({ allowed: true, exitCode: 3, stdout: 'hi\n' });
    expect(result.timedOut).toBeUndefined();
  });

  test('a hung command is killed at the timeout instead of hanging forever', async () => {
    const cwd = await tempDir();
    const started = Date.now();
    const result = await runPostGenerationCommand({
      command: 'sh',
      args: ['-c', 'sleep 30'],
      allow: true,
      cwd,
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('the timeout comes from the environment when not given explicitly, and kills grandchildren', async () => {
    const cwd = await tempDir();
    process.env[POST_GENERATION_TIMEOUT_ENV] = '300';
    const started = Date.now();
    const result = await runPostGenerationCommand({
      command: 'sh',
      args: ['-c', 'sleep 30 & sleep 30'],
      allow: true,
      cwd,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
