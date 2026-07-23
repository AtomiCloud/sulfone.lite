import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

  test('git restore cannot be redirected outside the sandbox through mutable core.worktree config', async () => {
    const repo = await makeRepo();
    const outside = join(workRoot, `outside-worktree-${++repoCounter}`);
    await mkdir(join(outside, 'src'), { recursive: true });
    await writeFile(join(outside, 'src/app.txt'), 'outside app\n', 'utf8');
    await writeFile(join(outside, 'keep.txt'), 'outside keep\n', 'utf8');

    const source = await prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'git' } });
    try {
      const run = await source.createRun();
      expect((await gitRun(run.path, ['config', 'core.worktree', outside])).code).toBe(0);
      await writeFile(join(run.path, 'src/app.txt'), 'sabotaged\n', 'utf8');

      await run.restore();

      expect(await readFile(join(run.path, 'src/app.txt'), 'utf8')).toBe('app v1\n');
      expect(await readFile(join(outside, 'src/app.txt'), 'utf8')).toBe('outside app\n');
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside keep\n');
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

  test('exclude globs skip source artifacts and setup.pre can recreate them untracked', async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, 'deps/source-only'), { recursive: true });
    await writeFile(join(repo, 'deps/source-only/bulk.txt'), 'do not snapshot\n', 'utf8');

    const source = await prepareProbeSandboxSource({
      repoPath: repo,
      sandbox: { snapshot: 'git', exclude: ['deps/**'] },
      setup: { pre: ['mkdir -p deps/restored && echo restored > deps/restored/cache.txt'] },
    });
    try {
      expect(await Bun.file(join(source.snapshotPath, 'deps/source-only/bulk.txt')).exists()).toBe(false);
      expect(await readFile(join(source.snapshotPath, 'deps/restored/cache.txt'), 'utf8')).toBe('restored\n');
      expect((await gitRun(source.snapshotPath, ['ls-files', 'deps'])).stdout).toBe('');

      const run = await source.createRun();
      expect(await readFile(join(run.path, 'deps/restored/cache.txt'), 'utf8')).toBe('restored\n');
      await writeFile(join(run.path, 'deps/restored/cache.txt'), 'mutated\n', 'utf8');
      await writeFile(join(run.path, 'deps/restored/extra.txt'), 'extra\n', 'utf8');
      await run.restore();
      expect(await readFile(join(run.path, 'deps/restored/cache.txt'), 'utf8')).toBe('restored\n');
      expect(await Bun.file(join(run.path, 'deps/restored/extra.txt')).exists()).toBe(false);
    } finally {
      await source.dispose();
    }
  });

  test('Git-root exclude globs omit tracked paths and setup.pre can recreate the ignored root', async () => {
    repoCounter += 1;
    const repo = join(workRoot, `git-exclude-source-${repoCounter}`);
    await mkdir(join(repo, 'dist'), { recursive: true });
    await writeFile(join(repo, '.gitignore'), 'dist/\n', 'utf8');
    await writeFile(join(repo, 'keep.txt'), 'keep\n', 'utf8');
    await writeFile(join(repo, 'dist/tracked.txt'), 'exclude me\n', 'utf8');
    expect((await gitRun(repo, ['init', '-q'])).code).toBe(0);
    await gitRun(repo, ['config', 'user.email', 'origin@localhost']);
    await gitRun(repo, ['config', 'user.name', 'origin']);
    await gitRun(repo, ['config', 'commit.gpgsign', 'false']);
    await gitRun(repo, ['add', '.gitignore', 'keep.txt']);
    await gitRun(repo, ['add', '-f', 'dist/tracked.txt']);
    expect((await gitRun(repo, ['commit', '-q', '-m', 'Git exclude source'])).code).toBe(0);

    const source = await prepareProbeSandboxSource({
      repoPath: repo,
      sandbox: { snapshot: 'git', exclude: ['dist/**'] },
      setup: { pre: ['mkdir -p dist && echo recreated > dist/recreated.txt'] },
    });
    try {
      expect(await Bun.file(join(source.snapshotPath, 'dist/tracked.txt')).exists()).toBe(false);
      expect(await readFile(join(source.snapshotPath, 'dist/recreated.txt'), 'utf8')).toBe('recreated\n');
      expect((await gitRun(source.snapshotPath, ['ls-files', 'dist'])).stdout).toBe('');
    } finally {
      await source.dispose();
    }
  });

  test('git restore recreates an ignored empty directory from setup.pre', async () => {
    const repo = await makeRepo();
    const source = await prepareProbeSandboxSource({
      repoPath: repo,
      sandbox: { snapshot: 'git' },
      setup: { pre: ['mkdir -p deps/empty'] },
    });
    try {
      const run = await source.createRun();
      await rm(join(run.path, 'deps/empty'), { recursive: true });
      await run.restore();
      expect((await stat(join(run.path, 'deps/empty'))).isDirectory()).toBe(true);
    } finally {
      await source.dispose();
    }
  });

  test('git restore overlays ignored setup.pre state without erasing setup.post-only children', async () => {
    const repo = await makeRepo();
    const source = await prepareProbeSandboxSource({
      repoPath: repo,
      sandbox: { snapshot: 'git' },
      setup: {
        pre: ['mkdir -p deps && echo pre > deps/pre.txt'],
        post: [
          'if [ -f deps/post.txt ]; then echo warm > deps/status.txt; else echo cold > deps/status.txt; fi; echo post > deps/post.txt',
        ],
      },
    });
    try {
      const run = await source.createRun();
      expect(await readFile(join(run.path, 'deps/status.txt'), 'utf8')).toBe('cold\n');
      await writeFile(join(run.path, 'deps/pre.txt'), 'sabotaged\n', 'utf8');

      await run.restore();

      expect(await readFile(join(run.path, 'deps/pre.txt'), 'utf8')).toBe('pre\n');
      expect(await readFile(join(run.path, 'deps/post.txt'), 'utf8')).toBe('post\n');
      expect(await readFile(join(run.path, 'deps/status.txt'), 'utf8')).toBe('warm\n');
    } finally {
      await source.dispose();
    }
  });

  test('Git materialization rejects submodule gitlinks instead of silently omitting them', async () => {
    const repo = await makeRepo();
    expect((await gitRun(repo, ['init', '-q'])).code).toBe(0);
    await gitRun(repo, ['config', 'user.email', 'origin@localhost']);
    await gitRun(repo, ['config', 'user.name', 'origin']);
    await gitRun(repo, ['config', 'commit.gpgsign', 'false']);
    await gitRun(repo, ['add', '-A']);
    expect((await gitRun(repo, ['commit', '-q', '-m', 'source init'])).code).toBe(0);
    expect(
      (await gitRun(repo, ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/submodule`])).code,
    ).toBe(0);
    expect((await gitRun(repo, ['commit', '-q', '-m', 'add gitlink'])).code).toBe(0);

    await expect(prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'git' } })).rejects.toThrow(
      /cannot materialize Git commit entry "vendor\/submodule".*submodule\/gitlink/,
    );
  });

  test('an unborn Git root fails loudly instead of falling back to a live filesystem copy', async () => {
    const repo = await makeRepo();
    expect((await gitRun(repo, ['init', '-q'])).code).toBe(0);

    await expect(prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'git' } })).rejects.toThrow(
      /rev-parse --verify HEAD\^\{tree\} failed/,
    );
  });

  test('non-UTF-8 Git path bytes fail loudly instead of materializing a replacement pathname', async () => {
    const repo = await makeRepo();
    const nonUtf8Path = Buffer.concat([Buffer.from(`${repo}/invalid-`), Buffer.from([0xff])]);
    await writeFile(nonUtf8Path, 'raw path\n', 'utf8');
    expect((await gitRun(repo, ['init', '-q'])).code).toBe(0);
    await gitRun(repo, ['config', 'user.email', 'origin@localhost']);
    await gitRun(repo, ['config', 'user.name', 'origin']);
    await gitRun(repo, ['config', 'commit.gpgsign', 'false']);
    await gitRun(repo, ['add', '-A']);
    expect((await gitRun(repo, ['commit', '-q', '-m', 'non-UTF-8 path'])).code).toBe(0);

    await expect(prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'git' } })).rejects.toThrow(
      /cannot materialize non-UTF-8 Git paths/,
    );
  });

  test('git inputs checkout the exact committed tree, omit ignored artifacts, and seal one pack', async () => {
    repoCounter += 1;
    const repo = join(workRoot, `archive-source-${repoCounter}`);
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(join(repo, 'node_modules/pkg'), { recursive: true });
    await mkdir(join(repo, 'vendor'), { recursive: true });
    await writeFile(join(repo, 'src/app.txt'), 'tracked\n', 'utf8');
    await writeFile(join(repo, 'vendor/kept.txt'), 'tracked despite ignore\n', 'utf8');
    await writeFile(join(repo, 'subst.txt'), '$Format:%H$\n', 'utf8');
    await writeFile(join(repo, 'filtered.txt'), 'original\n', 'utf8');
    await writeFile(join(repo, 'eol.txt'), 'line one\nline two\n', 'utf8');
    await writeFile(
      join(repo, '.gitattributes'),
      'src/app.txt export-ignore\nsubst.txt export-subst\nfiltered.txt filter=poison\neol.txt text eol=crlf\n',
      'utf8',
    );
    await writeFile(join(repo, '.gitignore'), 'node_modules/\nvendor/\n', 'utf8');
    await writeFile(join(repo, 'node_modules/pkg/bulk.js'), 'ignored\n', 'utf8');
    expect((await gitRun(repo, ['init', '-q'])).code).toBe(0);
    await gitRun(repo, ['config', 'user.email', 'origin@localhost']);
    await gitRun(repo, ['config', 'user.name', 'origin']);
    await gitRun(repo, ['config', 'commit.gpgsign', 'false']);
    await gitRun(repo, ['add', '-A']);
    await gitRun(repo, ['add', '-f', 'vendor/kept.txt']);
    expect((await gitRun(repo, ['commit', '-q', '-m', 'source init'])).code).toBe(0);
    await gitRun(repo, ['config', 'core.autocrlf', 'true']);
    await gitRun(repo, ['config', 'filter.poison.smudge', 'sed s/original/poisoned/']);

    const configEnv = {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'filter.poison.clean',
      GIT_CONFIG_VALUE_0: 'sed s/original/cleaned/',
      GIT_CONFIG_KEY_1: 'filter.poison.smudge',
      GIT_CONFIG_VALUE_1: 'sed s/original/poisoned/',
      GIT_CONFIG_KEY_2: 'core.autocrlf',
      GIT_CONFIG_VALUE_2: 'true',
    };
    const previousEnv = new Map(Object.keys(configEnv).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(configEnv)) {
      process.env[key] = value;
    }
    let source: Awaited<ReturnType<typeof prepareProbeSandboxSource>> | undefined;
    try {
      source = await prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'git' } });
      expect(await Bun.file(join(source.snapshotPath, 'src/app.txt')).text()).toBe('tracked\n');
      expect(await Bun.file(join(source.snapshotPath, 'vendor/kept.txt')).text()).toBe('tracked despite ignore\n');
      expect((await gitRun(source.snapshotPath, ['ls-files', 'vendor/kept.txt'])).stdout).toBe('vendor/kept.txt');
      expect(await Bun.file(join(source.snapshotPath, 'subst.txt')).text()).toBe('$Format:%H$\n');
      expect(await Bun.file(join(source.snapshotPath, 'filtered.txt')).text()).toBe('original\n');
      expect(await Bun.file(join(source.snapshotPath, 'eol.txt')).text()).toBe('line one\nline two\n');
      expect(await Bun.file(join(source.snapshotPath, 'node_modules/pkg/bulk.js')).exists()).toBe(false);
      const packs = (await readdir(join(source.snapshotPath, '.git/objects/pack'))).filter(name =>
        name.endsWith('.pack'),
      );
      expect(packs).toHaveLength(1);
      const looseObjectDirs = (await readdir(join(source.snapshotPath, '.git/objects'))).filter(name =>
        /^[0-9a-f]{2}$/.test(name),
      );
      expect(looseObjectDirs).toEqual([]);
      const run = await source.createRun();
      await writeFile(join(run.path, 'filtered.txt'), 'mutated\n', 'utf8');
      await writeFile(join(run.path, 'eol.txt'), 'mutated\r\n', 'utf8');
      await run.restore();
      expect(await Bun.file(join(run.path, 'filtered.txt')).text()).toBe('original\n');
      expect(await Bun.file(join(run.path, 'eol.txt')).text()).toBe('line one\nline two\n');
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await source?.dispose();
    }
  });

  test('a plain subdirectory inside an enclosing Git worktree snapshots only that directory', async () => {
    repoCounter += 1;
    const enclosing = join(workRoot, `enclosing-source-${repoCounter}`);
    const repo = join(enclosing, 'generated');
    await mkdir(repo, { recursive: true });
    await writeFile(join(enclosing, 'parent-only.txt'), 'parent\n', 'utf8');
    await writeFile(join(repo, 'app.txt'), 'generated\n', 'utf8');
    expect((await gitRun(enclosing, ['init', '-q'])).code).toBe(0);
    await gitRun(enclosing, ['config', 'user.email', 'origin@localhost']);
    await gitRun(enclosing, ['config', 'user.name', 'origin']);
    await gitRun(enclosing, ['config', 'commit.gpgsign', 'false']);
    await gitRun(enclosing, ['add', '-A']);
    expect((await gitRun(enclosing, ['commit', '-q', '-m', 'enclosing source'])).code).toBe(0);

    const source = await prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'git' } });
    try {
      expect(await readFile(join(source.snapshotPath, 'app.txt'), 'utf8')).toBe('generated\n');
      expect(await Bun.file(join(source.snapshotPath, 'parent-only.txt')).exists()).toBe(false);
      expect(await Bun.file(join(source.snapshotPath, 'generated/app.txt')).exists()).toBe(false);
    } finally {
      await source.dispose();
    }
  });

  test('snapshot checkout stays stable while a sibling worktree commits and repacks', async () => {
    repoCounter += 1;
    const origin = join(workRoot, `race-origin-${repoCounter}`);
    await mkdir(origin, { recursive: true });
    await writeFile(join(origin, 'stable.txt'), 'stable\n', 'utf8');
    expect((await gitRun(origin, ['init', '-q'])).code).toBe(0);
    await gitRun(origin, ['config', 'user.email', 'origin@localhost']);
    await gitRun(origin, ['config', 'user.name', 'origin']);
    await gitRun(origin, ['config', 'commit.gpgsign', 'false']);
    await gitRun(origin, ['add', '-A']);
    expect((await gitRun(origin, ['commit', '-q', '-m', 'stable source'])).code).toBe(0);

    const sibling = join(workRoot, `race-sibling-${repoCounter}`);
    expect((await gitRun(origin, ['worktree', 'add', '-q', '-b', `race-${repoCounter}`, sibling])).code).toBe(0);
    await writeFile(join(sibling, 'churn.txt'), 'churn\n', 'utf8');
    await gitRun(sibling, ['add', 'churn.txt']);
    expect((await gitRun(sibling, ['commit', '-q', '-m', 'concurrent churn'])).code).toBe(0);
    const wrapperDir = join(workRoot, `race-git-wrapper-${repoCounter}`);
    const wrapper = join(wrapperDir, 'git');
    const checkoutReady = join(wrapperDir, 'checkout-ready');
    const repackReady = join(wrapperDir, 'repack-ready');
    const realGit = Bun.which('git');
    if (!realGit) {
      throw new Error('git is required for the snapshot repack race regression');
    }
    await mkdir(wrapperDir, { recursive: true });
    await writeFile(
      wrapper,
      `#!/usr/bin/env sh
set -eu
is_checkout=0
for arg in "\$@"; do
  if [ "\$arg" = checkout-index ]; then is_checkout=1; fi
done
if [ "\$is_checkout" = 1 ]; then
  : > "\$CYANPRINT_CHECKOUT_READY"
  while [ ! -e "\$CYANPRINT_REPACK_READY" ]; do sleep 0.01; done
elif [ "\${1:-}" = repack ]; then
  : > "\$CYANPRINT_REPACK_READY"
  while [ ! -e "\$CYANPRINT_CHECKOUT_READY" ]; do sleep 0.01; done
fi
exec "\$CYANPRINT_REAL_GIT" "\$@"
`,
      'utf8',
    );
    await chmod(wrapper, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}:${originalPath ?? ''}`;
    process.env.CYANPRINT_REPACK_READY = repackReady;
    process.env.CYANPRINT_CHECKOUT_READY = checkoutReady;
    process.env.CYANPRINT_REAL_GIT = realGit;
    let source: Awaited<ReturnType<typeof prepareProbeSandboxSource>> | undefined;
    try {
      const repack = Bun.spawn([wrapper, 'repack', '-adq'], {
        cwd: sibling,
        env: {
          ...process.env,
          CYANPRINT_REPACK_READY: repackReady,
          CYANPRINT_CHECKOUT_READY: checkoutReady,
          CYANPRINT_REAL_GIT: realGit,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      source = await prepareProbeSandboxSource({ repoPath: origin, sandbox: { snapshot: 'git' } });
      const [repackStderr, repackExit] = await Promise.all([new Response(repack.stderr).text(), repack.exited]);
      expect(repackExit, repackStderr).toBe(0);
      expect(await Bun.file(checkoutReady).exists()).toBe(true);
      expect(await Bun.file(repackReady).exists()).toBe(true);
      expect(await readFile(join(source.snapshotPath, 'stable.txt'), 'utf8')).toBe('stable\n');
      expect((await stat(join(source.snapshotPath, '.git'))).isDirectory()).toBe(true);
      expect(
        (await readdir(join(source.snapshotPath, '.git/objects/pack'))).filter(name => name.endsWith('.pack')),
      ).toHaveLength(1);
    } finally {
      process.env.PATH = originalPath;
      delete process.env.CYANPRINT_REPACK_READY;
      delete process.env.CYANPRINT_CHECKOUT_READY;
      delete process.env.CYANPRINT_REAL_GIT;
      await source?.dispose();
    }
  });

  test('plain-directory copy skips and warns when a child vanishes mid-walk', async () => {
    const repo = await makeRepo();
    const volatile = join(repo, 'volatile');
    await mkdir(volatile, { recursive: true });
    await writeFile(join(volatile, 'vanishing.txt'), 'temporary\n', 'utf8');

    let listedResolve!: () => void;
    const listed = new Promise<void>(resolve => {
      listedResolve = resolve;
    });
    let resumeCopy!: () => void;
    const resume = new Promise<void>(resolve => {
      resumeCopy = resolve;
    });
    const originalReaddir = fsPromises.readdir;
    const synchronizedReaddir = (async (...args: unknown[]) => {
      const entries = await (originalReaddir as unknown as (...callArgs: unknown[]) => Promise<unknown>)(...args);
      const path = args[0];
      if (path === volatile) {
        listedResolve();
        await resume;
      }
      return entries;
    }) as unknown as typeof fsPromises.readdir;
    const readdirSpy = spyOn(fsPromises, 'readdir').mockImplementation(synchronizedReaddir);
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
    let source: Awaited<ReturnType<typeof prepareProbeSandboxSource>> | undefined;
    try {
      const preparing = prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'fs' } });
      await listed;
      await rm(volatile, { recursive: true, force: true });
      resumeCopy();
      source = await preparing;
      expect(warning).toHaveBeenCalled();
      await expect(stat(join(source.snapshotPath, 'volatile'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resumeCopy();
      readdirSpy.mockRestore();
      warning.mockRestore();
      await source?.dispose();
    }
  });

  test('a sealed snapshot copy fails loudly when a child vanishes mid-walk', async () => {
    const repo = await makeRepo();
    const source = await prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'fs' } });
    const volatile = join(source.snapshotPath, 'volatile');
    await mkdir(volatile, { recursive: true });
    await writeFile(join(volatile, 'vanishing.txt'), 'sealed\n', 'utf8');

    let listedResolve!: () => void;
    const listed = new Promise<void>(resolve => {
      listedResolve = resolve;
    });
    let resumeCopy!: () => void;
    const resume = new Promise<void>(resolve => {
      resumeCopy = resolve;
    });
    const originalReaddir = fsPromises.readdir;
    const synchronizedReaddir = (async (...args: unknown[]) => {
      const entries = await (originalReaddir as unknown as (...callArgs: unknown[]) => Promise<unknown>)(...args);
      if (args[0] === volatile) {
        listedResolve();
        await resume;
      }
      return entries;
    }) as unknown as typeof fsPromises.readdir;
    const readdirSpy = spyOn(fsPromises, 'readdir').mockImplementation(synchronizedReaddir);
    try {
      const creating = source.createRun();
      await listed;
      await rm(join(volatile, 'vanishing.txt'));
      resumeCopy();
      await expect(creating).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resumeCopy();
      readdirSpy.mockRestore();
      await source.dispose();
    }
  });

  test('git ignored-root restore fails loudly when a sealed snapshot entry is missing', async () => {
    const repo = await makeRepo();
    const source = await prepareProbeSandboxSource({
      repoPath: repo,
      sandbox: { snapshot: 'git' },
      // `deps/` is gitignored, so it becomes an ignored snapshot root that every
      // restore rematerializes by copying it out of the sealed snapshot.
      setup: { pre: ['mkdir -p deps && echo dep > deps/lib.txt'] },
    });
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const run = await source.createRun();
      expect(await readFile(join(run.path, 'deps/lib.txt'), 'utf8')).toBe('dep\n');

      // Report an entry the sealed snapshot does not actually hold: deterministic
      // stand-in for a snapshot entry lost to a missing/ESTALE read mid-restore.
      const snapshotDeps = join(source.snapshotPath, 'deps');
      const originalReaddir = fsPromises.readdir;
      const phantomReaddir = (async (...args: unknown[]) => {
        const entries = await (originalReaddir as unknown as (...callArgs: unknown[]) => Promise<unknown>)(...args);
        return args[0] === snapshotDeps ? [...(entries as string[]), 'vanished.txt'] : entries;
      }) as unknown as typeof fsPromises.readdir;
      const readdirSpy = spyOn(fsPromises, 'readdir').mockImplementation(phantomReaddir);
      try {
        await expect(run.restore()).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        readdirSpy.mockRestore();
      }
      // Loud failure only — never a warn-and-omit that leaves a partial sandbox.
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      await source.dispose();
    }
  });

  test('git restore discards a probe-created ignored root absent from the snapshot', async () => {
    const repo = await makeRepo();
    const source = await prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'git' } });
    try {
      const run = await source.createRun();
      await mkdir(join(run.path, 'deps/probe-only'), { recursive: true });
      await writeFile(join(run.path, 'deps/probe-only/evil.txt'), 'leak\n', 'utf8');
      expect((await gitRun(join(run.path, 'deps/probe-only'), ['init', '-q'])).code).toBe(0);

      await run.restore();

      await expect(stat(join(run.path, 'deps'))).rejects.toMatchObject({ code: 'ENOENT' });
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
