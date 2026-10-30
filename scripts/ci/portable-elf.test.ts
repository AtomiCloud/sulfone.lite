import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_GLIBC,
  glibcCeiling,
  maxGlibcVersion,
  portabilityProblems,
  readElf,
  standardInterpreter,
} from './portable-elf';

const STANDARD_AMD64 = '/lib64/ld-linux-x86-64.so.2';
const NIX_INTERPRETER = '/nix/store/8kvxvr3pmsypxiypq4g8zy13glnfr7nx-glibc-2.42-67/lib/ld-linux-x86-64.so.2';

type Fixture = {
  machine?: number;
  interpreter?: string;
  runpath?: string;
  rpath?: string;
  /** Required symbol versions per needed file, e.g. { 'libc.so.6': ['GLIBC_2.17'] }. */
  needs?: Record<string, string[]>;
  /** Added to every PT_LOAD vaddr so vaddr != file offset. */
  vaddrBase?: number;
  /** Leave DT_STRTAB out of the dynamic section. */
  omitStrtab?: boolean;
};

// Minimal ELF64 LE: header, [PT_INTERP], PT_LOAD (vaddr = vaddrBase + offset), PT_DYNAMIC, then data.
function buildElf({
  machine = 62,
  interpreter,
  runpath,
  rpath,
  needs,
  vaddrBase = 0,
  omitStrtab = false,
}: Fixture): Uint8Array {
  const encoder = new TextEncoder();
  const interp = interpreter === undefined ? undefined : encoder.encode(`${interpreter}\0`);

  const strings: number[] = [0];
  const addString = (text: string): number => {
    const at = strings.length;
    strings.push(...encoder.encode(text), 0);
    return at;
  };
  const runpathValue = runpath === undefined ? undefined : addString(runpath);
  const rpathValue = rpath === undefined ? undefined : addString(rpath);
  const needEntries = Object.entries(needs ?? {}).map(([file, versions]) => ({
    file: addString(file),
    versions: versions.map(version => addString(version)),
  }));

  const phnum = interp ? 3 : 2;
  const phoff = 64;
  const interpOffset = phoff + phnum * 56;
  const strtabOffset = interpOffset + (interp?.length ?? 0);
  const align8 = (value: number): number => value + ((8 - (value % 8)) % 8);
  const verneedOffset = align8(strtabOffset + strings.length);
  const verneedSize = needEntries.reduce((sum, entry) => sum + 16 + entry.versions.length * 16, 0);
  const dynamicOffset = align8(verneedOffset + verneedSize);

  const entries: Array<[number, number]> = [];
  if (!omitStrtab) entries.push([5, vaddrBase + strtabOffset]);
  if (runpathValue !== undefined) entries.push([29, runpathValue]);
  if (rpathValue !== undefined) entries.push([15, rpathValue]);
  if (needEntries.length > 0) {
    entries.push([0x6ffffffe, vaddrBase + verneedOffset], [0x6fffffff, needEntries.length]);
  }
  entries.push([0, 0]);
  const total = dynamicOffset + entries.length * 16;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  view.setUint16(18, machine, true);
  view.setBigUint64(32, BigInt(phoff), true);
  view.setUint16(54, 56, true);
  view.setUint16(56, phnum, true);
  const header = (index: number, type: number, offset: number, size: number): void => {
    const base = phoff + index * 56;
    view.setUint32(base, type, true);
    view.setBigUint64(base + 8, BigInt(offset), true);
    view.setBigUint64(base + 16, BigInt(vaddrBase + offset), true);
    view.setBigUint64(base + 32, BigInt(size), true);
  };
  let next = 0;
  if (interp) header(next++, 3, interpOffset, interp.length);
  header(next++, 1, 0, total);
  header(next, 2, dynamicOffset, entries.length * 16);
  if (interp) bytes.set(interp, interpOffset);
  bytes.set(strings, strtabOffset);

  let entry = verneedOffset;
  needEntries.forEach((need, index) => {
    const auxStart = 16;
    const entrySize = 16 + need.versions.length * 16;
    view.setUint16(entry, 1, true);
    view.setUint16(entry + 2, need.versions.length, true);
    view.setUint32(entry + 4, need.file, true);
    view.setUint32(entry + 8, auxStart, true);
    view.setUint32(entry + 12, index === needEntries.length - 1 ? 0 : entrySize, true);
    need.versions.forEach((name, auxIndex) => {
      const aux = entry + auxStart + auxIndex * 16;
      view.setUint16(aux + 6, 2, true);
      view.setUint32(aux + 8, name, true);
      view.setUint32(aux + 12, auxIndex === need.versions.length - 1 ? 0 : 16, true);
    });
    entry += entrySize;
  });

  entries.forEach(([tag, value], index) => {
    view.setBigInt64(dynamicOffset + index * 16, BigInt(tag), true);
    view.setBigUint64(dynamicOffset + index * 16 + 8, BigInt(value), true);
  });
  return bytes;
}

