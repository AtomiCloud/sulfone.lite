import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginHelper, createProcessorFsHelper, exec } from './helpers';
import { foldResolverCandidates } from './resolver-fold';
import { assertResolverCommutative } from './testing';
import type { ResolvedFile, ResolverInput, ResolverOutput } from './sdk-types';

describe('processor fs helper', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cyanprint-sdk-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('read() reads every file into the VFS and ignores CyanPrint metadata', async () => {
    const inputDir = join(dir, 'input');
    await mkdir(join(inputDir, 'nested'), { recursive: true });
    await writeFile(join(inputDir, 'a.txt'), 'alpha');
    await writeFile(join(inputDir, 'nested', 'b.txt'), 'beta');
    await writeFile(join(inputDir, '.cyan_state.yaml'), 'state');
    const helper = createProcessorFsHelper({ inputDir, outputDir: join(dir, 'out') });
    const files = await helper.read();
    expect(files).toEqual([
      { path: 'a.txt', content: 'alpha' },
      { path: 'nested/b.txt', content: 'beta' },
    ]);
  });

  test('write() writes text and binary files, preserving bytes through bytesBase64', async () => {
    const outputDir = join(dir, 'out');
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x10]).toString('base64');
    const helper = createProcessorFsHelper({ inputDir: join(dir, 'input'), outputDir });
    await helper.write([
      { path: 'text.md', content: '# Hello\n' },
      { path: 'asset.bin', bytesBase64: binary },
    ]);
    const roundtrip = createProcessorFsHelper({ inputDir: outputDir, outputDir: join(dir, 'out2') });
    const files = await roundtrip.read();
    expect(files).toEqual([
      { path: 'asset.bin', bytesBase64: binary },
      { path: 'text.md', content: '# Hello\n' },
    ]);
  });
});

describe('plugin helper exec', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cyanprint-sdk-exec-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('runs a command in outputDir and returns stdout/stderr/exit code', async () => {
    const helper = createPluginHelper({ inputDir: dir, outputDir: dir, dir });
    const result = await helper.exec('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
  });

  test('throws on non-zero exit by default, and opts out with throwOnError: false', async () => {
    await expect(exec('exit 3', { cwd: dir })).rejects.toThrow('exit code 3');
    const result = await exec('exit 3', { cwd: dir, throwOnError: false });
    expect(result.exitCode).toBe(3);
  });
});

describe('two-file resolver fold', () => {
  const origin = (template: string, layer: number) => ({ template, layer });
  const candidate = (template: string, layer: number, content: string): ResolvedFile => ({
    path: 'shared.txt',
    content,
    origin: origin(template, layer),
  });

  const concat = async (input: ResolverInput): Promise<ResolverOutput> => ({
    path: input.next.path,
    content: `${input.current.content}\n${input.next.content}`,
  });

  test('folds N candidates deterministically by ascending layer', async () => {
    const candidates = [candidate('c', 2, 'c'), candidate('a', 0, 'a'), candidate('b', 1, 'b')];
    const output = await foldResolverCandidates(concat, { path: 'shared.txt', config: {}, candidates });
    expect(output.content).toBe('a\nb\nc');
  });

  test('returns a single candidate untouched', async () => {
    const output = await foldResolverCandidates(concat, {
      path: 'shared.txt',
      config: {},
      candidates: [candidate('only', 0, 'solo')],
    });
    expect(output.content).toBe('solo');
  });

  test('assertResolverCommutative passes for a commutative merge', async () => {
    const sortedConcat = async (input: ResolverInput): Promise<ResolverOutput> => ({
      path: input.next.path,
      content: [input.current.content, input.next.content].sort().join(','),
    });
    await expect(
      assertResolverCommutative(sortedConcat, {
        path: 'shared.txt',
        config: {},
        candidates: [candidate('a', 0, 'x'), candidate('b', 1, 'y')],
      }),
    ).resolves.toBeUndefined();
  });

  test('assertResolverCommutative throws for a non-commutative merge', async () => {
    await expect(
      assertResolverCommutative(concat, {
        path: 'shared.txt',
        config: {},
        candidates: [candidate('a', 0, 'x'), candidate('b', 1, 'y')],
      }),
    ).rejects.toThrow('commutative');
  });
});
