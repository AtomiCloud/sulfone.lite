// Small filesystem utilities shared by the CyanPrint runtime and SDK helpers.
// Moved verbatim from the artifact-runner so helper reads/writes go through the
// exact same safe-path and binary-handling logic as the runtime.

import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { isCyanMetadataPath } from '@cyanprint/contracts';
import type { VfsFile } from './sdk-types';

export type ReadVfsOptions = {
  /** Skip a file by its VFS-relative path. CyanPrint metadata files are always skipped. */
  ignore?: (relativePath: string) => boolean;
};

export async function writeVfsFiles(root: string, files: VfsFile[]): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const file of files) {
    const target = safeJoin(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      file.bytesBase64 !== undefined ? Buffer.from(file.bytesBase64, 'base64') : (file.content ?? ''),
    );
  }
}

export async function readVfsFiles(root: string, options: ReadVfsOptions = {}): Promise<VfsFile[]> {
  const files: VfsFile[] = [];
  await walk(root, async path => {
    const relativePath = relative(root, path)
      .split(/[\\/]+/)
      .join('/');
    if (isCyanMetadataPath(relativePath) || options.ignore?.(relativePath)) {
      return;
    }
    const bytes = await readFile(path);
    const content = decodeUtf8(bytes);
    files.push(
      content === undefined
        ? { path: relativePath, bytesBase64: Buffer.from(bytes).toString('base64') }
        : { path: relativePath, content },
    );
  });
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

// Locale-independent (code-unit) ordering so artifact inputs/outputs are identical across machines.
function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function walk(root: string, visit: (path: string) => Promise<void>, base = root): Promise<void> {
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory()) {
    return;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const entryInfo = await lstat(path);
    if (entryInfo.isSymbolicLink()) {
      throw new Error(
        `unsafe output path: ${relative(base, path)
          .split(/[\\/]+/)
          .join('/')}`,
      );
    }
    if (entryInfo.isDirectory()) {
      await walk(path, visit, base);
    } else if (entryInfo.isFile()) {
      await visit(path);
    }
  }
}

export function safeJoin(root: string, path: string): string {
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.includes('\0')) {
    throw new Error(`Unsafe artifact output path: ${path}`);
  }
  const parts = path.split(/[\\/]+/).filter(part => part && part !== '.');
  if (parts.length === 0 || parts.some(part => part === '..')) {
    throw new Error(`Unsafe artifact output path: ${path}`);
  }
  return join(root, ...parts);
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const encoded = new TextEncoder().encode(content);
  if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) {
    return undefined;
  }
  return content;
}

export function overlayFiles(base: VfsFile[], overlay: VfsFile[]): VfsFile[] {
  const files = new Map(base.map(file => [file.path, file]));
  for (const file of overlay) {
    files.set(file.path, file);
  }
  return [...files.values()].sort((left, right) => comparePaths(left.path, right.path));
}