describe('portable linux ELF gate', () => {
  test('accepts the standard interpreter without RUNPATH', () => {
    expect(portabilityProblems(readElf(buildElf({ interpreter: STANDARD_AMD64 })))).toEqual([]);
  });

  test('accepts the standard aarch64 interpreter', () => {
    const info = readElf(buildElf({ machine: 183, interpreter: '/lib/ld-linux-aarch64.so.1' }));
    expect(standardInterpreter(info)).toBe('/lib/ld-linux-aarch64.so.1');
    expect(portabilityProblems(info)).toEqual([]);
  });

  test('rejects a /nix/store interpreter', () => {
    const problems = portabilityProblems(readElf(buildElf({ interpreter: NIX_INTERPRETER })));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Nix store');
  });

  test('rejects a /nix/store RUNPATH and RPATH', () => {
    const info = readElf(
      buildElf({
        interpreter: STANDARD_AMD64,
        runpath: '/nix/store/abc-glibc/lib:/usr/lib',
        rpath: '/nix/store/x/lib',
      }),
    );
    expect(info.runpath).toEqual(['/nix/store/abc-glibc/lib', '/usr/lib']);
    const problems = portabilityProblems(info);
    expect(problems.some(problem => problem.startsWith('RUNPATH'))).toBe(true);
    expect(problems.some(problem => problem.startsWith('RPATH'))).toBe(true);
  });

  test('allows a non-Nix RUNPATH', () => {
    expect(portabilityProblems(readElf(buildElf({ interpreter: STANDARD_AMD64, runpath: '$ORIGIN/lib' })))).toEqual([]);
  });

  test('rejects an unexpected or missing interpreter (static binaries are rejected on purpose)', () => {
    expect(portabilityProblems(readElf(buildElf({ interpreter: '/opt/glibc/ld.so' })))).toHaveLength(1);
    expect(portabilityProblems(readElf(buildElf({})))[0]).toContain('no PT_INTERP');
  });

  test('refuses non-ELF input', () => {
    expect(() => readElf(new TextEncoder().encode('#!/bin/sh\n'.repeat(20)))).toThrow('not an ELF file');
  });

  test('resolves the string table through a vaddr that differs from the file offset', () => {
    const info = readElf(
      buildElf({
        interpreter: STANDARD_AMD64,
        runpath: '/nix/store/abc-glibc/lib',
        needs: { 'libc.so.6': ['GLIBC_2.17'] },
        vaddrBase: 0x400000,
      }),
    );
    expect(info.runpath).toEqual(['/nix/store/abc-glibc/lib']);
    expect(info.glibcVersions).toEqual(['GLIBC_2.17']);
  });

  test('treats RUNPATH/RPATH without a string table as a problem', () => {
    const info = readElf(buildElf({ interpreter: STANDARD_AMD64, runpath: '/usr/lib', omitStrtab: true }));
    expect(info.unreadablePaths).toBe(true);
    expect(portabilityProblems(info).some(problem => problem.includes('no dynamic string table'))).toBe(true);
    expect(portabilityProblems(readElf(buildElf({ interpreter: STANDARD_AMD64, omitStrtab: true })))).toEqual([]);
  });

  test('accepts a header-sized-only file as ELF rather than "not an ELF file"', () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    expect(() => readElf(bytes)).not.toThrow('not an ELF file');
  });
});

describe('glibc symbol version ceiling', () => {
  const libc = (...versions: string[]): Fixture => ({
    interpreter: STANDARD_AMD64,
    needs: { 'libc.so.6': versions },
    vaddrBase: 0x10000,
  });

  test('reads libc.so.6 versions and reports the numeric max', () => {
    const info = readElf(buildElf(libc('GLIBC_2.2.5', 'GLIBC_2.17', 'GLIBC_2.9', 'GLIBC_PRIVATE')));
    expect(info.glibcVersions).toEqual(['GLIBC_2.2.5', 'GLIBC_2.17', 'GLIBC_2.9', 'GLIBC_PRIVATE']);
    expect(maxGlibcVersion(info)).toBe('2.17');
    expect(portabilityProblems(info)).toEqual([]);
  });

  test('only counts libc.so.6, not other needed libraries', () => {
    const info = readElf(
      buildElf({
        interpreter: STANDARD_AMD64,
        needs: { 'libm.so.6': ['GLIBC_2.99'], 'libc.so.6': ['GLIBC_2.17'] },
      }),
    );
    expect(info.glibcVersions).toEqual(['GLIBC_2.17']);
    expect(maxGlibcVersion(info)).toBe('2.17');
  });

  test('compares numerically, not lexically (2.9 < 2.28 < 2.100)', () => {
    expect(maxGlibcVersion(readElf(buildElf(libc('GLIBC_2.9', 'GLIBC_2.28'))))).toBe('2.28');
    expect(maxGlibcVersion(readElf(buildElf(libc('GLIBC_2.9', 'GLIBC_2.100', 'GLIBC_2.28'))))).toBe('2.100');
  });

  test('accepts exactly the ceiling and fails anything above it', () => {
    expect(portabilityProblems(readElf(buildElf(libc('GLIBC_2.28'))))).toEqual([]);
    const problems = portabilityProblems(readElf(buildElf(libc('GLIBC_2.17', 'GLIBC_2.34', 'GLIBC_2.29'))));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('GLIBC_2.29, GLIBC_2.34');
    expect(problems[0]).toContain(DEFAULT_MAX_GLIBC);
  });

  test('honours an explicit ceiling', () => {
    const info = readElf(buildElf(libc('GLIBC_2.34')));
    expect(portabilityProblems(info, '2.35')).toEqual([]);
    expect(portabilityProblems(info, '2.17')).toHaveLength(1);
  });

  test('has no version requirement when nothing is needed', () => {
    const info = readElf(buildElf({ interpreter: STANDARD_AMD64 }));
    expect(info.glibcVersions).toEqual([]);
    expect(maxGlibcVersion(info)).toBeUndefined();
  });

  test('reads the ceiling from PORTABLE_MAX_GLIBC', () => {
    expect(glibcCeiling({})).toBe('2.28');
    expect(glibcCeiling({ PORTABLE_MAX_GLIBC: '2.31' })).toBe('2.31');
    expect(() => glibcCeiling({ PORTABLE_MAX_GLIBC: 'new' })).toThrow('PORTABLE_MAX_GLIBC');
  });
});
