import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { exists } from '../util';

/**
 * Default workspace roots for local dependency lookup, in priority order: the
 * template's own repo root (nearest ancestor holding `.git`) FIRST, so resolution
 * does not depend on where the CLI was launched, THEN the process cwd as a
 * fallback (a cached registry template can live under a `$HOME` that is itself a
 * dotfiles repo, while its dependencies sit beside the cwd). Deduplicated. Shared
 * by generation and probe resolution so a dependency found by one is found by the
 * other.
 */
export async function defaultWorkspaceRoots(templateDir: string): Promise<string[]> {
  const roots: string[] = [];
  // Follow symlinks: a linked template dir must search the repo it really lives in.
  let current = await realpath(resolve(templateDir)).catch(() => resolve(templateDir));
  while (true) {
    if (await exists(join(current, '.git'))) {
      roots.push(current);
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const cwd = process.cwd();
  if (!roots.includes(cwd)) {
    roots.push(cwd);
  }
  return roots;
}
