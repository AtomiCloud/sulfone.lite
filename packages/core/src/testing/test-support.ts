import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeJoin } from '../util';

/** A file's relative path and exact bytes, the common currency for tree comparisons. */
export type BytesFile = {
  path: string;
  bytes: Uint8Array;
};

export function rejectRemovedTestField(
  record: Record<string, unknown>,
  field: string,
  label: string,
  guidance: string,
): void {
  if (record[field] !== undefined) {
    throw new Error(`${label} is no longer supported. ${guidance}`);
  }
}

export function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function readOptionalPath(root: string, value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Test paths must be non-empty strings.');
  }
  return safeJoin(root, value);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(left, right) === 0;
}

/** Replaces `root` with exactly the given files. */
export async function writeBytesTree(root: string, files: BytesFile[]): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const file of files) {
    const target = safeJoin(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, file.bytes);
  }
}

/** Byte-for-byte compare: tree shape AND exact bytes (text and binary). */
export function compareBytesTrees(expected: BytesFile[], actual: BytesFile[]): string | undefined {
  const expectedMap = new Map(expected.map(file => [file.path, file.bytes]));
  const actualMap = new Map(actual.map(file => [file.path, file.bytes]));
  for (const path of [...expectedMap.keys()].sort()) {
    if (!actualMap.has(path)) {
      return `Missing output file: ${path}`;
    }
    const expectedBytes = expectedMap.get(path) ?? new Uint8Array();
    const actualBytes = actualMap.get(path) ?? new Uint8Array();
    if (!bytesEqual(actualBytes, expectedBytes)) {
      return `Output mismatch: ${path}`;
    }
  }
  for (const path of [...actualMap.keys()].sort()) {
    if (!expectedMap.has(path)) {
      return `Unexpected output file: ${path}`;
    }
  }
  return undefined;
}
