import { homedir } from 'node:os';
import { join } from 'node:path';
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
