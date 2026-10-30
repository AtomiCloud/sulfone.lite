import { describe, expect, test } from 'bun:test';
import { engineRunPath } from '@cyanprint/contracts/run-dir';
import { sha256 } from '@cyanprint/core';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokePlugin, invokeProcessor, invokeResolver } from './index';

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
        'export async function processor(input) { await Bun.write(input.outputDir + "/README.md", "one"); }',
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
        'export async function processor(input) { await Bun.write(input.outputDir + "/README.md", "two"); }',
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

  test('reloads source bundles when an imported helper changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'processor.ts');
    const helperFile = join(dir, 'helper.ts');
    try {
      await writeFile(
        runtimeFile,
        'import { value } from "./helper";\nexport async function processor(input) { await Bun.write(input.outputDir + "/README.md", value); }\n',
        'utf8',
      );
      await writeFile(helperFile, 'export const value = "one";\n', 'utf8');
      const integrity = sha256(await Bun.file(runtimeFile).text());
      const first = await invokeProcessor(
        {
          dependency: { kind: 'processor', owner: 'cyanprint', name: 'helper', version: '1' },
          runtimeFile,
          integrity,
        },
        [{ path: 'README.md', content: 'input' }],
      );
      expect(first[0]?.content).toBe('one');

      await writeFile(helperFile, 'export const value = "two";\n', 'utf8');
      const second = await invokeProcessor(
        {
          dependency: { kind: 'processor', owner: 'cyanprint', name: 'helper', version: '1' },
          runtimeFile,
          integrity,
        },
        [{ path: 'README.md', content: 'input' }],
      );
      expect(second[0]?.content).toBe('two');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loads source bundles that import files outside the entry directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'src/index.ts');
    const helperFile = join(dir, 'helper.ts');
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(
        join(dir, 'cyan.yaml'),
        'cyanprint: 4\nkind: processor\nowner: cyanprint\nname: parent-helper\n',
        'utf8',
      );
      await writeFile(
        runtimeFile,
        [
          'import { value } from "../helper";',
          'export async function processor(input) {',
          '  await Bun.write(input.outputDir + "/README.md", value);',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(helperFile, 'export const value = "parent-helper";\n', 'utf8');

      const output = await invokeProcessor(
        {
          dependency: { kind: 'processor', owner: 'cyanprint', name: 'parent-helper', version: '1' },
          runtimeFile,
          integrity: sha256(await Bun.file(runtimeFile).text()),
        },
        [{ path: 'README.md', content: 'input' }],
      );

      expect(output[0]?.content).toBe('parent-helper');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('invokes a resolver ONCE with every variation of the conflicting path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'resolver.ts');
    try {
      await writeFile(
        runtimeFile,
        [
          'export function resolver(input) {',
          '  const parts = input.files.map(file => file.origin.template + ":" + file.content);',
          '  return { path: input.files[0].path, content: parts.join(input.config.separator ?? "|") };',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      const output = await invokeResolver(
        {
          dependency: { kind: 'resolver', owner: 'cyanprint', name: 'concat-all', version: '1' },
          runtimeFile,
          integrity: sha256(await Bun.file(runtimeFile).text()),
        },
        {
          files: [
            { path: 'shared.txt', content: 'left', origin: { template: 'a', layer: 0 } },
            { path: 'shared.txt', content: 'right', origin: { template: 'b', layer: 1 } },
          ],
          config: { separator: '|' },
        },
      );
      expect(output).toEqual({ path: 'shared.txt', content: 'a:left|b:right' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('treats processor output directory as the complete output by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'processor.ts');
    try {
      await writeFile(
        runtimeFile,
        'export async function processor(input) { const text = await Bun.file(input.inputDir + "/source.txt").text(); await Bun.write(input.outputDir + "/renamed.txt", text); }',
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

  test('lets plugins mutate a real output folder and run commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'plugin.ts');
    try {
      await writeFile(
        runtimeFile,
        [
          'export async function plugin(input) {',
          '  const proc = Bun.spawnSync(["git", "init"], { cwd: input.outputDir });',
          '  if (proc.exitCode !== 0) throw new Error("git init failed");',
          '  await Bun.write(input.outputDir + "/PLUGIN.md", "initialized");',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      const output = await invokePlugin(
        {
          dependency: { kind: 'plugin', owner: 'cyanprint', name: 'git-init', version: '1' },
          runtimeFile,
          integrity: sha256(await Bun.file(runtimeFile).text()),
        },
        [{ path: 'README.md', content: 'input' }],
      );
      expect(output.find(file => file.path === 'PLUGIN.md')?.content).toBe('initialized');
      expect(output.some(file => file.path.startsWith('.git/'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects output directory symlink escapes before reading artifact output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const escapeDir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-escape-'));
    const runtimeFile = join(dir, 'processor.ts');
    try {
      await writeFile(
        runtimeFile,
        [
          'import { rm, symlink } from "node:fs/promises";',
          'export async function processor(input) {',
          `  await rm(input.outputDir, { recursive: true, force: true });`,
          `  await symlink(${JSON.stringify(escapeDir)}, input.outputDir);`,
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await expect(
        invokeProcessor(
          {
            dependency: { kind: 'processor', owner: 'cyanprint', name: 'escape', version: '1' },
            runtimeFile,
            integrity: sha256(await Bun.file(runtimeFile).text()),
          },
          [{ path: 'README.md', content: 'input' }],
        ),
      ).rejects.toThrow('unsafe output directory');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(escapeDir, { recursive: true, force: true });
    }
  });

  test('rejects temp root replacement before reading artifact output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const escapeDir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-escape-'));
    const runtimeFile = join(dir, 'processor.ts');
    try {
      await writeFile(
        runtimeFile,
        [
          'import { dirname } from "node:path";',
          'import { rm, symlink } from "node:fs/promises";',
          'export async function processor(input) {',
          '  const root = dirname(input.outputDir);',
          `  await rm(root, { recursive: true, force: true });`,
          `  await symlink(${JSON.stringify(escapeDir)}, root);`,
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await expect(
        invokeProcessor(
          {
            dependency: { kind: 'processor', owner: 'cyanprint', name: 'root-escape', version: '1' },
            runtimeFile,
            integrity: sha256(await Bun.file(runtimeFile).text()),
          },
          [{ path: 'README.md', content: 'input' }],
        ),
      ).rejects.toThrow('unsafe temp root');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(escapeDir, { recursive: true, force: true });
    }
  });

  test('rejects nested symlink escapes inside artifact output trees', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const escapeDir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-escape-'));
    const runtimeFile = join(dir, 'processor.ts');
    try {
      await writeFile(
        runtimeFile,
        [
          'import { symlink } from "node:fs/promises";',
          'export async function processor(input) {',
          `  await symlink(${JSON.stringify(escapeDir)}, input.outputDir + "/leak");`,
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await expect(
        invokeProcessor(
          {
            dependency: { kind: 'processor', owner: 'cyanprint', name: 'nested-escape', version: '1' },
            runtimeFile,
            integrity: sha256(await Bun.file(runtimeFile).text()),
          },
          [{ path: 'README.md', content: 'input' }],
        ),
      ).rejects.toThrow('unsafe output path: leak');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(escapeDir, { recursive: true, force: true });
    }
  });

  test('rejects writes that escape above the managed temp root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'processor.ts');
    try {
      await writeFile(
        runtimeFile,
        [
          'export async function processor(input) {',
          '  await Bun.write(input.outputDir + "/../../escaped.txt", "escape");',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await expect(
        invokeProcessor(
          {
            dependency: { kind: 'processor', owner: 'cyanprint', name: 'escape-parent', version: '1' },
            runtimeFile,
            integrity: sha256(await Bun.file(runtimeFile).text()),
          },
          [{ path: 'README.md', content: 'input' }],
        ),
      ).rejects.toThrow('unsafe output path');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects resolvers that do not return { path, content }', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'resolver.ts');
    try {
      await writeFile(runtimeFile, 'export function resolver(input) { return "fallback"; }\n', 'utf8');
      await expect(
        invokeResolver(
          {
            dependency: { kind: 'resolver', owner: 'cyanprint', name: 'returning', version: '1' },
            runtimeFile,
            integrity: sha256(await Bun.file(runtimeFile).text()),
          },
          {
            files: [{ path: 'shared.txt', content: 'fallback', origin: { template: 'a', layer: 0 } }],
            config: {},
          },
        ),
      ).rejects.toThrow('must return { path, content }');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('concurrent first loads of legacy hook resolvers each get their own resolver', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    try {
      // `slow` registers first, then keeps loading; `fast` registers while `slow` is still
      // importing. Without serialized loads, `slow` reads back `fast`'s resolver.
      const legacy = (name: string, before: number, after: number): string =>
        [
          `await Bun.sleep(${before});`,
          'Object.defineProperty(globalThis, Symbol.for("cyanprint.resolver"), {',
          '  configurable: true,',
          `  value: input => ({ path: input.files[0].path, content: ${JSON.stringify(name)} }),`,
          '});',
          `await Bun.sleep(${after});`,
          '',
        ].join('\n');
      const slowFile = join(dir, 'slow.ts');
      const fastFile = join(dir, 'fast.ts');
      await writeFile(slowFile, legacy('slow', 0, 60), 'utf8');
      await writeFile(fastFile, legacy('fast', 15, 0), 'utf8');
      const run = async (name: string, runtimeFile: string): Promise<string> =>
        (
          await invokeResolver(
            {
              dependency: { kind: 'resolver', owner: 'cyanprint', name, version: '1' },
              runtimeFile,
              integrity: sha256(await Bun.file(runtimeFile).text()),
            },
            { files: [{ path: 'x.txt', content: '', origin: { template: 't', layer: 0 } }], config: {} },
          )
        ).content;
      const [slow, fast] = await Promise.all([run('slow', slowFile), run('fast', fastFile)]);
      expect(slow).toBe('slow');
      expect(fast).toBe('fast');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a processor load during a legacy resolver import does not wipe the resolver registration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    try {
      const resolverFile = join(dir, 'legacy.js');
      await writeFile(
        resolverFile,
        [
          'Object.defineProperty(globalThis, Symbol.for("cyanprint.resolver"), {',
          '  configurable: true,',
          '  value: input => ({ path: input.files[0].path, content: "ok" }),',
          '});',
          'await Bun.sleep(300);',
          '',
        ].join('\n'),
        'utf8',
      );
      const processorFile = join(dir, 'proc.js');
      await writeFile(
        processorFile,
        'export async function processor(input) { await Bun.write(input.outputDir + "/a.txt", "x"); }\n',
        'utf8',
      );
      const resolved = invokeResolver(
        {
          dependency: { kind: 'resolver', owner: 'cyanprint', name: 'legacy', version: '1' },
          runtimeFile: resolverFile,
          integrity: sha256(await Bun.file(resolverFile).text()),
        },
        { files: [{ path: 'x.txt', content: '', origin: { template: 't', layer: 0 } }], config: {} },
      );
      await Bun.sleep(80);
      await invokeProcessor(
        {
          dependency: { kind: 'processor', owner: 'cyanprint', name: 'proc', version: '1' },
          runtimeFile: processorFile,
          integrity: sha256(await Bun.file(processorFile).text()),
        },
        [{ path: 'a.txt', content: 'i' }],
      );
      expect((await resolved).content).toBe('ok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('non-source resolver runtimes are installed by rename, never copied in place', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    try {
      const runtimeFile = join(dir, 'resolver.js');
      await writeFile(
        runtimeFile,
        'export function resolver(input) { return { path: input.files[0].path, content: "js" }; }\n',
        'utf8',
      );
      const run = async (): Promise<string> =>
        (
          await invokeResolver(
            {
              dependency: { kind: 'resolver', owner: 'cyanprint', name: 'js-resolver', version: '1' },
              runtimeFile,
              integrity: sha256(await Bun.file(runtimeFile).text()),
            },
            { files: [{ path: 'x.txt', content: '', origin: { template: 't', layer: 0 } }], config: {} },
          )
        ).content;
      expect(await Promise.all([run(), run(), run()])).toEqual(['js', 'js', 'js']);
      const importsRoot = await engineRunPath('cyanprint-artifact-imports');
      for (const entry of await readdir(importsRoot)) {
        expect((await readdir(join(importsRoot, entry))).filter(name => name.endsWith('.tmp'))).toEqual([]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('concurrent first loads of one source runtime do not collide on the bundle staging file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'processor.ts');
    try {
      await writeFile(
        runtimeFile,
        'export async function processor(input) { await Bun.write(input.outputDir + "/README.md", "same"); }',
        'utf8',
      );
      const integrity = sha256(await Bun.file(runtimeFile).text());
      const outputs = await Promise.all(
        Array.from({ length: 32 }, () =>
          invokeProcessor(
            {
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'racy', version: '1' },
              runtimeFile,
              integrity,
            },
            [{ path: 'README.md', content: 'input' }],
          ),
        ),
      );
      for (const output of outputs) {
        expect(output[0]?.content).toBe('same');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reuse bumps the import dir mtime and a cache hit does not re-materialize', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'processor.ts');
    const marker = `hit-${crypto.randomUUID()}`;
    try {
      await writeFile(
        runtimeFile,
        'export async function processor(input) { await Bun.write(input.outputDir + "/README.md", "' + marker + '"); }',
        'utf8',
      );
      const bundle = {
        dependency: { kind: 'processor', owner: 'cyanprint', name: 'reuse', version: '1' } as const,
        runtimeFile,
        integrity: sha256(await Bun.file(runtimeFile).text()),
      };
      await invokeProcessor(bundle, [{ path: 'README.md', content: 'input' }]);
      const importsRoot = await engineRunPath('cyanprint-artifact-imports');
      const dirs = await readdir(importsRoot);
      const targets: string[] = [];
      for (const name of dirs) {
        const bundlePath = join(importsRoot, name, 'bundle.js');
        if ((await stat(bundlePath).catch(() => undefined))?.isFile()) {
          const source = await Bun.file(bundlePath).text();
          if (source.includes(marker)) {
            targets.push(name);
          }
        }
      }
      expect(targets).toHaveLength(1);
      const importDir = join(importsRoot, targets[0] as string);
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      await utimes(importDir, old, old);
      await rm(join(importDir, 'bundle.js'));

      const output = await invokeProcessor(bundle, [{ path: 'README.md', content: 'input' }]);
      expect(output[0]?.content).toBe(marker);
      expect((await stat(importDir)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
      expect(await Bun.file(join(importDir, 'bundle.js')).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('supports resolvers registered through the cyan-sdk global hook', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'resolver.ts');
    try {
      await writeFile(
        runtimeFile,
        [
          'Object.defineProperty(globalThis, Symbol.for("cyanprint.resolver"), {',
          '  configurable: true,',
          '  value: input => ({',
          '    path: input.files[0].path,',
          '    content: input.files.map(file => file.content).join("+"),',
          '  }),',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );
      const output = await invokeResolver(
        {
          dependency: { kind: 'resolver', owner: 'cyanprint', name: 'registered', version: '1' },
          runtimeFile,
          integrity: sha256(await Bun.file(runtimeFile).text()),
        },
        {
          files: [
            { path: 'shared.txt', content: 'a', origin: { template: 'a', layer: 0 } },
            { path: 'shared.txt', content: 'b', origin: { template: 'b', layer: 1 } },
          ],
          config: {},
        },
      );
      expect(output).toEqual({ path: 'shared.txt', content: 'a+b' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('invokes processors with the fs helper as a second argument', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
    const runtimeFile = join(dir, 'processor.ts');
    try {
      await writeFile(
        runtimeFile,
        'export async function processor(input, fs) { const files = await fs.read(); await fs.write(files.map(file => ({ ...file, content: (file.content ?? "").toUpperCase() }))); }',
        'utf8',
      );
      const output = await invokeProcessor(
        {
          dependency: { kind: 'processor', owner: 'cyanprint', name: 'two-arg', version: '1' },
          runtimeFile,
          integrity: sha256(await Bun.file(runtimeFile).text()),
        },
        [{ path: 'README.md', content: 'input' }],
      );
      expect(output).toEqual([{ path: 'README.md', content: 'INPUT' }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Export validation is runtime-based (typeof + Function.length): non-functions and
  // over-declared arities reject; every valid JS export form (const arrow, function
  // expression, re-export) loads and runs.
  test('validates processor exports at runtime, accepting any export form', async () => {
    const rejected: Array<[string, string]> = [
      ['export const processor = {};', 'to be a function'],
      [
        'export function processor(input, helper, extra) { return input.outputDir; }',
        'an input object and an optional helper',
      ],
    ];
    const accepted: string[] = [
      'export const processor = (input, config = {}) => undefined;',
      'export const processor = function processor(input) { return undefined; };',
      'const real = (input, config = {}) => undefined;\nexport { real as processor };',
      'const half = 4 / 2; const s = "a/b";\nexport function processor(input) { return undefined; }',
    ];
    for (const [source, message] of rejected) {
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
    for (const source of accepted) {
      const dir = await mkdtemp(join(tmpdir(), 'cyanprint-artifact-cache-'));
      const runtimeFile = join(dir, 'processor.ts');
      try {
        await writeFile(runtimeFile, source, 'utf8');
        await expect(
          invokeProcessor(
            {
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'good-export', version: '1' },
              runtimeFile,
              integrity: sha256(await Bun.file(runtimeFile).text()),
            },
            [{ path: 'README.md', content: 'input' }],
          ),
        ).resolves.toBeDefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});

describe('executable file mode', () => {
  const processorBundle = async (
    dir: string,
    source: string,
    name: string,
  ): Promise<Parameters<typeof invokeProcessor>[0]> => {
    const runtimeFile = join(dir, `${name}.ts`);
    await writeFile(runtimeFile, source, 'utf8');
    return {
      dependency: { kind: 'processor', owner: 'cyanprint', name, version: '1' },
      runtimeFile,
      integrity: sha256(source),
    };
  };

  test('processor output chmod 0755 is reported as mode 0o755', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-runner-mode-'));
    try {
      const bundle = await processorBundle(
        dir,
        [
          "import { chmod } from 'node:fs/promises';",
          'export async function processor(input) {',
          '  await Bun.write(input.outputDir + "/run.sh", "echo\\n");',
          '  await chmod(input.outputDir + "/run.sh", 0o755);',
          '  await Bun.write(input.outputDir + "/plain.txt", "text\\n");',
          '}',
        ].join('\n'),
        'chmod-out',
      );
      const output = await invokeProcessor(bundle, [{ path: 'seed.txt', content: 'seed' }]);
      expect(output.find(file => file.path === 'run.sh')?.mode).toBe(0o755);
      expect(output.find(file => file.path === 'plain.txt')?.mode).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('processor input receives the executable bit and a rewritten file keeps it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-runner-mode-'));
    try {
      const bundle = await processorBundle(
        dir,
        [
          'export async function processor(input) {',
          '  const text = await Bun.file(input.inputDir + "/run.sh").text();',
          '  await Bun.write(input.outputDir + "/run.sh", text.toUpperCase());',
          '  await Bun.write(input.outputDir + "/other.txt", "x");',
          '}',
        ].join('\n'),
        'rewrite',
      );
      const output = await invokeProcessor(bundle, [
        { path: 'run.sh', content: 'echo\n', mode: 0o755 },
        { path: 'other.txt', content: 'o\n' },
      ]);
      expect(output.find(file => file.path === 'run.sh')).toEqual({ path: 'run.sh', content: 'ECHO\n', mode: 0o755 });
      expect(output.find(file => file.path === 'other.txt')?.mode).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('plugin keeps the executable bit of seeded files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-runner-mode-'));
    try {
      const runtimeFile = join(dir, 'plugin.ts');
      const source =
        'export async function plugin(input) { await Bun.write(input.outputDir + "/run.sh", "changed\\n"); }';
      await writeFile(runtimeFile, source, 'utf8');
      const output = await invokePlugin(
        {
          dependency: { kind: 'plugin', owner: 'cyanprint', name: 'mode', version: '1' },
          runtimeFile,
          integrity: sha256(source),
        },
        [{ path: 'run.sh', content: 'echo\n', mode: 0o755 }],
      );
      expect(output).toEqual([{ path: 'run.sh', content: 'changed\n', mode: 0o755 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
