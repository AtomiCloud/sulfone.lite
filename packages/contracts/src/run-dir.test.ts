import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  engineRunPath,
  makeEngineRunDir,
  markEngineRunDirRetained,
  reapAbandonedEngineRunDirs,
  resolveCyanRunDir,
} from './run-dir';

let workRoot: string;
const originalRunDir = process.env.CYANPRINT_RUN_DIR;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-run-dir-test-'));
});

afterEach(() => {
  if (originalRunDir === undefined) {
    delete process.env.CYANPRINT_RUN_DIR;
  } else {
    process.env.CYANPRINT_RUN_DIR = originalRunDir;
  }
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

/** A directory shaped exactly like one `makeEngineRunDir` allocates, for a chosen owner. */
async function plantRunDir(root: string, prefix: string, ownerPid: number, name = 'abc123'): Promise<string> {
  const dir = join(root, `${prefix}-p${ownerPid}-${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.txt'), 'live run state\n', 'utf8');
  return dir;
}

/** A pid that is certainly not running: spawn a process and wait for it to exit. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['true']);
  const pid = proc.pid;
  await proc.exited;
  // Wait for the kernel to reap it so `kill(pid, 0)` reports ESRCH rather than a zombie.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
    await Bun.sleep(10);
  }
  throw new Error(`pid ${pid} never exited`);
}

describe('resolveCyanRunDir', () => {
  test('prefers an explicit override, then the env var, then ~/.cyan/run', () => {
    process.env.CYANPRINT_RUN_DIR = '/env/run';
    expect(resolveCyanRunDir('/explicit/run')).toBe('/explicit/run');
    expect(resolveCyanRunDir()).toBe('/env/run');
    delete process.env.CYANPRINT_RUN_DIR;
    expect(resolveCyanRunDir()).toBe(join(homedir(), '.cyan', 'run'));
  });

  test('never resolves under the caller TMPDIR, which is the whole point (#24)', () => {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = '/tmp/nix-shell.9999';
    delete process.env.CYANPRINT_RUN_DIR;
    try {
      expect(resolveCyanRunDir().startsWith('/tmp/nix-shell.9999')).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previous;
      }
    }
  });
});

describe('makeEngineRunDir', () => {
  test('allocates under the run root and stamps the owning pid into the name', async () => {
    const root = join(workRoot, 'alloc');
    const dir = await makeEngineRunDir('cyanprint-probe', { root });
    expect(dir.startsWith(root)).toBe(true);
    expect(dir).toContain(`-p${process.pid}-`);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  test('engineRunPath returns a stable, non-pid-scoped child the reaper ignores', async () => {
    const root = join(workRoot, 'stable');
    const path = await engineRunPath('cyanprint-artifact-imports', root);
    expect(path).toBe(join(root, 'cyanprint-artifact-imports'));
    await mkdir(path, { recursive: true });
    expect(await reapAbandonedEngineRunDirs(root, { graceMs: 0 })).toEqual([]);
    expect((await stat(path)).isDirectory()).toBe(true);
  });
});

describe('reapAbandonedEngineRunDirs', () => {
  test('reaps a dead owner run dir once it is past the grace period', async () => {
    const root = join(workRoot, 'dead');
    await mkdir(root, { recursive: true });
    const abandoned = await plantRunDir(root, 'cyanprint-probe', await deadPid());

    expect(await reapAbandonedEngineRunDirs(root, { graceMs: 0 })).toEqual([abandoned]);
    expect(await readdir(root)).toEqual([]);
  });

  test('leaves a dead owner alone while it is still inside the grace period', async () => {
    const root = join(workRoot, 'grace');
    await mkdir(root, { recursive: true });
    await plantRunDir(root, 'cyanprint-probe', await deadPid());

    expect(await reapAbandonedEngineRunDirs(root, { graceMs: 60_000 })).toEqual([]);
    expect((await readdir(root)).length).toBe(1);
  });

  test('never touches a live owner — a concurrent run must survive another run sweeping', async () => {
    const root = join(workRoot, 'live');
    await mkdir(root, { recursive: true });
    const live = await plantRunDir(root, 'cyanprint-probe', process.pid);

    expect(await reapAbandonedEngineRunDirs(root, { graceMs: 0 })).toEqual([]);
    expect((await stat(live)).isDirectory()).toBe(true);
  });

  test('never touches a directory it did not allocate', async () => {
    const root = join(workRoot, 'foreign');
    await mkdir(join(root, 'somebody-elses-data'), { recursive: true });

    expect(await reapAbandonedEngineRunDirs(root, { graceMs: 0 })).toEqual([]);
    expect(await readdir(root)).toEqual(['somebody-elses-data']);
  });

  test('retained output outlives its owner and is only expired by age', async () => {
    const root = join(workRoot, 'retained');
    await mkdir(root, { recursive: true });
    const retained = await plantRunDir(root, 'cyanprint-try', await deadPid());
    await markEngineRunDirRetained(retained);

    // The owner is long gone, but kept output is evidence — not abandoned state.
    expect(await reapAbandonedEngineRunDirs(root, { graceMs: 0 })).toEqual([]);
    expect((await stat(retained)).isDirectory()).toBe(true);

    // Only its TTL expires it, so a kept sandbox cannot leak forever either.
    expect(await reapAbandonedEngineRunDirs(root, { graceMs: 0, retainedTtlMs: -1 })).toEqual([retained]);
  });

  test('a missing run root is not an error — a sweep never fails a run', async () => {
    expect(await reapAbandonedEngineRunDirs(join(workRoot, 'does-not-exist'))).toEqual([]);
  });
});
