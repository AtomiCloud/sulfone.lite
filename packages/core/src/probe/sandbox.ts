import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProbeSandboxConfig, ProbeSetupConfig } from '@cyanprint/contracts';
import { assertRootSafeDelete, exists, safeJoin } from '../util';
import { runDetachedCommand } from './spawn';

const NEUTRAL_GIT_ATTRIBUTES = '** -filter -ident -text -crlf -eol -working-tree-encoding\n';

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
  const exclude = args.sandbox?.exclude ?? [];

  // Materialize one immutable source tree without ever walking/copying live .git
  // metadata. A Git worktree is materialized from its exact HEAD tree; a plain
  // directory uses the tolerant copy walk below. Runs only operate on forks of
  // this snapshot, so the original repo is never touched.
  const snapshotPath = join(root, 'snapshot');
  const sourceTrackedPaths = await materializeSourceTree(args.repoPath, snapshotPath, root, exclude);

  // setup.pre historically ran before the snapshot froze. Give it an
  // engine-owned repository when Git restore is selected, never the source's
  // live metadata. The final freeze below re-initialises from scratch so the
  // retained snapshot contains exactly one sealed commit/pack.
  if (strategy === 'git') {
    await initialiseGitRepository(snapshotPath, 'cyanprint probe setup base', sourceTrackedPaths);
  }

  // Phase 1: setup.pre runs exactly once, before the snapshot freezes — its
  // outputs are part of the snapshot and therefore present after every restore.
  await runSetupPhase('pre', args.setup?.pre, snapshotPath, args.commandTimeoutMs);

  if (strategy === 'git') {
    await freezeGitSnapshot(snapshotPath, sourceTrackedPaths);
  }
  const ignoredSnapshotPaths = strategy === 'git' ? await gitIgnoredPaths(snapshotPath) : [];
  const trackPostState = strategy === 'git' && (args.setup?.post?.length ?? 0) > 0;

  let runCounter = 0;
  const createRun = async (): Promise<ProbeSandbox> => {
    runCounter += 1;
    const runPath = join(root, `run-${runCounter}`);
    await copyTree(snapshotPath, runPath, { skipGitMetadata: false, tolerateVanishingEntries: false });
    // Forking from the snapshot IS a restore: setup.post runs before the run's probes.
    const beforePost = trackPostState ? await treePathKinds(runPath) : undefined;
    await runSetupPhase('post', args.setup?.post, runPath, args.commandTimeoutMs);
    let postPreserve = beforePost ? await postCreatedIgnoredPaths(runPath, beforePost) : [];
    return {
      path: runPath,
      restore: async () => {
        if (strategy === 'git') {
          await restoreGitSandbox(
            runPath,
            snapshotPath,
            minimalPreserveRoots([...preserve, ...postPreserve]),
            ignoredSnapshotPaths,
          );
        } else {
          await restoreFsSandbox(runPath, snapshotPath, preserve);
        }
        const beforeRestoredPost = trackPostState ? await treePathKinds(runPath) : undefined;
        await runSetupPhase('post', args.setup?.post, runPath, args.commandTimeoutMs);
        if (beforeRestoredPost) {
          postPreserve = minimalPreserveRoots([
            ...postPreserve,
            ...(await postCreatedIgnoredPaths(runPath, beforeRestoredPost)),
          ]);
        }
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
 * Materialize the requested repo without traversing its live `.git` entry.
 * Git-backed inputs check out the resolved immutable HEAD tree through an
 * isolated bare repository and temporary index; plain directories use the same
 * reflink-aware walker as run forks. Removing `.gitattributes` from that index
 * (then writing those blobs back verbatim) prevents worktree conversions,
 * filters, export-ignore, and export-subst from changing committed bytes.
 */
async function materializeSourceTree(
  repoPath: string,
  snapshotPath: string,
  root: string,
  exclude: string[],
): Promise<string[]> {
  const tree = await gitTreeForRepositoryRoot(repoPath);
  if (!tree) {
    await copyTree(repoPath, snapshotPath, {
      exclude,
      skipGitMetadata: true,
      tolerateVanishingEntries: true,
    });
    return [];
  }

  await mkdir(snapshotPath, { recursive: true });
  const indexPath = join(root, 'source.index');
  const materializerGitDir = join(root, 'source-materializer.git');
  try {
    const matchers = exclude.map(pattern => new Bun.Glob(pattern));
    const treeEntries = parseGitTreeEntries(await gitOutputBytes(repoPath, ['ls-tree', '-r', '-z', tree]));
    const entries = treeEntries.filter(entry => !matchesExcludedPath(entry.path, matchers));
    const unsupportedEntry = entries.find(entry => entry.type !== 'blob');
    if (unsupportedEntry) {
      throw new Error(
        `CyanPrint probe snapshots cannot materialize Git ${unsupportedEntry.type} entry ` +
          `"${unsupportedEntry.path}" (mode ${unsupportedEntry.mode}). ` +
          'Materialize or remove the submodule/gitlink before probing.',
      );
    }
    const objectFormat = await gitOutput(repoPath, ['rev-parse', '--show-object-format']);
    const sourceObjectsPath = await gitOutput(repoPath, ['rev-parse', '--git-path', 'objects']);
    const sourceObjects = await realpath(
      sourceObjectsPath.startsWith('/') ? sourceObjectsPath : join(repoPath, sourceObjectsPath),
    );
    await gitWithEnv(
      root,
      ['init', '--bare', '-q', `--object-format=${objectFormat}`, materializerGitDir],
      neutralGitEnvironment(),
    );
    await mkdir(join(materializerGitDir, 'objects/info'), { recursive: true });
    await writeFile(join(materializerGitDir, 'objects/info/alternates'), `${sourceObjects}\n`, 'utf8');

    const isolatedEnv = {
      GIT_DIR: materializerGitDir,
      GIT_INDEX_FILE: indexPath,
      GIT_WORK_TREE: snapshotPath,
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    await gitWithEnv(root, ['read-tree', tree], isolatedEnv);
    const attributeIndexPaths = treeEntries.filter(entry => isGitAttributesPath(entry.path)).map(entry => entry.path);
    const attributeEntries = entries.filter(entry => isGitAttributesPath(entry.path));
    for (let offset = 0; offset < attributeIndexPaths.length; offset += 256) {
      await gitWithEnv(
        root,
        [
          '--literal-pathspecs',
          'update-index',
          '--force-remove',
          '--',
          ...attributeIndexPaths.slice(offset, offset + 256),
        ],
        isolatedEnv,
      );
    }
    await checkoutIndex(
      root,
      isolatedEnv,
      snapshotPath,
      entries.filter(entry => !isGitAttributesPath(entry.path)).map(entry => entry.path),
    );
    for (const entry of attributeEntries) {
      await materializeRawBlob(repoPath, snapshotPath, entry);
    }
    return entries.map(entry => entry.path);
  } finally {
    await rm(indexPath, { force: true });
    await rm(materializerGitDir, { recursive: true, force: true });
  }
}

type GitTreeEntry = {
  mode: string;
  type: string;
  oid: string;
  path: string;
};

function parseGitTreeEntries(outputBytes: Uint8Array): GitTreeEntry[] {
  let output: string;
  try {
    output = new TextDecoder('utf-8', { fatal: true }).decode(outputBytes);
  } catch {
    throw new Error(
      'CyanPrint probe snapshots cannot materialize non-UTF-8 Git paths. Rename the path before probing.',
    );
  }
  return output.split('\0').flatMap(entry => {
    const separator = entry.indexOf('\t');
    if (separator < 0) {
      return [];
    }
    const [mode, type, oid] = entry.slice(0, separator).split(' ');
    if (!mode || !type || !oid) {
      return [];
    }
    return [{ mode, type, oid, path: entry.slice(separator + 1) }];
  });
}

function isGitAttributesPath(path: string): boolean {
  return path === '.gitattributes' || path.endsWith('/.gitattributes');
}

async function materializeRawBlob(repoPath: string, destination: string, entry: GitTreeEntry): Promise<void> {
  const proc = Bun.spawn(['git', 'cat-file', 'blob', entry.oid], {
    cwd: repoPath,
    env: cleanGitEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [bytes, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git cat-file blob ${entry.oid} failed (${exitCode}): ${stderr}`);
  }
  const absolute = safeJoin(destination, entry.path);
  await mkdir(dirname(absolute), { recursive: true });
  if (entry.mode === '120000') {
    await symlink(new TextDecoder().decode(bytes), absolute);
    return;
  }
  await writeFile(absolute, new Uint8Array(bytes));
  await chmod(absolute, entry.mode === '100755' ? 0o755 : 0o644);
}

async function gitTreeForRepositoryRoot(repoPath: string): Promise<string | undefined> {
  let topLevel: string;
  try {
    topLevel = await gitOutput(repoPath, ['rev-parse', '--show-toplevel']);
  } catch {
    return undefined;
  }
  if ((await realpath(topLevel)) !== (await realpath(repoPath))) {
    return undefined;
  }
  return gitOutput(repoPath, ['rev-parse', '--verify', 'HEAD^{tree}']);
}

async function checkoutIndex(
  cwd: string,
  env: Record<string, string>,
  destination: string,
  paths: string[],
): Promise<void> {
  const proc = Bun.spawn(
    [
      'git',
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.attributesFile=/dev/null',
      'checkout-index',
      '--stdin',
      '-z',
      `--prefix=${destination}/`,
    ],
    {
      cwd,
      env: { ...cleanGitEnvironment(), ...env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (paths.length > 0) {
    proc.stdin.write(`${paths.join('\0')}\0`);
  }
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git checkout-index failed (${exitCode}): ${stderr || stdout}`);
  }
}

type CopyTreeOptions = {
  exclude?: string[];
  /** False only for engine-owned sealed repositories forked into run sandboxes. */
  skipGitMetadata: boolean;
  /**
   * True ONLY for the initial walk of a LIVE plain-filesystem source, where an
   * entry can legitimately disappear between being listed and being copied.
   * Every copy that reads the frozen snapshot — run forks, fs restore, and Git
   * ignored-root restore — passes false: a sealed snapshot never mutates, so a
   * missing entry there is a real failure and must abort loudly rather than
   * yield a partial sandbox that goes on to execute probes.
   */
  tolerateVanishingEntries: boolean;
};

/**
 * Recursive reflink/CoW copy with ordinary-copy fallback. Child entries that
 * vanish mid-walk are skipped with a warning only when
 * `tolerateVanishingEntries` is set; otherwise they propagate as a loud error.
 * The copy root is never tolerated as vanished — its absence always means the
 * caller asked to copy something that does not exist.
 */
async function copyTree(source: string, destination: string, options: CopyTreeOptions): Promise<void> {
  const matchers = (options.exclude ?? []).map(pattern => new Bun.Glob(pattern));
  await copyTreeEntry(source, destination, '', options, matchers, false);
}

async function copyTreeEntry(
  source: string,
  destination: string,
  relativePath: string,
  options: CopyTreeOptions,
  matchers: Bun.Glob[],
  mayVanish: boolean,
): Promise<void> {
  if (relativePath) {
    const segments = relativePath.split('/');
    if (options.skipGitMetadata && segments.includes('.git')) {
      return;
    }
    if (matchesExcludedPath(relativePath, matchers)) {
      return;
    }
  }

  let sourceStat;
  try {
    sourceStat = await lstat(source);
  } catch (error) {
    if (mayVanish && isVanished(error)) {
      warnVanished(relativePath);
      return;
    }
    throw error;
  }

  try {
    if (sourceStat.isDirectory()) {
      await mkdir(destination, { recursive: true });
      let entries;
      try {
        entries = await readdir(source);
      } catch (error) {
        if (mayVanish && isVanished(error)) {
          await rm(destination, { recursive: true, force: true });
          warnVanished(relativePath);
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const childRelative = relativePath ? `${relativePath}/${entry}` : entry;
        await copyTreeEntry(
          join(source, entry),
          join(destination, entry),
          childRelative,
          options,
          matchers,
          options.tolerateVanishingEntries,
        );
      }
      if (mayVanish) {
        const finalSourceStat = await lstat(source).catch(error => {
          if (isVanished(error)) {
            return undefined;
          }
          throw error;
        });
        if (!finalSourceStat?.isDirectory()) {
          await rm(destination, { recursive: true, force: true });
          warnVanished(relativePath);
        }
      }
      return;
    }
    await mkdir(dirname(destination), { recursive: true });
    if (sourceStat.isSymbolicLink()) {
      await symlink(await readlink(source), destination);
      return;
    }
    try {
      // COPYFILE_FICLONE automatically falls back to a plain copy when the
      // filesystem cannot clone extents. Some runtimes surface unsupported
      // ioctl codes despite that contract, so retry those explicitly as well.
      await copyFile(source, destination, constants.COPYFILE_FICLONE);
    } catch (error) {
      if (mayVanish && isVanished(error)) {
        warnVanished(relativePath);
        return;
      }
      if (isReflinkUnsupported(error)) {
        await copyFile(source, destination);
        return;
      }
      throw error;
    }
  } catch (error) {
    if (mayVanish && isVanished(error)) {
      warnVanished(relativePath);
      return;
    }
    throw error;
  }
}

function matchesExcludedPath(relativePath: string, matchers: Bun.Glob[]): boolean {
  const segments = relativePath.split('/');
  for (let length = segments.length; length > 0; length -= 1) {
    const candidate = segments.slice(0, length).join('/');
    if (matchers.some(glob => glob.match(candidate) || glob.match(`${candidate}/`))) {
      return true;
    }
  }
  return false;
}

function isVanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ESTALE';
}

function isReflinkUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EINVAL';
}

function warnVanished(relativePath: string): void {
  console.warn(`cyanprint probe snapshot skipped a path that vanished during copy: ${relativePath || '.'}`);
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
 * snapshot is self-contained. Source paths that were already tracked remain
 * tracked even when an ignore rule matches them; ignored setup-created outputs
 * remain present but untracked. Gates therefore see the exact source tree without
 * ingesting dependency caches merely because CyanPrint took a snapshot.
 * `repack -adq` leaves the repository as one sealed pack rather than a loose
 * object tree that can race while forks are copied.
 */
async function freezeGitSnapshot(snapshotPath: string, sourceTrackedPaths: string[]): Promise<void> {
  await rm(join(snapshotPath, '.git'), { recursive: true, force: true });
  await initialiseGitRepository(snapshotPath, 'cyanprint probe snapshot', sourceTrackedPaths);
  await git(snapshotPath, ['repack', '-adq']);
  await git(snapshotPath, ['prune-packed', '-q']);
  // A large initial commit can trigger auto-maintenance while it is being
  // sealed. Repack once more after that boundary so even an inherited/global
  // maintenance configuration cannot leave two equivalent packs behind.
  await git(snapshotPath, ['repack', '-adq']);
  await git(snapshotPath, ['prune-packed', '-q']);
}

async function initialiseGitRepository(
  snapshotPath: string,
  message: string,
  sourceTrackedPaths: string[] = [],
): Promise<void> {
  await gitWithEnv(snapshotPath, ['init', '-q'], neutralGitEnvironment());
  await git(snapshotPath, ['config', 'user.email', 'cyanprint@localhost']);
  await git(snapshotPath, ['config', 'user.name', 'cyanprint']);
  await git(snapshotPath, ['config', 'commit.gpgsign', 'false']);
  await git(snapshotPath, ['config', 'core.autocrlf', 'false']);
  await git(snapshotPath, ['config', 'gc.auto', '0']);
  await ensureNeutralGitAttributes(snapshotPath);
  await git(snapshotPath, ['add', '-A']);
  const forceTracked: string[] = [];
  for (const relativePath of sourceTrackedPaths) {
    const sourceStat = await lstat(safeJoin(snapshotPath, relativePath)).catch(error => {
      if (isVanished(error)) {
        return undefined;
      }
      throw error;
    });
    if (sourceStat && !sourceStat.isDirectory()) {
      forceTracked.push(relativePath);
    }
  }
  for (let offset = 0; offset < forceTracked.length; offset += 256) {
    await git(snapshotPath, ['--literal-pathspecs', 'add', '-f', '--', ...forceTracked.slice(offset, offset + 256)]);
  }
  await git(snapshotPath, ['commit', '-q', '--allow-empty', '-m', message]);
}

/**
 * Git restore resets the index/worktree and untracked files, then rematerializes
 * ignored roots that already belonged to the frozen post-setup.pre snapshot.
 * This keeps ignored setup.pre dependencies byte-exact without deleting ignored
 * setup.post outputs that were created only inside a run. Preserve paths are
 * parked across the whole operation, including when nested under an ignored
 * snapshot root.
 */
async function restoreGitSandbox(
  runPath: string,
  snapshotPath: string,
  preserve: string[],
  ignoredSnapshotPaths: string[],
): Promise<void> {
  const runGitDir = join(runPath, '.git');
  await rm(runGitDir, { recursive: true, force: true });
  await copyTree(join(snapshotPath, '.git'), runGitDir, {
    skipGitMetadata: false,
    tolerateVanishingEntries: false,
  });
  const restoreGitEnv = {
    ...neutralGitEnvironment(),
    GIT_DIR: runGitDir,
    GIT_WORK_TREE: runPath,
    GIT_INDEX_FILE: join(runGitDir, 'index'),
  };
  await ensureNeutralGitAttributes(runPath);
  for (const relativePath of preserve) {
    await assertRootSafeDelete(runPath, relativePath);
    await assertRootSafeDelete(snapshotPath, relativePath);
  }
  for (const relativePath of ignoredSnapshotPaths) {
    await assertRootSafeDelete(runPath, relativePath);
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

    await gitWithEnv(runPath, ['reset', '-q', '--hard', 'HEAD'], restoreGitEnv);
    await gitWithEnv(runPath, ['clean', '-ffdxq'], restoreGitEnv);
    for (const relativePath of ignoredSnapshotPaths) {
      if (preserve.some(path => relativePath === path || relativePath.startsWith(`${path}/`))) {
        continue;
      }
      const runAbsolute = safeJoin(runPath, relativePath);
      const snapshotAbsolute = safeJoin(snapshotPath, relativePath);
      await rm(runAbsolute, { recursive: true, force: true });
      await copyTree(snapshotAbsolute, runAbsolute, { skipGitMetadata: false, tolerateVanishingEntries: false });
    }

    for (const { relative, parkedAt } of parked) {
      const absolute = safeJoin(runPath, relative);
      await rm(absolute, { recursive: true, force: true });
      await mkdir(dirname(absolute), { recursive: true });
      await rename(parkedAt, absolute);
    }
  } finally {
    await rm(parking, { recursive: true, force: true });
  }
}

async function ensureNeutralGitAttributes(repoPath: string): Promise<void> {
  const relativePath = '.git/info/attributes';
  await assertRootSafeDelete(repoPath, relativePath);
  const absolute = safeJoin(repoPath, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, NEUTRAL_GIT_ATTRIBUTES, 'utf8');
}

async function gitIgnoredPaths(snapshotPath: string): Promise<string[]> {
  return decodeGitPathList(
    await gitOutputBytes(snapshotPath, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ]),
  )
    .filter(Boolean)
    .map(path => (path.endsWith('/') ? path.slice(0, -1) : path));
}

type TreePathKind = 'directory' | 'entry';

async function treePathKinds(root: string): Promise<Map<string, TreePathKind>> {
  const paths = new Map<string, TreePathKind>();
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const entryName of await readdir(directory, { encoding: 'buffer' })) {
      const name = decodeGitPathBytes(entryName);
      if (name === '.git') {
        continue;
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const kind: TreePathKind = (await lstat(join(directory, name))).isDirectory() ? 'directory' : 'entry';
      paths.set(relativePath, kind);
      if (kind === 'directory') {
        await walk(join(directory, name), relativePath);
      }
    }
  };
  await walk(root, '');
  return paths;
}

async function postCreatedIgnoredPaths(repoPath: string, beforePost: Map<string, TreePathKind>): Promise<string[]> {
  const afterPost = await treePathKinds(repoPath);
  const added = [...afterPost.keys()].filter(path => !beforePost.has(path));
  const ignored = new Set(await gitIgnoredPathsAmong(repoPath, added));
  return minimalPreserveRoots(added.filter(path => ignored.has(path)));
}

async function gitIgnoredPathsAmong(repoPath: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) {
    return [];
  }
  const proc = Bun.spawn(['git', 'check-ignore', '--stdin', '-z'], {
    cwd: repoPath,
    env: cleanGitEnvironment(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(`${paths.join('\0')}\0`);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`git check-ignore failed (${exitCode}): ${stderr}`);
  }
  return decodeGitPathList(new Uint8Array(stdout)).filter(Boolean);
}

function decodeGitPathList(bytes: Uint8Array): string[] {
  return decodeGitPathBytes(bytes).split('\0');
}

function decodeGitPathBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      'CyanPrint probe snapshots cannot materialize non-UTF-8 filesystem paths. Rename the path before probing.',
    );
  }
}

