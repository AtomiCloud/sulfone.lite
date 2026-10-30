// Release portability gate for Linux binaries.
//
// `bun build --compile --target=bun-linux-<arch>` copies the runtime it is
// running on whenever the target matches the host. In the Nix dev shell that
// runtime is the nixpkgs bun, which is patchelf'd to a /nix/store glibc
// interpreter, so the shipped binary dies with "cannot execute: required file
// not found" on every non-Nix Linux. This module reads the ELF headers directly
// (no readelf/binutils dependency) to expose the interpreter and RPATH/RUNPATH,
// names the standard interpreter for each machine type, and fails a binary that
// would not start on a plain distro.
//
// CLI (used by scripts/ci/portable-linux.sh and the release hooks):
//   bun run scripts/ci/portable-elf.ts interpreter <binary>   print the standard interpreter
//   bun run scripts/ci/portable-elf.ts check <binary...>       fail on a non-portable binary

const EM_X86_64 = 62;
const EM_AARCH64 = 183;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const DT_NULL = 0;
const DT_STRTAB = 5;
const DT_RPATH = 15;
const DT_RUNPATH = 29;

export const STANDARD_INTERPRETERS: Record<number, string> = {
  [EM_X86_64]: '/lib64/ld-linux-x86-64.so.2',
  [EM_AARCH64]: '/lib/ld-linux-aarch64.so.1',
};

export type ElfInfo = {
  machine: number;
  interpreter: string | undefined;
  rpath: string[];
  runpath: string[];
};

export function readElf(bytes: Uint8Array): ElfInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isElf = bytes.length > 64 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
  if (!isElf) {
    throw new Error('not an ELF file.');
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) {
    throw new Error('only 64-bit little-endian ELF files are supported.');
  }
  const machine = view.getUint16(18, true);
  const phoff = Number(view.getBigUint64(32, true));
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);

  const loads: Array<{ vaddr: number; offset: number; filesz: number }> = [];
  let interpreter: string | undefined;
  let dynamic: { offset: number; filesz: number } | undefined;
  for (let index = 0; index < phnum; index++) {
    const base = phoff + index * phentsize;
    const type = view.getUint32(base, true);
    const offset = Number(view.getBigUint64(base + 8, true));
    const vaddr = Number(view.getBigUint64(base + 16, true));
    const filesz = Number(view.getBigUint64(base + 32, true));
    if (type === PT_LOAD) loads.push({ vaddr, offset, filesz });
    if (type === PT_DYNAMIC) dynamic = { offset, filesz };
    if (type === PT_INTERP) interpreter = readCString(bytes, offset);
  }

  const rpathOffsets: number[] = [];
  const runpathOffsets: number[] = [];
  let strtab: number | undefined;
  if (dynamic) {
    for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.filesz; at += 16) {
      const tag = Number(view.getBigInt64(at, true));
      const value = Number(view.getBigUint64(at + 8, true));
      if (tag === DT_NULL) break;
      if (tag === DT_STRTAB) strtab = value;
      if (tag === DT_RPATH) rpathOffsets.push(value);
      if (tag === DT_RUNPATH) runpathOffsets.push(value);
    }
  }

  const strtabOffset = strtab === undefined ? undefined : vaddrToOffset(loads, strtab);
  const readPaths = (offsets: number[]): string[] =>
    offsets.flatMap(offset =>
      strtabOffset === undefined
        ? []
        : readCString(bytes, strtabOffset + offset)
            .split(':')
            .filter(Boolean),
    );
  return { machine, interpreter, rpath: readPaths(rpathOffsets), runpath: readPaths(runpathOffsets) };
}

export function standardInterpreter(info: ElfInfo): string {
  const standard = STANDARD_INTERPRETERS[info.machine];
  if (!standard) {
    throw new Error(`no standard Linux interpreter known for ELF machine type ${info.machine}.`);
  }
  return standard;
}

/** Problems that stop a Linux binary from starting on a distro without Nix. Empty when portable. */
export function portabilityProblems(info: ElfInfo): string[] {
  const problems: string[] = [];
  const standard = standardInterpreter(info);
  if (info.interpreter === undefined) {
    problems.push('has no PT_INTERP (expected a dynamically linked glibc binary).');
  } else if (info.interpreter.startsWith('/nix/store')) {
    problems.push(`PT_INTERP points into the Nix store (${info.interpreter}); expected ${standard}.`);
  } else if (info.interpreter !== standard) {
    problems.push(`PT_INTERP is ${info.interpreter}; expected ${standard}.`);
  }
  for (const [kind, paths] of [
    ['RPATH', info.rpath],
    ['RUNPATH', info.runpath],
  ] as const) {
    const nix = paths.filter(path => path.startsWith('/nix/store'));
    if (nix.length > 0) problems.push(`${kind} points into the Nix store (${nix.join(':')}).`);
  }
  return problems;
}

export async function assertPortableLinuxBinary(path: string): Promise<void> {
  let problems: string[];
  try {
    problems = portabilityProblems(readElf(await Bun.file(path).bytes()));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (problems.length > 0) {
    throw new Error(`${path} is not portable to non-Nix Linux:\n- ${problems.join('\n- ')}`);
  }
}

function vaddrToOffset(loads: Array<{ vaddr: number; offset: number; filesz: number }>, vaddr: number): number {
  const segment = loads.find(load => vaddr >= load.vaddr && vaddr < load.vaddr + load.filesz);
  if (!segment) {
    throw new Error('dynamic string table is not inside any PT_LOAD segment.');
  }
  return segment.offset + (vaddr - segment.vaddr);
}

function readCString(bytes: Uint8Array, offset: number): string {
  const end = bytes.indexOf(0, offset);
  return new TextDecoder().decode(bytes.subarray(offset, end < 0 ? bytes.length : end));
}

async function main(args: string[]): Promise<number> {
  const [command, ...paths] = args;
  if (command === 'interpreter' && paths.length === 1) {
    console.log(standardInterpreter(readElf(await Bun.file(paths[0] as string).bytes())));
    return 0;
  }
  if (command === 'check' && paths.length > 0) {
    for (const path of paths) {
      await assertPortableLinuxBinary(path);
      console.log(`portable linux binary: ${path}`);
    }
    return 0;
  }
  console.error('usage: portable-elf.ts interpreter <binary> | check <binary...>');
  return 2;
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
}
