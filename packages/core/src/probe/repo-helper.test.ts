import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exists } from '../util';
import { createProbeRepo, ProbeRepoOpError } from './repo-helper';

// Regression: ProbeRepo path guards must resolve symlinks, not just do
// textual containment. A symlink INSIDE the sandbox pointing outside it must not
// let a probe read / patch / remove files beyond the repo. `write` already used
// realpath-aware guards; read/remove/patch now match.

let workRoot: string;
let caseCounter = 0;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-repo-helper-test-'));
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

/** A sandbox + an "outside" tree with a secret, and links from inside to outside. */
async function makeSandbox(): Promise<{ sandbox: string; outsideDir: string; outsideFile: string }> {
  caseCounter += 1;
  const base = join(workRoot, `case-${caseCounter}`);
  const sandbox = join(base, 'sandbox');
  const outsideDir = join(base, 'outside');
  await mkdir(join(sandbox, 'src'), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(sandbox, 'src/app.txt'), 'app v1\n', 'utf8');
  const outsideFile = join(outsideDir, 'secret.txt');
  await writeFile(outsideFile, 'TOP SECRET\n', 'utf8');
  return { sandbox, outsideDir, outsideFile };
}

describe('ProbeRepo symlink escapes', () => {
  test('read refuses a symlink LEAF that points outside the sandbox', async () => {
    const { sandbox, outsideFile } = await makeSandbox();
    await symlink(outsideFile, join(sandbox, 'leak.txt'));
    const repo = createProbeRepo(sandbox);
    await expect(repo.read('leak.txt')).rejects.toBeInstanceOf(ProbeRepoOpError);
    await expect(repo.read('leak.txt')).rejects.toThrow(/symlink/);
  });

  test('read refuses a symlinked PARENT directory that points outside the sandbox', async () => {
    const { sandbox, outsideDir } = await makeSandbox();
    await symlink(outsideDir, join(sandbox, 'linkdir'));
    const repo = createProbeRepo(sandbox);
    await expect(repo.read('linkdir/secret.txt')).rejects.toThrow(/symlink/);
  });

  test('patch refuses a symlink that points outside the sandbox (no write escape)', async () => {
    const { sandbox, outsideFile } = await makeSandbox();
    await symlink(outsideFile, join(sandbox, 'leak.txt'));
    const repo = createProbeRepo(sandbox);
    await expect(repo.patch('leak.txt', { find: 'SECRET', replace: 'LEAKED' })).rejects.toThrow(/symlink/);
    // The outside file is untouched.
    expect(await readFile(outsideFile, 'utf8')).toBe('TOP SECRET\n');
  });

  test('remove refuses a symlinked PARENT (would unlink outside the sandbox)', async () => {
    const { sandbox, outsideDir, outsideFile } = await makeSandbox();
    await symlink(outsideDir, join(sandbox, 'linkdir'));
    const repo = createProbeRepo(sandbox);
    await expect(repo.remove('linkdir/secret.txt')).rejects.toThrow(/symlink/);
    // The outside file survived.
    expect(await readFile(outsideFile, 'utf8')).toBe('TOP SECRET\n');
  });

  test('remove of a symlink LEAF removes the link, never the target', async () => {
    const { sandbox, outsideFile } = await makeSandbox();
    await symlink(outsideFile, join(sandbox, 'leak.txt'));
    const repo = createProbeRepo(sandbox);
    // Removing the link itself is allowed and does NOT delete the outside target.
    await repo.remove('leak.txt');
    expect(await readFile(outsideFile, 'utf8')).toBe('TOP SECRET\n');
  });

  test('normal in-sandbox read/write/patch/remove still work', async () => {
    const { sandbox } = await makeSandbox();
    const repo = createProbeRepo(sandbox);
    expect(await repo.read('src/app.txt')).toBe('app v1\n');
    await repo.write('src/new.txt', 'created\n');
    expect(await repo.read('src/new.txt')).toBe('created\n');
    await repo.patch('src/app.txt', { find: 'v1', replace: 'v2' });
    expect(await repo.read('src/app.txt')).toBe('app v2\n');
    await repo.remove('src/new.txt');
    await expect(repo.read('src/new.txt')).rejects.toBeInstanceOf(ProbeRepoOpError);
  });

  test('textual sandbox escape (../) is still refused', async () => {
    const { sandbox } = await makeSandbox();
    const repo = createProbeRepo(sandbox);
    await expect(repo.read('../outside/secret.txt')).rejects.toThrow(/escapes the sandbox/);
  });
});

