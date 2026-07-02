import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { readTemplateTarFiles } from '@cyanprint/contracts';
import { safeJoin, sha256 } from '@cyanprint/core';
import { decompress } from 'fzstd';

type LocalObjectPackage = {
  cyanprint: 4;
  files: Array<{ path: string; content: string }>;
};

const ignoredNames = new Set(['.git', 'node_modules', '.tmp']);
const ignoredArchiveFiles = new Set(['cyan.yaml', 'README.md', 'README.MD', 'cyan.test.yaml', 'answers.json']);
const textEncoder = new TextEncoder();

async function collectFiles(root: string, dir = root): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(root, fullPath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    out.push({ path: relative(root, fullPath), content: await readFile(fullPath, 'utf8') });
  }
  // Code-unit ordering: entry order feeds the payload hash and must not vary by host locale.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function createLocalObjectPayload(
  root: string,
): Promise<{ payload: string; sha256: string; size: number }> {
  const payload = JSON.stringify({ cyanprint: 4, files: await collectFiles(root) } satisfies LocalObjectPackage);
  return { payload, sha256: sha256(payload), size: new TextEncoder().encode(payload).byteLength };
}

export async function createArtifactTextObject(
  path: string,
): Promise<{ payload: string; sha256: string; size: number }> {
  const payload = await readFile(path, 'utf8');
  return objectPayload(payload);
}

export async function createTemplateArchivePayload(
  root: string,
  options: { bundledEntry?: string } = {},
): Promise<{ payload: Uint8Array; sha256: string; size: number }> {
  const files = await collectArchiveFilePaths(root, options.bundledEntry);
  if (files.length === 0) {
    throw new Error(
      'Template archive has no files. Use --script-only for templates that intentionally emit everything from code.',
    );
  }
  return objectBytesPayload(await createTarPayload(root, files));
}

async function collectArchiveFilePaths(root: string, bundledEntry?: string): Promise<string[]> {
  const files: string[] = [];
  const normalizedBundledEntry = bundledEntry?.split(/[\\/]+/).join('/');
  async function walk(dir = root): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (ignoredNames.has(entry.name)) {
        continue;
      }
      const fullPath = join(dir, entry.name);
      const path = relative(root, fullPath)
        .split(/[\\/]+/)
        .join('/');
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (ignoredArchiveFiles.has(path) || path === normalizedBundledEntry || path.startsWith('.cyan_')) {
          continue;
        }
        files.push(path);
      }
    }
  }
  await walk();
  return files.sort();
}

