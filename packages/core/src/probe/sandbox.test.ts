import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProbeSetupError, prepareProbeSandboxSource } from './sandbox';

/** Run a git command in `cwd`, returning its exit code and trimmed stdout. */
async function gitRun(cwd: string, cliArgs: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['git', ...cliArgs], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout: stdout.trim() };
}

let workRoot: string;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-sandbox-test-'));
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

let repoCounter = 0;

/** A tiny "materialized generated repo": plain directory, no .git. */
async function makeRepo(): Promise<string> {
  repoCounter += 1;
  const repo = join(workRoot, `repo-${repoCounter}`);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/app.txt'), 'app v1\n', 'utf8');
  await writeFile(join(repo, 'README.md'), '# repo\n', 'utf8');
  await writeFile(join(repo, '.gitignore'), 'deps/\n', 'utf8');
  return repo;
}

/** All file paths (relative) → content, excluding .git and any given prefixes. */
async function readTreeMap(root: string, exclude: string[] = []): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const paths = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: root, onlyFiles: true, dot: true }));
  for (const path of paths) {
    if (path.startsWith('.git/') || exclude.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) {
      continue;
    }
    map.set(path, await readFile(join(root, path), 'utf8'));
  }
  return map;
}

async function sabotage(sandboxPath: string): Promise<void> {
  await writeFile(join(sandboxPath, 'src/app.txt'), 'sabotaged\n', 'utf8');
  await rm(join(sandboxPath, 'README.md'));
  await writeFile(join(sandboxPath, 'planted.txt'), 'planted\n', 'utf8');
  await mkdir(join(sandboxPath, 'planted-dir'), { recursive: true });
  await writeFile(join(sandboxPath, 'planted-dir/inner.txt'), 'inner\n', 'utf8');
}