// Regression: `glob` was the one ProbeRepo filesystem method without
// containment — `Bun.Glob('../*').scan({ cwd })` resolves above the sandbox and an
// absolute pattern ignores `cwd` entirely. Patterns are now validated up front and
// results post-checked, sharing the policy of read/write/remove/patch.
describe('ProbeRepo glob containment', () => {
  test('glob refuses a `..` pattern that escapes the sandbox', async () => {
    const { sandbox } = await makeSandbox();
    const repo = createProbeRepo(sandbox);
    await expect(repo.glob('../outside/*')).rejects.toBeInstanceOf(ProbeRepoOpError);
    await expect(repo.glob('../outside/*')).rejects.toThrow(/escapes the sandbox/);
  });

  test('glob refuses a `..` segment buried mid-pattern', async () => {
    const { sandbox } = await makeSandbox();
    const repo = createProbeRepo(sandbox);
    await expect(repo.glob('src/../../outside/*.txt')).rejects.toThrow(/escapes the sandbox/);
  });

  test('glob refuses a `..` hidden in a brace alternation', async () => {
    const { sandbox } = await makeSandbox();
    const repo = createProbeRepo(sandbox);
    await expect(repo.glob('{..,src}/*.txt')).rejects.toThrow(/escapes the sandbox/);
  });

  test('glob refuses an absolute pattern', async () => {
    const { sandbox, outsideDir } = await makeSandbox();
    const repo = createProbeRepo(sandbox);
    await expect(repo.glob(join(outsideDir, '*.txt'))).rejects.toThrow(/escapes the sandbox/);
  });

  test('glob does not traverse a symlinked directory pointing outside the sandbox', async () => {
    const { sandbox, outsideDir } = await makeSandbox();
    await symlink(outsideDir, join(sandbox, 'linkdir'));
    const repo = createProbeRepo(sandbox);
    // Bun.Glob.scan does not follow symlinked dirs, so the outside secret never
    // surfaces — through the link explicitly or via a recursive wildcard.
    expect(await repo.glob('linkdir/*.txt')).toEqual([]);
    expect(await repo.glob('**/*.txt')).toEqual(['src/app.txt']);
  });

  test('normal in-sandbox globbing still works, including dotted names', async () => {
    const { sandbox } = await makeSandbox();
    await writeFile(join(sandbox, 'src/notes..txt'), 'dots\n', 'utf8');
    const repo = createProbeRepo(sandbox);
    // `..` as part of a name (not a whole segment) is a legitimate match.
    expect(await repo.glob('src/*.txt')).toEqual(['src/app.txt', 'src/notes..txt']);
    expect(await repo.glob('**/app.txt')).toEqual(['src/app.txt']);
  });
});

// Regression: in the isolated runner path `exec` runs `detached: false`
// so gate commands share the runner's process group. A per-command `timeoutMs`
// therefore cannot group-kill (that would take the runner and its siblings down);
// the old code killed only the direct shell, leaving a backgrounded descendant
// alive to mutate the sandbox after the command deadline. It now kills the
// command's whole process subtree instead.
describe('ProbeRepo command timeout kills the whole subtree in runner mode', () => {
  test('a backgrounded descendant is killed at the command deadline, never mutates the sandbox after it', async () => {
    const { sandbox } = await makeSandbox();
    // Non-detached, exactly as the isolated runner constructs the repo.
    const repo = createProbeRepo(sandbox, { detached: false });

    // The shell backgrounds a descendant that would write `late.txt` at ~1500ms —
    // well AFTER the 500ms command timeout — then blocks so the shell (and its
    // children) are all alive when the timeout fires. With only a shell-kill the
    // backgrounded subshell survives and writes; a subtree-kill stops it first.
    const startedAt = Date.now();
    const result = await repo.exec('(sleep 1.5; echo late > late.txt) & sleep 30', { timeoutMs: 500 });
    const elapsed = Date.now() - startedAt;

    // The command returned at its deadline, not after the 30s foreground sleep.
    expect(elapsed).toBeLessThan(3_000);
    expect(result.exitCode).not.toBe(0);

    // Wait past when the descendant WOULD have written, then assert it never did.
    await Bun.sleep(2_500);
    expect(await exists(join(sandbox, 'late.txt'))).toBe(false);
  }, 15_000);
});

// Containment boundary (FR10/FR11 resolution, 2026-07-04, option 2): the subtree
// kill above is the FULL extent of the per-command timeout guarantee. Descendants
// that escape it — a worker reparented to init by an exiting intermediate shell
// (broken PPID chain), or a `setsid` daemon in a brand-new session and group — can
// only be tracked through an engine-injected environment marker, which FR11's
// strictly-untouched command environment forbids. Those escapes are therefore a
// DOCUMENTED, out-of-scope limitation (see `spawn.ts` / the `ProbeRepo.exec`
// contract), and deliberately have no orphan-free assertions here. The timeout
// BOUNDARY still holds regardless: `exec` returns at its deadline.
describe('ProbeRepo command timeout boundary holds even when a descendant escapes the subtree (FR11 boundary)', () => {
  test('exec returns at the deadline even with a reparented descendant left running', async () => {
    const { sandbox } = await makeSandbox();
    const repo = createProbeRepo(sandbox, { detached: false });

    // The intermediate `(… &)` subshell exits immediately, reparenting its worker
    // to init before the timeout fires. The kill cannot reach it (documented
    // limitation) — but the command itself must still return at its deadline,
    // not after the 30s foreground sleep.
    const startedAt = Date.now();
    const result = await repo.exec("(sh -c 'echo alive > alive.txt; sleep 1.5' &) & sleep 30", {
      timeoutMs: 500,
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(10_000);
    expect(result.exitCode).not.toBe(0);
  }, 20_000);
});