function minimalPreserveRoots(paths: string[]): string[] {
  const ordered = [...new Set(paths)].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length;
    return depth === 0 ? left.localeCompare(right) : depth;
  });
  const roots: string[] = [];
  for (const path of ordered) {
    if (!roots.some(root => path === root || path.startsWith(`${root}/`))) {
      roots.push(path);
    }
  }
  return roots;
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
    await copyTree(snapshotPath, runPath, { skipGitMetadata: false, tolerateVanishingEntries: false });
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
  await gitWithEnv(cwd, cliArgs, {
    ...neutralGitEnvironment(),
    GIT_DIR: join(cwd, '.git'),
    GIT_WORK_TREE: cwd,
    GIT_INDEX_FILE: join(cwd, '.git/index'),
  });
}

async function gitWithEnv(cwd: string, cliArgs: string[], env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(['git', ...cliArgs], {
    cwd,
    env: { ...cleanGitEnvironment(), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${cliArgs.join(' ')} failed (${exitCode}): ${stderr || stdout}`);
  }
}

async function gitOutput(cwd: string, cliArgs: string[]): Promise<string> {
  return (await gitOutputRaw(cwd, cliArgs)).trim();
}

async function gitOutputRaw(cwd: string, cliArgs: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...cliArgs], {
    cwd,
    env: cleanGitEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${cliArgs.join(' ')} failed (${exitCode}): ${stderr || stdout}`);
  }
  return stdout;
}

async function gitOutputBytes(cwd: string, cliArgs: string[]): Promise<Uint8Array> {
  const proc = Bun.spawn(['git', ...cliArgs], {
    cwd,
    env: cleanGitEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${cliArgs.join(' ')} failed (${exitCode}): ${stderr}`);
  }
  return new Uint8Array(stdout);
}

function cleanGitEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      const [key, value] = entry;
      return value !== undefined && !key.startsWith('GIT_');
    }),
  );
}

function neutralGitEnvironment(): Record<string, string> {
  return {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}
