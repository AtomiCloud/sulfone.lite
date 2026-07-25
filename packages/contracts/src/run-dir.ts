import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The engine-owned root for LIVE RUN STATE — deliberately NOT the caller's `TMPDIR`.
 *
 * The engine used to allocate run state (probe snapshots and sandboxes, sessions,
 * merge repos, artifact containers) under `os.tmpdir()`, which on POSIX is whatever
 * `TMPDIR` says. Under `nix-shell` that is `/tmp/nix-shell.XXXX`, a directory whose
 * lifetime belongs to the INVOKING SHELL. When that shell exited — or when an extra
 * wrapper layer's shell lifecycle ended — live run state was deleted mid-run and the
 * whole invocation folded with `ENOENT ... statx .../snapshot` before any report
 * existed. Nothing about that is disk pressure; it is purely path ownership.
 *
 * The fix is for run state to live somewhere the engine owns and cleans up itself.
 * `~/.cyan/run` is the run-state sibling of `~/.cyan/cache` (see `resolveCyanCacheDir`
 * in core), and follows the same override precedence.
 *
 * This module is Node/Bun-only and is deliberately NOT re-exported from the package
 * index: `@cyanprint/contracts` is also consumed by the browser and Worker bundles,
 * which must never pull `node:fs` into their dependency graph. Import it explicitly
 * as `@cyanprint/contracts/run-dir`.
 */

/** Directory-name shape the reaper recognises as an engine-allocated run dir. */
const RUN_DIR_PATTERN = /-p(\d+)-[^/]{6}$/;

/**
 * Suffix of the SIBLING file marking a run dir whose contents are meant to outlive the
 * process that made them. Deliberately a sibling rather than a file inside the
 * directory: an allocated dir can be handed to the user as-is (`cyanprint try` writes
 * the generated project straight into one), and the engine must not leave bookkeeping
 * inside output somebody else owns.
 */
const RETAINED_MARKER_SUFFIX = '.retained';

/**
 * A dead owner's directory is only reaped once it has been untouched for this long.
 * The pid check alone is authoritative for liveness; this guards the narrow window
 * where a directory has been created but its owner has not yet been observable.
 */
const ABANDONED_GRACE_MS = 60_000;

/** Retained output (`cyanprint try`, kept sandboxes) is reaped only once it is this old. */
const RETAINED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve the engine-owned run root. Precedence mirrors `resolveCyanCacheDir`:
 * explicit override, then `CYANPRINT_RUN_DIR`, then `~/.cyan/run`.
 */
export function resolveCyanRunDir(override?: string): string {
  const home = safeHomedir();
  return override ?? process.env.CYANPRINT_RUN_DIR ?? (home ? join(home, '.cyan', 'run') : fallbackRunRoot());
}

