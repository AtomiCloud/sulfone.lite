import { cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeSandboxConfig, ProbeSetupConfig } from '@cyanprint/contracts';
import { assertRootSafeDelete, exists, safeJoin } from '../util';
import { runDetachedCommand } from './spawn';

/**
 * Engine-owned snapshot/restore sandboxing (FR9 isolation, FR11 two-phase setup).
 *
 * One `ProbeSandboxSource` is prepared per matrix: the materialized repo is copied
 * into a frozen SNAPSHOT (the original repo is never touched), `setup.pre` runs
 * exactly once inside the snapshot BEFORE it is frozen (its outputs ride every
 * restore), and each matrix run forks its own sandbox from the snapshot.
 * Forking counts as a restore: `setup.post` runs after every fork and after every
 * in-place `restore()`, before the run's probes.
 */

export class ProbeSetupError extends Error {
  readonly phase: 'pre' | 'post';
  readonly command: string;

  constructor(phase: 'pre' | 'post', command: string, detail: string) {
    super(`probe setup.${phase} command failed (${command}): ${detail}`);
    this.name = 'ProbeSetupError';
    this.phase = phase;
    this.command = command;
  }
}

export type ProbeSandbox = {
  /** Absolute path of this run's sandboxed repo copy. */
  path: string;
  /** Reset the sandbox to the snapshot state, then re-run `setup.post`. */
  restore(): Promise<void>;
  dispose(): Promise<void>;
};

export type ProbeSandboxSource = {
  /** The strategy actually selected (`auto` resolved to `git` or `fs`). */
  strategy: 'git' | 'fs';
  /** Directory holding the snapshot and every run sandbox. */
  root: string;
  /** The frozen post-`setup.pre` snapshot tree (never mutated after freeze). */
  snapshotPath: string;
  /** Fork a fresh run sandbox from the snapshot (runs `setup.post`). */
  createRun(): Promise<ProbeSandbox>;
  dispose(): Promise<void>;
};

