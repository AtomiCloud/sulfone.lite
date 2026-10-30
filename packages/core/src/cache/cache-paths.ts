import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ArtifactKindSchema } from '@cyanprint/contracts';
import { sha256 } from '../util';

export function resolveCyanCacheDir(override?: string): string {
  return override ?? process.env.CYANPRINT_CACHE_DIR ?? join(homedir(), '.cyan', 'cache');
}

// Cache paths are registry-internal storage: the kind comes from the hydration context,
// never from an authored dependency declaration.
type CacheArtifactRef = { kind: string; owner?: string; name: string; version?: string; integrity?: string };

export function artifactCacheKey(ref: CacheArtifactRef): string {
  const owner = ref.owner ?? 'local';
  return sha256(`${ref.kind}:${owner}:${ref.name}:${ref.version ?? 'latest'}:${ref.integrity ?? ''}`).slice(0, 24);
}

export function artifactCachePath(cacheDir: string, ref: CacheArtifactRef): string {
  return join(
    cacheDir,
    ref.kind,
    `${cacheLabel(ref.owner ?? 'local')}-${cacheLabel(ref.name)}-${artifactCacheKey(ref)}`,
  );
}

function cacheLabel(value: string): string {
  return encodeURIComponent(value).replaceAll('%', '~');
}

/** Ownership marker the engine drops in every cache root it creates or adopts. */
export const CACHE_ROOT_MARKER = '.cyanprint-cache';

const CACHE_KIND_DIRS = new Set<string>([...ArtifactKindSchema.options]);
// The current processor-output layout; v1 (`processor-output`) entries predate executable modes and are
// never read, but `cache clean` still owns and removes them.
export const PROCESSOR_OUTPUT_DIR = 'processor-output-v2';
const LEGACY_PROCESSOR_OUTPUT_DIR = 'processor-output';
const isProcessorOutputDir = (name: string): boolean =>
  name === PROCESSOR_OUTPUT_DIR || name === LEGACY_PROCESSOR_OUTPUT_DIR;
// `<owner>-<name>-<24hex>`, optionally with a hydration staging suffix (`.tmp-…`, `.tmp-….old`).
const ARTIFACT_ENTRY_NAME = /^.+-[0-9a-f]{24}(\.tmp-.+)?$/;
const PROCESSOR_ENTRY_NAME = /^[0-9a-f]{64}$/;

export type CacheRootState =
  /** The directory does not exist or is empty. */
  | { state: 'empty' }
  /** The engine's ownership marker is present. */
  | { state: 'marked'; entries: string[] }
  /** No marker (a cache from before markers existed), but every entry matches the engine's naming. */
  | { state: 'engine-shaped'; entries: string[] }
  /** Holds entries the engine never creates; `foreign` lists a sample of them. */
  | { state: 'foreign'; foreign: string[] };

async function childNames(path: string): Promise<{ name: string; directory: boolean }[]> {
  return (await readdir(path, { withFileTypes: true }).catch(() => [])).map(entry => ({
    name: entry.name,
    directory: entry.isDirectory(),
  }));
}

/** Classifies a cache root by ownership marker, falling back to the engine's own naming scheme. */
export async function inspectCacheRoot(root: string): Promise<CacheRootState> {
  const top = await childNames(root);
  if (top.length === 0) {
    return { state: 'empty' };
  }
  if (top.some(entry => entry.name === CACHE_ROOT_MARKER)) {
    // A marked root is the engine's, but only its own top-level directories are ever removed.
    const owned = top.map(entry => entry.name).filter(name => CACHE_KIND_DIRS.has(name) || isProcessorOutputDir(name));
    return { state: 'marked', entries: owned };
  }
  const foreign: string[] = [];
  for (const entry of top) {
    const isProcessorOutput = isProcessorOutputDir(entry.name);
    if (!entry.directory || !(isProcessorOutput || CACHE_KIND_DIRS.has(entry.name))) {
      foreign.push(entry.name);
      continue;
    }
    const pattern = isProcessorOutput ? PROCESSOR_ENTRY_NAME : ARTIFACT_ENTRY_NAME;
    for (const child of await childNames(join(root, entry.name))) {
      if (!pattern.test(child.name)) {
        foreign.push(`${entry.name}/${child.name}`);
      }
    }
  }
  return foreign.length > 0
    ? { state: 'foreign', foreign }
    : { state: 'engine-shaped', entries: top.map(entry => entry.name) };
}

/**
 * Marks a cache root as engine-owned when the engine creates or uses it. A directory that
 * already holds foreign files is never claimed, so `cache clean` can still refuse it.
 * Best-effort: a read-only cache root degrades to "unmarked".
 */
export async function claimCacheRoot(root: string): Promise<void> {
  try {
    // Cheap fast path: this runs on every cache write.
    if (await Bun.file(join(root, CACHE_ROOT_MARKER)).exists()) {
      return;
    }
    await mkdir(root, { recursive: true });
    const state = await inspectCacheRoot(root);
    if (state.state === 'foreign' || state.state === 'marked') {
      return;
    }
    await writeFile(join(root, CACHE_ROOT_MARKER), 'cyanprint cache\n', { flag: 'wx' }).catch(() => undefined);
  } catch {
    // ignore
  }
}