export async function unpackTemplateArchivePayload(payload: string | Uint8Array, outDir: string): Promise<void> {
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  // Check for real archive formats FIRST: a tar whose first entry name starts with "{"
  // (e.g. an interpolation-named file like "{{name}}.txt") would otherwise be mis-sniffed
  // as a legacy JSON payload and fail with a JSON parse error.
  if (isZstdFrame(bytes) || isUstarArchive(bytes)) {
    const files = readTemplateTarFiles(isZstdFrame(bytes) ? decompress(bytes) : bytes);
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    for (const file of files) {
      const target = safeJoin(outDir, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
    }
    return;
  }
  if (typeof payload === 'string' && payload.trimStart().startsWith('{')) {
    await unpackLegacyJsonTemplateArchive(payload, outDir);
    return;
  }
  const legacyPayload = decodeLegacyJsonArchive(bytes);
  if (legacyPayload) {
    await unpackLegacyJsonTemplateArchive(legacyPayload, outDir);
    return;
  }
  const files = readTemplateTarFiles(bytes);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const file of files) {
    const target = safeJoin(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
}

function decodeLegacyJsonArchive(bytes: Uint8Array): string | undefined {
  try {
    const payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return payload.trimStart().startsWith('{') ? payload : undefined;
  } catch {
    return undefined;
  }
}

async function unpackLegacyJsonTemplateArchive(payload: string, outDir: string): Promise<void> {
  const parsed = JSON.parse(payload) as {
    cyanArchive?: number;
    files?: Array<{ path?: unknown; bytesBase64?: unknown }>;
  };
  if (parsed.cyanArchive !== 1 || !Array.isArray(parsed.files)) {
    throw new Error('Invalid CyanPrint template archive.');
  }
  const seenPaths = new Set<string>();
  const files = parsed.files.map(file => {
    if (typeof file.path !== 'string' || typeof file.bytesBase64 !== 'string') {
      throw new Error('Invalid CyanPrint template archive file entry.');
    }
    const normalizedPath = file.path.split(/[\\/]+/).join('/');
    if (seenPaths.has(normalizedPath)) {
      throw new Error(`Duplicate CyanPrint template archive file path: ${file.path}`);
    }
    seenPaths.add(normalizedPath);
    return { path: file.path, bytes: Buffer.from(file.bytesBase64, 'base64') };
  });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const file of files) {
    const target = safeJoin(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
}

async function createTarPayload(root: string, paths: string[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (const path of paths) {
    const bytes = await readFile(safeJoin(root, path));
    chunks.push(createTarHeader(path, bytes.byteLength), bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding > 0) {
      chunks.push(new Uint8Array(padding));
    }
  }
  chunks.push(new Uint8Array(1024));
  return concatBytes(chunks);
}

function createTarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const { name, prefix } = splitUstarPath(path);
  writeTarString(header, 0, 100, name);
  writeTarString(header, 100, 8, '0000644');
  writeTarString(header, 108, 8, '0000000');
  writeTarString(header, 116, 8, '0000000');
  writeTarString(header, 124, 12, size.toString(8).padStart(11, '0'));
  writeTarString(header, 136, 12, '00000000000');
  header.fill(32, 148, 156);
  header[156] = 48;
  writeTarString(header, 257, 6, 'ustar');
  writeTarString(header, 263, 2, '00');
  if (prefix) {
    writeTarString(header, 345, 155, prefix);
  }
  const checksum = header
    .reduce((sum, byte) => sum + byte, 0)
    .toString(8)
    .padStart(6, '0');
  writeTarString(header, 148, 8, `${checksum}\0 `);
  return header;
}

function splitUstarPath(path: string): { name: string; prefix?: string } {
  if (byteLength(path) <= 100) {
    return { name: path };
  }
  const parts = path.split('/');
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (byteLength(prefix) <= 155 && byteLength(name) <= 100) {
      return { prefix, name };
    }
  }
  throw new Error(`Template archive path is too long for ustar: ${path}`);
}

function writeTarString(header: Uint8Array, offset: number, length: number, value: string): void {
  header.set(textEncoder.encode(value).slice(0, length), offset);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isZstdFrame(payload: Uint8Array): boolean {
  return payload[0] === 0x28 && payload[1] === 0xb5 && payload[2] === 0x2f && payload[3] === 0xfd;
}

function isUstarArchive(payload: Uint8Array): boolean {
  // ustar magic lives at offset 257 of the first tar header block.
  if (payload.byteLength < 263) {
    return false;
  }
  return (
    payload[257] === 0x75 && // u
    payload[258] === 0x73 && // s
    payload[259] === 0x74 && // t
    payload[260] === 0x61 && // a
    payload[261] === 0x72 // r
  );
}

function objectPayload(payload: string): { payload: string; sha256: string; size: number } {
  return { payload, sha256: sha256(payload), size: textEncoder.encode(payload).byteLength };
}

function objectBytesPayload(payload: Uint8Array): { payload: Uint8Array; sha256: string; size: number } {
  return { payload, sha256: sha256(payload), size: payload.byteLength };
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export async function unpackLocalObjectPayload(payload: string, outDir: string): Promise<void> {
  const parsed = JSON.parse(payload) as LocalObjectPackage;
  if (parsed.cyanprint !== 4 || !Array.isArray(parsed.files)) {
    throw new Error('Invalid CyanPrint local object package.');
  }
  const seenPaths = new Set<string>();
  const files = parsed.files.map(file => {
    if (typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('Invalid CyanPrint local object file entry.');
    }
    const normalizedPath = file.path.split(/[\\/]+/).join('/');
    if (seenPaths.has(normalizedPath)) {
      throw new Error(`Duplicate CyanPrint local object file path: ${file.path}`);
    }
    seenPaths.add(normalizedPath);
    return file;
  });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const file of files) {
    const target = safeJoin(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
}
