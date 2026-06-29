export type TemplateTarFile = {
  path: string;
  bytes: Uint8Array;
};

export function validateTemplateTarPayload(payload: Uint8Array): string | undefined {
  try {
    readTemplateTarFiles(payload);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'template archive payload is not a valid tar archive';
  }
}

export function readTemplateTarFiles(payload: Uint8Array): TemplateTarFile[] {
  const files: TemplateTarFile[] = [];
  const seenPaths = new Set<string>();
  let offset = 0;
  while (offset + 512 <= payload.byteLength) {
    const header = payload.slice(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (files.length === 0) {
        throw new Error('template archive payload is empty');
      }
      return files;
    }
    validateTarChecksum(header);
    const path = tarEntryPath(header);
    if (!isSafeArchivePath(path)) {
      throw new Error(`template archive payload has an unsafe file path: ${path}`);
    }
    const normalizedPath = normalizeArchivePath(path);
    const typeFlag = header[156] ?? 0;
    const size = parseTarOctal(header.slice(124, 136), `template archive payload has an invalid file size: ${path}`);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + Math.ceil(size / 512) * 512;
    if (dataEnd > payload.byteLength || nextOffset > payload.byteLength) {
      throw new Error('template archive payload is truncated');
    }
    if (typeFlag === 0 || typeFlag === 48) {
      if (seenPaths.has(normalizedPath)) {
        throw new Error(`template archive payload has a duplicate file path: ${path}`);
      }
      seenPaths.add(normalizedPath);
      files.push({ path: normalizedPath, bytes: payload.slice(dataStart, dataEnd) });
    } else if (typeFlag !== 53) {
      throw new Error(`template archive payload has an unsupported entry type: ${path}`);
    }
    offset = nextOffset;
  }
  throw new Error('template archive payload is truncated');
}

export function isSafeArchivePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.includes('\0')) {
    return false;
  }
  return path.split(/[\\/]+/).every(part => part.length > 0 && part !== '.' && part !== '..');
}

export function normalizeArchivePath(path: string): string {
  return path.split(/[\\/]+/).join('/');
}

function tarEntryPath(header: Uint8Array): string {
  const name = decodeTarString(header.slice(0, 100));
  const prefix = decodeTarString(header.slice(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

function validateTarChecksum(header: Uint8Array): void {
  const expected = parseTarOctal(header.slice(148, 156), 'template archive payload has an invalid header checksum');
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  if (expected !== actual) {
    throw new Error('template archive payload has an invalid header checksum');
  }
}

function parseTarOctal(bytes: Uint8Array, message: string): number {
  const text = decodeTarString(bytes).trim();
  if (!/^[0-7]*$/.test(text)) {
    throw new Error(message);
  }
  const value = Number.parseInt(text || '0', 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(message);
  }
  return value;
}

function decodeTarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.slice(0, end) : bytes);
}