describe('probe sandbox — snapshot/restore (AC1)', () => {
  for (const strategy of ['git', 'fs'] as const) {
    test(`${strategy} strategy round-trips: sabotage + restore byte-matches the snapshot`, async () => {
      const repo = await makeRepo();
      const source = await prepareProbeSandboxSource({
        repoPath: repo,
        sandbox: { snapshot: strategy, preserve: ['deps'] },
      });
      try {
        expect(source.strategy).toBe(strategy);
        const snapshotTree = await readTreeMap(source.snapshotPath);
        const run = await source.createRun();

        await sabotage(run.path);
        expect(await readTreeMap(run.path, ['deps'])).not.toEqual(snapshotTree);

        await run.restore();
        expect(await readTreeMap(run.path, ['deps'])).toEqual(snapshotTree);
      } finally {
        await source.dispose();
      }
    });

    test(`${strategy} strategy: preserved run outputs (node_modules-like dir) survive restore`, async () => {
      const repo = await makeRepo();
      const source = await prepareProbeSandboxSource({
        repoPath: repo,
        sandbox: { snapshot: strategy, preserve: ['deps'] },
      });
      try {
        const run = await source.createRun();
        // A dependency-cache-like output produced INSIDE the run (post-snapshot),
        // gitignored via the repo's .gitignore and listed in preserve.
        await mkdir(join(run.path, 'deps/pkg'), { recursive: true });
        await writeFile(join(run.path, 'deps/pkg/lib.txt'), 'installed\n', 'utf8');

        await sabotage(run.path);
        await run.restore();

        expect(await readFile(join(run.path, 'deps/pkg/lib.txt'), 'utf8')).toBe('installed\n');
        expect(await readTreeMap(run.path, ['deps'])).toEqual(await readTreeMap(source.snapshotPath));
      } finally {
        await source.dispose();
      }
    });
  }

  test('git strategy: STAGED (index) mutations do not survive restore (byte-exact)', async () => {
    // Regression: `git checkout -- .` restores from the mutable index, so a probe
    // that runs `git add -A` on its sabotage would leave staged changes behind.
    // `git reset --hard HEAD` discards the index too — the restore is byte-exact.
    const repo = await makeRepo();
    const source = await prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'git' } });
    try {
      const snapshotTree = await readTreeMap(source.snapshotPath);
      const run = await source.createRun();

      // Sabotage AND stage it into the index (the vector `checkout -- .` misses).
      await writeFile(join(run.path, 'src/app.txt'), 'staged sabotage\n', 'utf8');
      await writeFile(join(run.path, 'staged-new.txt'), 'staged new file\n', 'utf8');
      await rm(join(run.path, 'README.md'));
      const staged = Bun.spawn(['git', 'add', '-A'], { cwd: run.path, stdout: 'pipe', stderr: 'pipe' });
      expect(await staged.exited).toBe(0);

      await run.restore();
      expect(await readTreeMap(run.path)).toEqual(snapshotTree);
    } finally {
      await source.dispose();
    }
  });

  test('fs strategy: a preserved path under a SYMLINKED parent is refused, external target untouched', async () => {
    // Regression: `restoreFsSandbox` validated preserved paths with
    // only `safeJoin` (a textual check). If a parent component inside the sandbox is
    // a symlink to an external directory, `rename`/`rm` would FOLLOW it and park or
    // delete the external file — and a later failure would then lose it with the
    // parking dir. The restore must refuse a preserved path with a symlinked parent
    // BEFORE touching anything, leaving the external target intact.
    repoCounter += 1;
    const external = join(workRoot, `escape-external-${repoCounter}`);
    await mkdir(external, { recursive: true });
    await writeFile(join(external, 'token'), 'external-secret\n', 'utf8');

    // A materialized repo whose `cache` entry is a symlink to the external dir.
    const repo = join(workRoot, `escape-repo-${repoCounter}`);
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src/app.txt'), 'app v1\n', 'utf8');
    await symlink(external, join(repo, 'cache'));

    const source = await prepareProbeSandboxSource({
      repoPath: repo,
      // preserve names a path THROUGH the symlinked `cache` parent.
      sandbox: { snapshot: 'fs', preserve: ['cache/token'] },
    });
    try {
      const run = await source.createRun();
      // The restore refuses rather than following the symlink out of the sandbox.
      await expect(run.restore()).rejects.toThrow(/symlink/i);
      // The external file is byte-for-byte intact: nothing was parked, moved, or removed.
      expect(await readFile(join(external, 'token'), 'utf8')).toBe('external-secret\n');
    } finally {
      await source.dispose();
    }
  });

  test('auto strategy resolves to git when git is available', async () => {
    const repo = await makeRepo();
    const source = await prepareProbeSandboxSource({ repoPath: repo });
    try {
      // The dev/CI environment always has git; auto must pick it, not silently degrade.
      expect(source.strategy).toBe('git');
    } finally {
      await source.dispose();
    }
  });

  test('the original repo is never touched (runs operate on copies)', async () => {
    const repo = await makeRepo();
    const before = await readTreeMap(repo);
    const source = await prepareProbeSandboxSource({
      repoPath: repo,
      setup: { pre: ['echo pre > pre-marker.txt'], post: ['echo post > post-marker.txt'] },
    });
    try {
      const run = await source.createRun();
      await sabotage(run.path);
      expect(await readTreeMap(repo)).toEqual(before);
    } finally {
      await source.dispose();
    }
  });

  test('git strategy: a LINKED WORKTREE repoPath never touches the original repo', async () => {
    // A linked worktree's `.git` is a POINTER FILE to the original repo's gitdir,
    // not a directory. Copying it verbatim and running `git add`/`commit` against
    // the copy would operate on the ORIGINAL worktree's shared index and branch —
    // advancing its HEAD and staging the snapshot's contents. `freezeGitSnapshot`
    // must discard the copied `.git` and `git init` a fresh, independent repo so
    // the original is never touched (FR9).
    repoCounter += 1;
    const origin = join(workRoot, `wt-origin-${repoCounter}`);
    await mkdir(join(origin, 'src'), { recursive: true });
    await writeFile(join(origin, 'src/app.txt'), 'app v1\n', 'utf8');
    await writeFile(join(origin, 'README.md'), '# repo\n', 'utf8');
    expect((await gitRun(origin, ['init', '-q'])).code).toBe(0);
    await gitRun(origin, ['config', 'user.email', 'origin@localhost']);
    await gitRun(origin, ['config', 'user.name', 'origin']);
    await gitRun(origin, ['config', 'commit.gpgsign', 'false']);
    await gitRun(origin, ['add', '-A']);
    expect((await gitRun(origin, ['commit', '-q', '-m', 'origin init'])).code).toBe(0);

    // Add a LINKED worktree — its `.git` is the pointer file that triggers the bug.
    const worktree = join(workRoot, `wt-linked-${repoCounter}`);
    expect((await gitRun(origin, ['worktree', 'add', '-q', worktree])).code).toBe(0);
    expect((await stat(join(worktree, '.git'))).isFile()).toBe(true);

    // The linked worktree shares its index/HEAD with the original repo's metadata,
    // so corruption shows here: capture its exact state before the sandbox runs.
    const headBefore = (await gitRun(worktree, ['rev-parse', 'HEAD'])).stdout;
    const statusBefore = (await gitRun(worktree, ['status', '--porcelain'])).stdout;
    const commitCountBefore = (await gitRun(worktree, ['rev-list', '--count', 'HEAD'])).stdout;

    const source = await prepareProbeSandboxSource({ repoPath: worktree, sandbox: { snapshot: 'git' } });
    try {
      expect(source.strategy).toBe('git');
      const snapshotTree = await readTreeMap(source.snapshotPath);
      const run = await source.createRun();
      await sabotage(run.path);
      await run.restore();

      // The snapshot committed inside its OWN fresh repo: the linked worktree's
      // HEAD, staged index, and history are all exactly as they were.
      expect((await gitRun(worktree, ['rev-parse', 'HEAD'])).stdout).toBe(headBefore);
      expect((await gitRun(worktree, ['status', '--porcelain'])).stdout).toBe(statusBefore);
      expect((await gitRun(worktree, ['rev-list', '--count', 'HEAD'])).stdout).toBe(commitCountBefore);
      // …and snapshot/restore still works byte-exact on a worktree input.
      expect(await readTreeMap(run.path)).toEqual(snapshotTree);
    } finally {
      await source.dispose();
    }
  });
});

