import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function remove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Map over items with a bounded number of concurrent workers, preserving input order in the
 * result. A limit <= 1 runs sequentially. Used to run independent test cases in parallel.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Deterministic, locale-independent path ordering (code-unit compare). `localeCompare` depends
 * on the host ICU/locale and can order unicode or mixed-case paths differently across machines,
 * which would produce spurious `.cyan_state.yaml` diffs.
 */
export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function safeJoin(root: string, child: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(root, child);
  const fromRoot = relative(resolvedRoot, resolved);
  if (fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\') || isAbsolute(fromRoot)) {
    throw new Error(`Refusing to write outside output directory: ${child}`);
  }
  return resolved;
}