export async function prepareProbeSandboxSource(args: {
  repoPath: string;
  sandbox?: ProbeSandboxConfig;
  setup?: ProbeSetupConfig;
  /** Parent directory for the sandbox tree; a temp dir is created when omitted. */
  sandboxRoot?: string;
  /** Timeout applied to each setup command (hangs become loud failures, FR10). */
  commandTimeoutMs?: number;
}): Promise<ProbeSandboxSource> {
  if (args.sandboxRoot) {
    await mkdir(args.sandboxRoot, { recursive: true });
  }
  const root = args.sandboxRoot
    ? await mkdtemp(join(args.sandboxRoot, 'cyanprint-probe-'))
    : await mkdtemp(join(tmpdir(), 'cyanprint-probe-'));
  try {
    return await prepareInRoot(root, args);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function prepareInRoot(
  root: string,
  args: {
    repoPath: string;
    sandbox?: ProbeSandboxConfig;
    setup?: ProbeSetupConfig;
    commandTimeoutMs?: number;
  },
): Promise<ProbeSandboxSource> {
  const requested = args.sandbox?.snapshot ?? 'auto';
  const strategy: 'git' | 'fs' = requested === 'auto' ? ((await gitUsable()) ? 'git' : 'fs') : requested;
  const preserve = args.sandbox?.preserve ?? [];

  // The snapshot is a COPY of the materialized repo: runs only ever operate on
  // copies of this copy, so the original repo is never touched.
  const snapshotPath = join(root, 'snapshot');
  await cp(args.repoPath, snapshotPath, { recursive: true, verbatimSymlinks: true });

  // Phase 1: setup.pre runs exactly once, before the snapshot freezes — its
  // outputs are part of the snapshot and therefore present after every restore.
  await runSetupPhase('pre', args.setup?.pre, snapshotPath, args.commandTimeoutMs);

  if (strategy === 'git') {
    await freezeGitSnapshot(snapshotPath);
  }

  let runCounter = 0;
  const createRun = async (): Promise<ProbeSandbox> => {
    runCounter += 1;
    const runPath = join(root, `run-${runCounter}`);
    await cp(snapshotPath, runPath, { recursive: true, verbatimSymlinks: true });
    // Forking from the snapshot IS a restore: setup.post runs before the run's probes.
    await runSetupPhase('post', args.setup?.post, runPath, args.commandTimeoutMs);
    return {
      path: runPath,
      restore: async () => {
        if (strategy === 'git') {
          await restoreGitSandbox(runPath, preserve);
        } else {
          await restoreFsSandbox(runPath, snapshotPath, preserve);
        }
        await runSetupPhase('post', args.setup?.post, runPath, args.commandTimeoutMs);
      },
      dispose: () => rm(runPath, { recursive: true, force: true }),
    };
  };

  return {
    strategy,
    root,
    snapshotPath,
    createRun,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

async function runSetupPhase(
  phase: 'pre' | 'post',
  commands: string[] | undefined,
  cwd: string,
  timeoutMs?: number,
): Promise<void> {
  for (const command of commands ?? []) {
    const result = await runDetachedCommand({ command, cwd, timeoutMs });
    if (result.timedOut) {
      throw new ProbeSetupError(phase, command, `timed out after ${timeoutMs}ms`);
    }
    if (result.exitCode !== 0) {
      throw new ProbeSetupError(phase, command, `exit ${result.exitCode}: ${result.stderr || result.stdout}`);
    }
  }
}

/** `auto` picks git when a usable git binary is on PATH, else falls back to fs. */
async function gitUsable(): Promise<boolean> {
  const result = await runDetachedCommand({ command: 'git --version', cwd: tmpdir(), timeoutMs: 10_000 }).catch(
    () => undefined,
  );
  return result !== undefined && !result.timedOut && result.exitCode === 0;
}

/**
 * Freeze the snapshot as a git commit inside a fresh, INDEPENDENT repository. The
 * copied `.git` (if any) is discarded first, then `git init` creates a private repo
 * for the snapshot copy — regardless of what the source tree was:
 *
 *  - a linked worktree's `.git` is a POINTER FILE (`gitdir: …/.git/worktrees/…`)
 *    aimed at the ORIGINAL repo's metadata; committing through it would stage and
 *    move the original worktree's index/branch — corrupting the very repo FR9
 *    promises never to touch (reproduced with a linked worktree);
 *  - a normal repo's `.git` is the original's whole object store, which the snapshot
 *    neither needs nor wants to carry — a restore only ever rewinds to the single
 *    snapshot commit made below, so the prior history is dead weight;
 *  - a generated repo is a plain directory with no `.git` at all.
 *
 * Removing `.git` and re-initialising covers all three uniformly and guarantees the
 * snapshot is self-contained. `add -A -f` forces gitignored setup.pre outputs
 * (dependency caches and the like) into the commit so they too are restored
 * byte-exact.
 */
async function freezeGitSnapshot(snapshotPath: string): Promise<void> {
  await rm(join(snapshotPath, '.git'), { recursive: true, force: true });
  await git(snapshotPath, ['init', '-q']);
  await git(snapshotPath, ['config', 'user.email', 'cyanprint@localhost']);
  await git(snapshotPath, ['config', 'user.name', 'cyanprint']);
  await git(snapshotPath, ['config', 'commit.gpgsign', 'false']);
  await git(snapshotPath, ['config', 'core.autocrlf', 'false']);
  await git(snapshotPath, ['add', '-A', '-f']);
  await git(snapshotPath, ['commit', '-q', '--allow-empty', '-m', 'cyanprint probe snapshot']);
}

/**
 * Git restore: the index AND worktree are reset to the snapshot commit, then
 * untracked files are removed. `reset --hard HEAD` (not `checkout -- .`) is the
 * fix that makes the restore byte-exact even when a probe STAGED its sabotage
 * (`git add -A`): `checkout -- .` restores from the mutable index, so staged
 * changes would survive; `reset --hard` discards the index too. No `-x` on the
 * clean, so gitignored outputs (e.g. a `node_modules` a setup.post produced)
 * survive restores; `preserve` entries are additionally excluded from the clean.
 */
async function restoreGitSandbox(runPath: string, preserve: string[]): Promise<void> {
  await git(runPath, ['reset', '-q', '--hard', 'HEAD']);
  await git(runPath, ['clean', '-fdq', ...preserve.flatMap(path => ['-e', path])]);
}

/**
 * Fs restore: preserved paths are parked aside, the tree is reset to a fresh copy
 * of the snapshot, then the preserved paths are moved back over whatever the
 * snapshot held there — so they are kept across restores, not reset.
 *
 * `safeJoin` only vets a preserved path TEXTUALLY: if a parent component inside the
 * sandbox is a symlink to an external directory (planted by the repo, a setup
 * command, or a mutation), the subsequent `rename`/`rm`/`mkdir` would FOLLOW that
 * link and move or delete files OUTSIDE the sandbox.
 * Before touching anything, every preserved path is checked for a symlinked parent
 * in BOTH the live sandbox (the park source) AND the snapshot (whose tree becomes the
 * restore target after the reset copy) via {@link assertRootSafeDelete}; a symlinked
 * parent makes the whole restore refuse loudly, external target untouched.
 */
async function restoreFsSandbox(runPath: string, snapshotPath: string, preserve: string[]): Promise<void> {
  for (const relativePath of preserve) {
    // Park source: `rename(runPath/rel, …)` follows a symlinked parent out of the sandbox.
    await assertRootSafeDelete(runPath, relativePath);
    // Restore target: the reset copies the snapshot into runPath, so a symlinked parent
    // in the snapshot would make the write-back `rm`/`rename` escape the same way.
    await assertRootSafeDelete(snapshotPath, relativePath);
  }
  const parking = await mkdtemp(join(tmpdir(), 'cyanprint-probe-preserve-'));
  try {
    const parked: Array<{ relative: string; parkedAt: string }> = [];
    for (const [index, relativePath] of preserve.entries()) {
      const absolute = safeJoin(runPath, relativePath);
      if (await exists(absolute)) {
        const parkedAt = join(parking, String(index));
        await rename(absolute, parkedAt);
        parked.push({ relative: relativePath, parkedAt });
      }
    }
    for (const entry of await readdir(runPath)) {
      await rm(join(runPath, entry), { recursive: true, force: true });
    }
    await cp(snapshotPath, runPath, { recursive: true, verbatimSymlinks: true });
    for (const { relative, parkedAt } of parked) {
      const absolute = safeJoin(runPath, relative);
      await rm(absolute, { recursive: true, force: true });
      await mkdir(join(absolute, '..'), { recursive: true });
      await rename(parkedAt, absolute);
    }
  } finally {
    await rm(parking, { recursive: true, force: true });
  }
}

async function git(cwd: string, cliArgs: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...cliArgs], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${cliArgs.join(' ')} failed (${exitCode}): ${stderr || stdout}`);
  }
}