describe('probe sandbox — two-phase setup (AC3)', () => {
  test('setup.pre runs exactly once; setup.post runs once per restore (fork + in-place)', async () => {
    const repo = await makeRepo();
    const counters = await mkdtemp(join(workRoot, 'counters-'));
    const preCounter = join(counters, 'pre.log');
    const postCounter = join(counters, 'post.log');
    const source = await prepareProbeSandboxSource({
      repoPath: repo,
      setup: {
        pre: [`echo ran >> '${preCounter}'`, 'echo pre-output > pre-output.txt'],
        post: [`echo ran >> '${postCounter}'`],
      },
    });
    try {
      const runA = await source.createRun();
      const runB = await source.createRun();
      await sabotage(runA.path);
      await runA.restore();

      // pre = 1 (frozen into the snapshot), post = 3 (fork A, fork B, restore A).
      expect((await readFile(preCounter, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);
      expect((await readFile(postCounter, 'utf8')).split('\n').filter(Boolean)).toHaveLength(3);

      // The pre phase's output is part of the snapshot: present in every sandbox,
      // including after a restore.
      expect(await readFile(join(runA.path, 'pre-output.txt'), 'utf8')).toBe('pre-output\n');
      expect(await readFile(join(runB.path, 'pre-output.txt'), 'utf8')).toBe('pre-output\n');
    } finally {
      await source.dispose();
    }
  });

  test('a failing setup command surfaces as a loud ProbeSetupError', async () => {
    const repo = await makeRepo();
    expect(
      prepareProbeSandboxSource({
        repoPath: repo,
        setup: { pre: ['echo doomed >&2; exit 7'] },
      }),
    ).rejects.toThrow(ProbeSetupError);
  });
});
