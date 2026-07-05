import { readFile, rm } from 'node:fs/promises';
import type { ProbeExecResult, ProbeRepo } from '@cyanprint/contracts';
import {
  assertRootSafeDelete,
  assertRootSafeRead,
  assertRootSafeWrite,
  comparePaths,
  exists,
  safeJoin,
  writeText,
} from '../util';
import { runDetachedCommand } from './spawn';

/**
 * A sandbox operation (read/write/remove/glob/patch) failed: the experiment's
 * infrastructure broke before the gate was ever consulted. The executor maps this
 * to `invalid` for mutation probes ("the sabotage could not be applied") and
 * `broken` for baselines — distinct from a plain author throw, which means the
 * gate showed the wrong outcome.
 */
export class ProbeRepoOpError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProbeRepoOpError';
  }
}

/**
 * The engine-provided `ProbeRepo` handed to probes as their first argument. All
 * paths are constrained to the sandbox root; `exec` runs with cwd pinned to the
 * sandbox and the environment inherited untouched (FR11 — no env assumptions, and
 * no auto-retry anywhere: a failed command is a result, never re-run).
 *
 * The repo lives inside the isolated probe runner (`probe-runner.ts`), so `exec`
 * defaults to `detached: false`: gate commands inherit the runner's process group
 * and the parent's single group-kill takes the whole in-group tree down on the
 * probe timeout; an explicit per-command `timeoutMs` kills the command's
 * PPID-connected subtree (see `probe-process.ts` / `spawn.ts`).
 *
 * Timeout containment boundary (FR10/FR11 resolution, 2026-07-04): those kills
 * cover the spawned process group / PPID subtree ONLY. Tracking descendants that
 * re-session out (`setsid`, daemonization, reparenting to init) would require an
 * engine-injected environment marker, which FR11 forbids — such escapees are a
 * documented, out-of-scope limitation.
 */
export function createProbeRepo(sandboxPath: string, options?: { detached?: boolean }): ProbeRepo {
  const exec = async (command: string, opts?: { timeoutMs?: number }): Promise<ProbeExecResult> => {
    const result = await runDetachedCommand({
      command,
      cwd: sandboxPath,
      timeoutMs: opts?.timeoutMs,
      detached: options?.detached,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };

  return {
    exec,
    read: path =>
      guardOp(`read ${path}`, async () => {
        const target = safeSandboxPath(sandboxPath, path);
        // Textual containment is not enough: a symlink INSIDE the sandbox can point
        // outside it, and `readFile` follows it. Refuse any symlink component
        // (parent or leaf) so a probe cannot exfiltrate files from outside the repo.
        await assertRootSafeRead(sandboxPath, path);
        return readFile(target, 'utf8');
      }),
    write: (path, content) =>
      guardOp(`write ${path}`, async () => {
        safeSandboxPath(sandboxPath, path);
        await assertRootSafeWrite(sandboxPath, path);
        await writeText(safeJoin(sandboxPath, path), content);
      }),
    remove: path =>
      guardOp(`remove ${path}`, async () => {
        const target = safeSandboxPath(sandboxPath, path);
        // A symlinked PARENT would make `rm` unlink a target outside the sandbox; a
        // symlink LEAF is safe (the link itself is removed, its target untouched).
        await assertRootSafeDelete(sandboxPath, path);
        // A missing target is a loud failure: the sabotage (or cleanup) the author
        // asked for cannot be applied, which must surface as `invalid`, not as a
        // silently "successful" mutation.
        if (!(await exists(target))) {
          throw new Error('path does not exist in the sandbox');
        }
        await rm(target, { recursive: true, force: true });
      }),
    glob: pattern =>
      guardOp(`glob ${pattern}`, async () => {
        // Same containment policy as the other filesystem methods: an absolute
        // pattern or any `..` segment (including one hidden in a brace set) walks
        // out of the sandbox, so it is refused up front rather than silently
        // matching outside files. `scan` does not follow symlinked directories,
        // covering the link-traversal vector the read/patch guards close.
        assertSandboxGlobPattern(pattern);
        const paths = await Array.fromAsync(
          new Bun.Glob(pattern).scan({ cwd: sandboxPath, onlyFiles: true, dot: true }),
        );
        // Defense in depth: every returned path must resolve inside the sandbox.
        for (const path of paths) {
          safeSandboxPath(sandboxPath, path);
        }
        return paths.filter(path => path !== '.git' && !path.startsWith('.git/')).sort(comparePaths);
      }),
    patch: (path, edit) =>
      guardOp(`patch ${path}`, async () => {
        const target = safeSandboxPath(sandboxPath, path);
        // patch reads then writes: the write guard already refuses any symlink
        // component (parent or leaf), covering both the read and write vectors.
        await assertRootSafeWrite(sandboxPath, path);
        const content = await readFile(target, 'utf8');
        if (!content.includes(edit.find)) {
          throw new Error(`find text not present: ${JSON.stringify(edit.find)}`);
        }
        await writeText(target, content.replaceAll(edit.find, edit.replace));
      }),
  };
}

/**
 * Refuse glob patterns that can match outside the sandbox. `Bun.Glob.scan` treats
 * an absolute pattern as rooted at `/` (ignoring `cwd`) and resolves `..` segments
 * above `cwd`, so both must be rejected before the glob is ever constructed —
 * mirroring `safeJoin`'s textual policy for the path-taking methods. `..` is
 * checked per segment (any separator, and inside `{...}` alternations via the
 * plain substring scan) rather than as a substring, so legitimate names like
 * `..data` or `a..b` still glob fine.
 */
function assertSandboxGlobPattern(pattern: string): void {
  const escape = () => new ProbeRepoOpError(`glob pattern escapes the sandbox: ${pattern}`);
  if (pattern.startsWith('/') || pattern.startsWith('\\') || /^[A-Za-z]:/.test(pattern)) {
    throw escape();
  }
  const segments = pattern.split(/[\\/]+/);
  for (const segment of segments) {
    // A `..` segment, either bare or as any brace-set alternative (`{..,src}`).
    if (segment === '..' || segment.split(/[{},]/).includes('..')) {
      throw escape();
    }
  }
}

function safeSandboxPath(sandboxPath: string, path: string): string {
  try {
    return safeJoin(sandboxPath, path);
  } catch (error) {
    throw new ProbeRepoOpError(`path escapes the sandbox: ${path}`, error);
  }
}

async function guardOp<T>(label: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (error instanceof ProbeRepoOpError) {
      throw error;
    }
    throw new ProbeRepoOpError(
      `sandbox ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}
