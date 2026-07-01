// Shared helpers for the full-stack e2e: one-line CLI commands and expected-folder compares.

import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

export type CommandOptions = {
  env?: Record<string, string | undefined>;
};

/**
 * Run a cyanprint CLI command written as ONE readable line, e.g.
 * `cyan(`create cyanprint/tri-suite@1 --registry ${registry} --out ${out} --headless --json`)`.
 * Arguments are split on whitespace, so interpolated values must not contain spaces.
 */
export async function cyan(command: string, options: CommandOptions = {}): Promise<string> {
  const { stdout, stderr, exitCode } = await spawnCyan(command, options);
  if (exitCode !== 0) {
    throw new Error(`cyan ${command}\nexit ${exitCode}\n${stderr || stdout}`);
  }
  return stdout;
}

/** Like `cyan`, but the command MUST fail (e.g. an update that records conflicts). */
export async function cyanExpectingFailure(command: string, options: CommandOptions = {}): Promise<string> {
  const { stdout, stderr, exitCode } = await spawnCyan(command, options);
  if (exitCode === 0) {
    throw new Error(`cyan ${command}\nexpected a non-zero exit, but it succeeded`);
  }
  return stdout || stderr;
}

async function spawnCyan(
  command: string,
  options: CommandOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = command.split(/\s+/).filter(Boolean);
  const proc = Bun.spawn(['bun', 'run', 'cyan', '--', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: (options.env ?? process.env) as NodeJS.ProcessEnv,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export async function resetDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Copy a fixture folder into a staging dir so pushes never mutate the committed fixtures. */
export async function stageFixture(fixtureDir: string, stagingDir: string): Promise<string> {
  await rm(stagingDir, { recursive: true, force: true });
  await cp(fixtureDir, stagingDir, { recursive: true });
  return stagingDir;
}

// Generated bookkeeping, excluded from folder compares; asserted explicitly where relevant.
const IGNORED_OUTPUT = new Set(['.cyan_state.yaml']);
const IGNORED_OUTPUT_DIRS = ['.cyan_conflicts/'];

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const rel = relative(dir, path)
          .split(/[\\/]+/)
          .join('/');
        if (IGNORED_OUTPUT.has(rel) || IGNORED_OUTPUT_DIRS.some(prefix => rel.startsWith(prefix))) {
          continue;
        }
        files.push(rel);
      }
    }
  };
  await walk(dir);
  return files.sort();
}

/**
 * Compare a generated output folder against an expected folder, file by file.
 * Returns a list of human-readable differences (empty = match).
 * Set E2E_UPDATE_EXPECTED=1 to rewrite the expected folder from the actual output instead.
 */
export async function diffAgainstExpected(actualDir: string, expectedDir: string): Promise<string[]> {
  if (process.env.E2E_UPDATE_EXPECTED === '1') {
    if (!expectedDir.startsWith('e2e/full-stack/expected/')) {
      // Never rewrite folders the e2e does not own (e.g. a template's own test fixtures).
      throw new Error(`E2E_UPDATE_EXPECTED may only rewrite e2e/full-stack/expected/*, got: ${expectedDir}`);
    }
    await rm(expectedDir, { recursive: true, force: true });
    await mkdir(expectedDir, { recursive: true });
    for (const rel of await listFiles(actualDir)) {
      await mkdir(join(expectedDir, rel, '..'), { recursive: true });
      await cp(join(actualDir, rel), join(expectedDir, rel));
    }
    return [];
  }
  const actual = await listFiles(actualDir);
  const expected = await listFiles(expectedDir);
  const differences: string[] = [];
  for (const rel of expected) {
    if (!actual.includes(rel)) {
      differences.push(`missing: ${rel}`);
    }
  }
  for (const rel of actual) {
    if (!expected.includes(rel)) {
      differences.push(`unexpected: ${rel}`);
    }
  }
  for (const rel of expected) {
    if (!actual.includes(rel)) {
      continue;
    }
    const [actualBytes, expectedBytes] = await Promise.all([
      readFile(join(actualDir, rel)),
      readFile(join(expectedDir, rel)),
    ]);
    if (!actualBytes.equals(expectedBytes)) {
      differences.push(`content mismatch: ${rel}\n--- expected\n${expectedBytes}\n--- actual\n${actualBytes}`);
    }
  }
  return differences;
}
