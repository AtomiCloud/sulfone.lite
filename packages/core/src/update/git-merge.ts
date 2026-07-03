import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VfsFile } from '@cyanprint/contracts';
import { comparePaths, decodeText, pruneEmptyDirs, safeJoin, writeVfsFile } from '../util';

export type GitThreeWayMergeResult = {
  /** The merged working tree (conflicted files keep standard in-file `<<<<<<<` markers). */
  files: VfsFile[];
  /** Paths tracked in `ours` that the merge deleted. */
  deletions: string[];
  /** Paths left with conflict markers / unresolved index entries. */
  conflicts: string[];
};

/**
 * Iridium-exact three-way merge via the system `git`: commit `base`, branch `current`
 * (ours) and `incoming` (theirs), merge with rename detection (50% similarity).
 * Conflicts stay in-file as standard git conflict markers. `git` is a runtime
 * requirement of `update` (and create-into-existing-project) only.
 */
export async function gitThreeWayMerge(args: {
  base: VfsFile[];
  ours: VfsFile[];
  theirs: VfsFile[];
}): Promise<GitThreeWayMergeResult> {
  const repo = await mkdtemp(join(tmpdir(), 'cyanprint-merge-'));
  try {
    await git(repo, ['init', '-q', '-b', 'base']);
    await git(repo, ['config', 'user.email', 'cyanprint@localhost']);
    await git(repo, ['config', 'user.name', 'cyanprint']);
    await git(repo, ['config', 'commit.gpgsign', 'false']);
    await git(repo, ['config', 'core.autocrlf', 'false']);

    await writeTree(repo, args.base);
    await commitAll(repo, 'base');

    await git(repo, ['checkout', '-q', '-b', 'incoming']);
    await replaceTree(repo, args.theirs);
    await commitAll(repo, 'incoming');

    await git(repo, ['checkout', '-q', 'base']);
    await git(repo, ['checkout', '-q', '-b', 'current']);
    await replaceTree(repo, args.ours);
    await commitAll(repo, 'current');
    const oursTracked = new Set(await listTrackedFiles(repo));

    const merge = await git(repo, ['merge', '-q', '--no-edit', '-X', 'find-renames=50%', 'incoming'], {
      allowFailure: true,
    });
    const conflicts = merge.exitCode === 0 ? [] : await listConflictedFiles(repo);
    if (merge.exitCode !== 0 && conflicts.length === 0) {
      throw new Error(`git merge failed: ${merge.stderr || merge.stdout}`);
    }

    const files = await readTree(repo);
    const resultPaths = new Set(files.map(file => file.path));
    const deletions = [...oursTracked].filter(path => !resultPaths.has(path)).sort(comparePaths);
    return { files, deletions, conflicts: conflicts.sort(comparePaths) };
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function writeTree(repo: string, files: VfsFile[]): Promise<void> {
  for (const file of files) {
    await writeVfsFile(repo, file);
  }
}

async function replaceTree(repo: string, files: VfsFile[]): Promise<void> {
  const tracked = await listTrackedFiles(repo);
  for (const path of tracked) {
    await rm(safeJoin(repo, path), { force: true });
    // The incoming tree may put a FILE where the old tree had a directory; the emptied
    // directory must be pruned or writing that file fails with EISDIR.
    await pruneEmptyDirs(repo, path);
  }
  await writeTree(repo, files);
}

async function commitAll(repo: string, message: string): Promise<void> {
  // -f: the generated tree may contain a .gitignore that matches its own generated
  // files; a plain `add -A` would honor it and silently drop those files from the merge.
  await git(repo, ['add', '-A', '-f']);
  await git(repo, ['commit', '-q', '--allow-empty', '-m', message]);
}

async function listTrackedFiles(repo: string): Promise<string[]> {
  const result = await git(repo, ['ls-files', '-z']);
  return result.stdout.split('\0').filter(Boolean);
}

async function listConflictedFiles(repo: string): Promise<string[]> {
  const result = await git(repo, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return [...new Set(result.stdout.split('\0').filter(Boolean))];
}

async function readTree(repo: string): Promise<VfsFile[]> {
  const files: VfsFile[] = [];
  for (const path of await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: repo, onlyFiles: true, dot: true }))) {
    if (path === '.git' || path.startsWith('.git/')) {
      continue;
    }
    const bytes = new Uint8Array(await Bun.file(join(repo, path)).arrayBuffer());
    const text = decodeText(bytes);
    files.push(
      text === undefined ? { path, bytesBase64: Buffer.from(bytes).toString('base64') } : { path, content: text },
    );
  }
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

async function git(
  repo: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr || stdout}`);
  }
  return { stdout, stderr, exitCode };
}
