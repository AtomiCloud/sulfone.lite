import { describe, expect, test } from 'bun:test';
import { portabilityProblems, readElf, standardInterpreter } from './portable-elf';

const STANDARD_AMD64 = '/lib64/ld-linux-x86-64.so.2';
const NIX_INTERPRETER = '/nix/store/8kvxvr3pmsypxiypq4g8zy13glnfr7nx-glibc-2.42-67/lib/ld-linux-x86-64.so.2';

type Fixture = { machine?: number; interpreter?: string; runpath?: string; rpath?: string };

// Minimal ELF64 LE: header, [PT_INTERP], PT_LOAD (identity mapped), PT_DYNAMIC, then data.
function buildElf({ machine = 62, interpreter, runpath, rpath }: Fixture): Uint8Array {
  const encoder = new TextEncoder();
  const interp = interpreter === undefined ? undefined : encoder.encode(`${interpreter}\0`);
  const strings = encoder.encode(`\0${runpath ?? ''}\0${rpath ?? ''}\0`);
  const runpathOffset = 1;
  const rpathOffset = 1 + (runpath ?? '').length + 1;
  const phnum = interp ? 3 : 2;
  const phoff = 64;
  const interpOffset = phoff + phnum * 56;
  const strtabOffset = interpOffset + (interp?.length ?? 0);
  const dynamicOffset = strtabOffset + strings.length + ((8 - ((strtabOffset + strings.length) % 8)) % 8);
  const entries: Array<[number, number]> = [[5, strtabOffset]];
  if (runpath !== undefined) entries.push([29, runpathOffset]);
  if (rpath !== undefined) entries.push([15, rpathOffset]);
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
    view.setBigUint64(base + 16, BigInt(offset), true);
    view.setBigUint64(base + 32, BigInt(size), true);
  };
  let next = 0;
  if (interp) header(next++, 3, interpOffset, interp.length);
  header(next++, 1, 0, total);
  header(next, 2, dynamicOffset, entries.length * 16);
  if (interp) bytes.set(interp, interpOffset);
  bytes.set(strings, strtabOffset);
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

  test('rejects an unexpected or missing interpreter', () => {
    expect(portabilityProblems(readElf(buildElf({ interpreter: '/opt/glibc/ld.so' })))).toHaveLength(1);
    expect(portabilityProblems(readElf(buildElf({})))[0]).toContain('no PT_INTERP');
  });

  test('refuses non-ELF input', () => {
    expect(() => readElf(new TextEncoder().encode('#!/bin/sh\n'.repeat(20)))).toThrow('not an ELF file');
  });
});
