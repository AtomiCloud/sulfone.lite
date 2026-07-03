import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { VfsFile } from '@cyanprint/contracts';
import { sha256, stableConfig } from '../util';
import { resolveCyanCacheDir } from './cache-paths';

/**
 * Content-addressed cache of hermetic processor outputs. A processor's output is a pure
 * function of (artifact integrity, config, input file set), so the cache key is
 * sha256(integrity ‖ canonicalJSON(config) ‖ digest(input files: path + bytes + type)).
 * A hit skips the invocation entirely.
 */
export function processorCacheKey(args: { integrity: string; config: unknown; inputFiles: VfsFile[] }): string {
  const parts: string[] = [args.integrity, '\0', stableConfig(args.config), '\0'];
  const sorted = [...args.inputFiles].sort((left, right) => (left.path < right.path ? -1 : 1));
  for (const file of sorted) {
    const type = file.bytesBase64 !== undefined ? 'binary' : 'text';
    const bytes = file.bytesBase64 !== undefined ? file.bytesBase64 : (file.content ?? '');
    parts.push(file.path, '\0', type, '\0', sha256(bytes), '\0');
  }
  return sha256(parts.join(''));
}

export function processorCacheDir(cacheDirOverride?: string): string {
  return join(resolveCyanCacheDir(cacheDirOverride), 'processor-output');
}

function entryPath(root: string, key: string): string {
  return join(root, key, 'output.json');
}

export async function readProcessorCache(args: { key: string; cacheDir?: string }): Promise<VfsFile[] | undefined> {
  const path = entryPath(processorCacheDir(args.cacheDir), args.key);
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { files?: VfsFile[] };
    return Array.isArray(parsed.files) ? parsed.files : undefined;
  } catch {
    return undefined;
  }
}

export async function writeProcessorCache(args: { key: string; files: VfsFile[]; cacheDir?: string }): Promise<void> {
  const root = processorCacheDir(args.cacheDir);
  const path = entryPath(root, args.key);
  await mkdir(dirname(path), { recursive: true });
  // Atomic replace: a concurrent reader must never observe a partial JSON file.
  const staging = `${path}.${process.pid}.tmp`;
  await Bun.write(staging, JSON.stringify({ files: args.files }));
  await rename(staging, path);
  await evictStaleProcessorCacheEntries(root, args.key);
}

// Entries are content-addressed and never reused once any input changes, so they accrete
// forever without a sweep. Age-based eviction mirrors the runtime import-dir sweep.
const STALE_PROCESSOR_CACHE_MS = 30 * 24 * 60 * 60 * 1000;

async function evictStaleProcessorCacheEntries(root: string, keepKey: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - STALE_PROCESSOR_CACHE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepKey) {
      continue;
    }
    const dir = join(root, entry.name);
    const info = await stat(dir).catch(() => undefined);
    if (info && info.mtimeMs < cutoff) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
