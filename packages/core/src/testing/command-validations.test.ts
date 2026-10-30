import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLocalCliInvocation, readValidationTimeoutMs, runCommandValidations } from './command-validations';

const dirs: string[] = [];
const originalShell = process.env.SHELL;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cyanprint-validations-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (originalShell === undefined) {
    delete process.env.SHELL;
  } else {
    process.env.SHELL = originalShell;
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('runCommandValidations', () => {
  test('passes on success and reports a failing command with its output', async () => {
    const root = await tempDir();
    expect(await runCommandValidations(root, [{ command: 'echo ok', args: [], shell: true }])).toBeUndefined();
    const failure = await runCommandValidations(root, [{ command: 'echo boom >&2; exit 3', args: [], shell: true }]);
    expect(failure).toContain('Command failed (echo boom >&2; exit 3)');
    expect(failure).toContain('boom');
  });

  test('runs shell validations under sh -c, never the caller login shell', async () => {
    const root = await tempDir();
    const fakeShell = join(root, 'fake-shell');
    await writeFile(fakeShell, '#!/bin/sh\necho "fake shell used" >&2\nexit 9\n', { mode: 0o755 });
    process.env.SHELL = fakeShell;
    expect(await runCommandValidations(root, [{ command: 'true', args: [], shell: true }])).toBeUndefined();
  });

  test('runs structured commands with their args', async () => {
    const root = await tempDir();
    expect(
      await runCommandValidations(root, [{ command: 'sh', args: ['-c', 'test "$0" = "a b"', 'a b'] }]),
    ).toBeUndefined();
    expect(await runCommandValidations(root, [{ command: 'sh', args: ['-c', 'exit 4'] }])).toContain('Command failed');
  });

  test('a hung validation is killed at the timeout instead of hanging forever', async () => {
    const root = await tempDir();
    const started = Date.now();
    const failure = await runCommandValidations(root, [{ command: 'sleep 30', args: [], shell: true }], {
      timeoutMs: 300,
    });
    expect(failure).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('a background child holding the pipes does not hang a passing validation, and is killed', async () => {
    const root = await tempDir();
    const started = Date.now();
    const result = await runCommandValidations(root, [
      { command: '(sleep 2; echo late > late.txt) & echo done', args: [], shell: true },
    ]);
    expect(result).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_900);
    await Bun.sleep(2_300);
    await expect(readFile(join(root, 'late.txt'), 'utf8')).rejects.toThrow();
  });
});

describe('readValidationTimeoutMs', () => {
  test('accepts positive integers up to the setTimeout limit and rejects overflow', () => {
    expect(readValidationTimeoutMs(undefined, 'x')).toBeUndefined();
    expect(readValidationTimeoutMs(1_000, 'x')).toBe(1_000);
    expect(readValidationTimeoutMs(2_147_483_647, 'x')).toBe(2_147_483_647);
    expect(() => readValidationTimeoutMs(2_147_483_648, 'x')).toThrow('x must be a positive integer');
    expect(() => readValidationTimeoutMs(0, 'x')).toThrow();
    expect(() => readValidationTimeoutMs(1.5, 'x')).toThrow();
  });
});

describe('findLocalCliInvocation', () => {
  test('a compiled binary re-enters itself, never a sulfone checkout found under the cwd', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'packages/cli/src'), { recursive: true });
    await writeFile(join(root, 'packages/cli/src/main.ts'), 'console.log("checkout")\n', 'utf8');
    const previous = process.cwd();
    process.chdir(root);
    try {
      expect(await findLocalCliInvocation('/$bunfs/root', { compiled: true, execPath: '/opt/cyanprint' })).toEqual([
        '/opt/cyanprint',
      ]);
    } finally {
      process.chdir(previous);
    }
  });

  test('a source run finds the CLI entry beside this package', async () => {
    const invocation = await findLocalCliInvocation(import.meta.dir, { compiled: false });
    expect(invocation?.slice(0, 2)).toEqual(['bun', 'run']);
    expect(invocation?.[2]).toEndWith('packages/cli/src/main.ts');
  });
});