function safeHomedir(): string | undefined {
  try {
    const home = homedir();
    // Nix build sandboxes point HOME at an unwritable `/homeless-shelter`; an empty
    // or root home is likewise not somewhere to put run state.
    return home && home !== '/' && home !== '/homeless-shelter' ? home : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Last resort when there is no usable home. Every branch avoids `tmpdir()`, which
 * reads `TMPDIR` (POSIX) or `TEMP`/`TMP` (Windows) — exactly the caller-scopable
 * storage this module exists to get off. A wrapper that scopes those vars would
 * otherwise put live run state straight back under a lifetime it does not own.
 */
function fallbackRunRoot(): string {
  if (process.platform === 'win32') {
    // Both are per-user/per-machine persistent locations, not temp storage.
    const base = process.env.LOCALAPPDATA ?? process.env.ProgramData;
    if (!base) {
      // Reaching here means no usable home AND neither persistent base — an environment
      // too stripped to guess in. Falling through to `tmpdir()` would silently reinstate
      // the very failure this module exists to prevent, so ask for the one thing that
      // resolves it unambiguously.
      throw new Error(
        'cyanprint found no durable location for run state: HOME, LOCALAPPDATA and ProgramData are all unusable. ' +
          'Set CYANPRINT_RUN_DIR to a directory whose lifetime you control.',
      );
    }
    return join(base, 'cyanprint', 'run');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'shared';
  return join('/tmp', `cyanprint-run-${uid}`);
}

let sweptRoots: Set<string> | undefined;

/**
 * Allocate a fresh engine-owned directory for one unit of run state.
 *
 * The owning pid is encoded in the name so the reaper can tell abandoned state from
 * live state — leaving `TMPDIR` means leaving the OS `/tmp` reaper behind too, and
 * unreaped run state under `$HOME` would be an unbounded disk leak.
 *
 * `retain` marks output meant to outlive this process (`cyanprint try`'s project
 * directory, sandboxes kept via `keepSandboxes`): the reaper will not treat it as
 * abandoned when the owner exits, only expire it once it is genuinely old.
 */
export async function makeEngineRunDir(
  prefix: string,
  options: { root?: string; retain?: boolean } = {},
): Promise<string> {
  const root = await ensureRunRoot(options.root);
  await reapOnce(root);
  const dir = await mkdtemp(join(root, `${prefix}-p${process.pid}-`));
  if (options.retain) {
    await markEngineRunDirRetained(dir);
  }
  return dir;
}

/**
 * A stable, named child of the run root — for shared engine state that is keyed by
 * content rather than by run (the artifact import cache). Never pid-scoped, so the
 * reaper leaves it alone.
 */
export async function engineRunPath(name: string, root?: string): Promise<string> {
  return join(await ensureRunRoot(root), name);
}

/** Mark an already-allocated run dir as retained output. Best-effort. */
export async function markEngineRunDirRetained(dir: string): Promise<void> {
  await writeFile(`${dir}${RETAINED_MARKER_SUFFIX}`, '', 'utf8').catch(() => undefined);
}

async function ensureRunRoot(override?: string): Promise<string> {
  // An explicitly requested location — `sandboxRoot`, `--out`, `CYANPRINT_RUN_DIR` — is
  // a contract, not a hint. If it cannot be created the caller must hear about it;
  // quietly writing somewhere else would strand their run state at a path they never
  // asked for and will not go looking in.
  const explicit = override ?? process.env.CYANPRINT_RUN_DIR;
  if (explicit) {
    await mkdir(explicit, { recursive: true, mode: 0o700 });
    return explicit;
  }

  // Only the IMPLIED default degrades: an unwritable home (read-only mount, sandboxed
  // build) is the engine's problem to route around, not the caller's mistake.
  const home = safeHomedir();
  if (home) {
    const root = join(home, '.cyan', 'run');
    const created = await mkdir(root, { recursive: true, mode: 0o700 }).then(
      () => true,
      () => false,
    );
    if (created) {
      return root;
    }
  }
  const fallback = fallbackRunRoot();
  await mkdir(fallback, { recursive: true, mode: 0o700 });
  return fallback;
}

async function reapOnce(root: string): Promise<void> {
  sweptRoots ??= new Set();
  if (sweptRoots.has(root)) {
    return;
  }
  sweptRoots.add(root);
  await reapAbandonedEngineRunDirs(root);
}

/**
 * Remove run state nothing owns any more: directories whose owning pid is gone, and
 * retained output past its TTL. Exported for tests.
 *
 * Safety is one-directional — anything that cannot be PROVEN abandoned is left alone.
 * Unrecognised names are skipped, a live (or unknowable) owner is skipped, and every
 * failure is swallowed: a sweep must never be the reason a run fails. Concurrent
 * sweeps are harmless because `rm --force` tolerates the loser's `ENOENT`.
 */
export async function reapAbandonedEngineRunDirs(
  root: string,
  options: { now?: number; graceMs?: number; retainedTtlMs?: number } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? ABANDONED_GRACE_MS;
  const retainedTtlMs = options.retainedTtlMs ?? RETAINED_TTL_MS;
  const reaped: string[] = [];

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const owner = RUN_DIR_PATTERN.exec(entry.name)?.[1];
    if (!owner) {
      continue; // Not an engine-allocated run dir — never ours to delete.
    }
    const dir = join(root, entry.name);
    const info = await stat(dir).catch(() => undefined);
    if (!info) {
      continue;
    }
    const marker = `${dir}${RETAINED_MARKER_SUFFIX}`;
    const age = now - info.mtimeMs;
    const retained = await pathExists(marker);
    const expired = retained ? age > retainedTtlMs : !isProcessAlive(Number(owner)) && age > graceMs;
    if (!expired) {
      continue;
    }
    if (
      await rm(dir, { recursive: true, force: true }).then(
        () => true,
        () => false,
      )
    ) {
      await rm(marker, { force: true }).catch(() => undefined);
      reaped.push(dir);
    }
  }
  return reaped;
}

async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * `kill(pid, 0)` performs the permission/existence check without delivering a signal.
 * `EPERM` means the process exists but belongs to someone else — alive, hands off.
 * Anything unexpected is read as alive so an unknown state can never cause a delete.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
