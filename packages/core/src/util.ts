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

export function safeJoin(root: string, child: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(root, child);
  const fromRoot = relative(resolvedRoot, resolved);
  if (fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\') || isAbsolute(fromRoot)) {
    throw new Error(`Refusing to write outside output directory: ${child}`);
  }
  return resolved;
}
