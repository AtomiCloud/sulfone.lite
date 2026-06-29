import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactDependency } from '@cyanprint/contracts';
import { sha256 } from '../util';

export function resolveCyanCacheDir(override?: string): string {
  return override ?? process.env.CYANPRINT_CACHE_DIR ?? join(homedir(), '.cyan', 'cache');
}

export function artifactCacheKey(ref: ArtifactDependency & { version?: string; integrity?: string }): string {
  const owner = ref.owner ?? 'local';
  return sha256(`${ref.kind}:${owner}:${ref.name}:${ref.version ?? 'latest'}:${ref.integrity ?? ''}`).slice(0, 24);
}

export function artifactCachePath(
  cacheDir: string,
  ref: ArtifactDependency & { version?: string; integrity?: string },
): string {
  return join(
    cacheDir,
    ref.kind,
    `${cacheLabel(ref.owner ?? 'local')}-${cacheLabel(ref.name)}-${artifactCacheKey(ref)}`,
  );
}

function cacheLabel(value: string): string {
  return encodeURIComponent(value).replaceAll('%', '~');
}
