import { describe, expect, test } from 'bun:test';
import { sha256 } from '@cyanprint/core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokePlugin, invokeProcessor } from './index';

describe('pin integrity cache bundled artifact', () => {
  test('invokes processor and plugin fixture bundles', async () => {
    const root = process.cwd();
    const processorFile = join(root, 'examples/artifacts/processor-uppercase/src/index.ts');
    const pluginFile = join(root, 'examples/artifacts/plugin-footer/src/index.ts');
    const processed = await invokeProcessor(
      {
        dependency: { kind: 'processor', owner: 'cyanprint', name: 'uppercase', version: '4' },
        runtimeFile: processorFile,
        integrity: sha256(await Bun.file(processorFile).text()),
      },
      [{ path: 'README.md', content: '# Hello\n' }],
    );
    expect(processed).toEqual([{ path: 'README.md', content: '# HELLO\n', mode: undefined }]);

    const plugged = await invokePlugin(
      {
        dependency: { kind: 'plugin', owner: 'cyanprint', name: 'footer', version: '4' },
        runtimeFile: pluginFile,
        integrity: sha256(await Bun.file(pluginFile).text()),
      },
      processed,
    );
    expect(plugged[0]?.content).toContain('Generated locally.');
  });

  test('rejects integrity mismatch before loading bundle', async () => {
    await expect(
      invokeProcessor(
        {
          dependency: { kind: 'processor', owner: 'cyanprint', name: 'uppercase', version: '4' },
          runtimeFile: join(process.cwd(), 'examples/artifacts/processor-uppercase/src/index.ts'),
          integrity: 'bad',
        },
        [{ path: 'README.md', content: '# Hello\n' }],
      ),
    ).rejects.toThrow('Bundle integrity mismatch');
  });

  test('reloads same-path bundle when verified bytes change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'processor.ts');
    try {
      await writeFile(
        runtimeFile,
        'export function processor(input) { const { files } = input; return { "README.md": "one" }; }',
        'utf8',
      );
      const firstIntegrity = sha256(await Bun.file(runtimeFile).text());
      const first = await invokeProcessor(
        {
          dependency: { kind: 'processor', owner: 'cyanprint', name: 'dynamic', version: '1' },
          runtimeFile,
          integrity: firstIntegrity,
        },
        [{ path: 'README.md', content: 'input' }],
      );
      expect(first[0]?.content).toBe('one');

      await writeFile(
        runtimeFile,
        'export function processor(input) { const { files } = input; return { "README.md": "two" }; }',
        'utf8',
      );
      const second = await invokeProcessor(
        {
          dependency: { kind: 'processor', owner: 'cyanprint', name: 'dynamic', version: '2' },
          runtimeFile,
          integrity: sha256(await Bun.file(runtimeFile).text()),
        },
        [{ path: 'README.md', content: 'input' }],
      );
      expect(second[0]?.content).toBe('two');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('treats processor return value as the complete output map by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'processor.ts');
    try {
      await writeFile(
        runtimeFile,
        'export function processor(input) { return { "renamed.txt": input.files["source.txt"] }; }',
        'utf8',
      );
      const processed = await invokeProcessor(
        {
          dependency: { kind: 'processor', owner: 'cyanprint', name: 'rename', version: '1' },
          runtimeFile,
          integrity: sha256(await Bun.file(runtimeFile).text()),
        },
        [{ path: 'source.txt', content: 'kept' }],
      );
      expect(processed).toEqual([{ path: 'renamed.txt', content: 'kept', mode: undefined }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects processor exports with hidden second parameters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'processor.ts');
    try {
      await writeFile(runtimeFile, 'export function processor(input, config = {}) { return input.files; }', 'utf8');
      await expect(
        invokeProcessor(
          {
            dependency: { kind: 'processor', owner: 'cyanprint', name: 'two-arg', version: '1' },
            runtimeFile,
            integrity: sha256(await Bun.file(runtimeFile).text()),
          },
          [{ path: 'README.md', content: 'input' }],
        ),
      ).rejects.toThrow('one input object');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects non-function and const processor exports', async () => {
    for (const [source, message] of [
      ['export const processor = {};', 'to be a function'],
      ['export const processor = (input, config = {}) => input.files;', 'export function processor(input)'],
      [
        'export const processor = function processor(input) { return input.files; };',
        'export function processor(input)',
      ],
      [
        '// function processor(input) {}\nexport const processor = (input, config = {}) => input.files;',
        'export function processor(input)',
      ],
      [
        'const decoy = "function processor(input) {}";\nexport const processor = (input, config = {}) => input.files;',
        'export function processor(input)',
      ],
      [
        'export const processor = (input, config = {}) => { function processor(input) {} return input.files; };',
        'export function processor(input)',
      ],
      [
        'const real = (input, config = {}) => input.files;\nfunction processor(input) {}\nexport { real as processor };',
        'export function processor(input)',
      ],
      [
        'const processor = (input, config = {}) => { /}/.test("}"); function processor(input) {} return input.files; };\nexport { processor };',
        'export function processor(input)',
      ],
    ] as const) {
      const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
      const runtimeFile = join(dir, 'processor.ts');
      try {
        await writeFile(runtimeFile, source, 'utf8');
        await expect(
          invokeProcessor(
            {
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'bad-export', version: '1' },
              runtimeFile,
              integrity: sha256(await Bun.file(runtimeFile).text()),
            },
            [{ path: 'README.md', content: 'input' }],
          ),
        ).rejects.toThrow(message);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
