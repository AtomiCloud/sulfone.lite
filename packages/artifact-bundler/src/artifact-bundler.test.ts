import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle } from './build-bundle';

describe('bundled artifact', () => {
  test('validates required bundle files in dry run', async () => {
    const result = await buildBundle({
      artifactDir: join(process.cwd(), 'examples/artifacts/processor-uppercase'),
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.temporaryDirectory).toBeDefined();
    expect(await Bun.file(result.runtimeFile).text()).toContain('uppercase');
    expect(result.sha256).toHaveLength(64);
    if (result.temporaryDirectory) {
      await rm(result.temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('writes the compiled runtime to the declared bundledEntry path', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-bundler-test-'));
    try {
      await mkdir(join(artifactDir, 'src'), { recursive: true });
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: plugin',
          'owner: cyanprint',
          'name: non-index-output',
          'entry: src/main.ts',
          'bundledEntry: dist/plugin.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(artifactDir, 'README.md'), '# Non Index Output\n', 'utf8');
      await writeFile(
        join(artifactDir, 'src/main.ts'),
        'export async function plugin(input) { await Bun.write(input.outputDir + "/MARKER.txt", "ok"); }',
        'utf8',
      );

      const result = await buildBundle({ artifactDir });

      expect(result.runtimeFile).toBe(join(artifactDir, 'dist/plugin.js'));
      expect(await Bun.file(result.runtimeFile).text()).toContain('plugin');
      expect(result.sha256).toHaveLength(64);
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  test('preserves source-map-like text inside bundled runtime strings', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-bundler-source-map-text-test-'));
    try {
      await mkdir(join(artifactDir, 'src'), { recursive: true });
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: plugin',
          'owner: cyanprint',
          'name: source-map-text',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(artifactDir, 'README.md'), '# Source Map Text\n', 'utf8');
      await writeFile(
        join(artifactDir, 'src/index.ts'),
        [
          'const marker = `before',
          '//# sourceMappingURL=literal.map',
          'after`;',
          'export async function plugin(input) { await Bun.write(input.outputDir + "/MARKER.txt", marker); }',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await buildBundle({ artifactDir });
      const bundled = await Bun.file(result.runtimeFile).text();

      expect(bundled).toContain('sourceMappingURL=literal.map');
      expect(/^\/\/# sourceMappingURL=.*$/m.test(bundled.trimEnd().split('\n').at(-1) ?? '')).toBe(false);
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  test('does not strip source-map-like text on a final code line', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-bundler-final-source-map-text-test-'));
    try {
      await mkdir(join(artifactDir, 'src'), { recursive: true });
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: plugin',
          'owner: cyanprint',
          'name: final-source-map-text',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(artifactDir, 'README.md'), '# Final Source Map Text\n', 'utf8');
      await writeFile(
        join(artifactDir, 'src/index.ts'),
        'export function plugin(input) { return "keep //# sourceMappingURL=literal.map"; }',
        'utf8',
      );

      const result = await buildBundle({ artifactDir });
      const bundled = await Bun.file(result.runtimeFile).text();

      expect(bundled).toContain('keep //# sourceMappingURL=literal.map');
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  test('does not strip source-map-like text at the start of a final template line', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-bundler-final-template-source-map-test-'));
    try {
      await mkdir(join(artifactDir, 'src'), { recursive: true });
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: plugin',
          'owner: cyanprint',
          'name: final-template-source-map-text',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(artifactDir, 'README.md'), '# Final Template Source Map Text\n', 'utf8');
      await writeFile(
        join(artifactDir, 'src/index.ts'),
        [
          'const marker = `keep',
          '//# sourceMappingURL=literal.map`;',
          'export function plugin(input) { return marker; }',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await buildBundle({ artifactDir });
      const bundled = await Bun.file(result.runtimeFile).text();

      expect(bundled).toContain('sourceMappingURL=literal.map');
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  test('bundles legacy Ketone resolver manifests with README.MD', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-bundler-legacy-readme-test-'));
    try {
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'username: atomi',
          'name: legacy-json',
          'description: Legacy resolver',
          'readme: README.MD',
          'build:',
          '  images:',
          '    resolver:',
          '      image: legacy-json',
          '      dockerfile: Dockerfile',
          '      context: .',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(artifactDir, 'README.MD'), '# Legacy Resolver\n', 'utf8');
      await writeFile(
        join(artifactDir, 'index.ts'),
        [
          "import { StartResolverWithLambda } from '@atomicloud/cyan-sdk';",
          'StartResolverWithLambda(input => input.files[0]?.content ?? "");',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await buildBundle({ artifactDir, dryRun: true });

      expect(result.sha256).toHaveLength(64);
      if (result.temporaryDirectory) {
        await rm(result.temporaryDirectory, { recursive: true, force: true });
      }
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  test('rejects old default-object processor bundles', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-bundler-test-'));
    try {
      await mkdir(join(artifactDir, 'src'), { recursive: true });
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: processor',
          'owner: cyanprint',
          'name: old-shape',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(artifactDir, 'README.md'), '# Old Shape\n', 'utf8');
      await writeFile(
        join(artifactDir, 'src/index.ts'),
        'export default { process(files) { return files; } };',
        'utf8',
      );

      await expect(buildBundle({ artifactDir, dryRun: true })).rejects.toThrow('export function processor');
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  test('accepts two-argument (input, helper) processor bundles', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-bundler-test-'));
    try {
      await mkdir(join(artifactDir, 'src'), { recursive: true });
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: processor',
          'owner: cyanprint',
          'name: two-arg',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(artifactDir, 'README.md'), '# Two Arg\n', 'utf8');
      await writeFile(
        join(artifactDir, 'src/index.ts'),
        'export async function processor(input, fs) { await fs.write(await fs.read()); }',
        'utf8',
      );

      await expect(buildBundle({ artifactDir, dryRun: true })).resolves.toMatchObject({ dryRun: true });
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  test('rejects processor bundles with three or more parameters', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-bundler-test-'));
    try {
      await mkdir(join(artifactDir, 'src'), { recursive: true });
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: processor',
          'owner: cyanprint',
          'name: three-arg',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(artifactDir, 'README.md'), '# Three Arg\n', 'utf8');
      await writeFile(
        join(artifactDir, 'src/index.ts'),
        'export function processor(input, helper, extra) { return input.outputDir; }',
        'utf8',
      );

      await expect(buildBundle({ artifactDir, dryRun: true })).rejects.toThrow(
        'an input object and an optional helper',
      );
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  // Validation is runtime-based (imported function + Function.length), never source parsing:
  // any valid JS export form works — function declarations, const arrows, function expressions,
  // re-exports — including sources with division, ASI, or TypeScript generics.
  test('accepts any valid export form for processor bundles', async () => {
    for (const [name, source] of [
      ['arrow-default-param', 'export const processor = (input, config = {}) => input.outputDir;'],
      ['function-expression', 'export const processor = function (input) { return input.outputDir; };'],
      ['named-function-expression', 'export const processor = function processor(input) { return input.outputDir; };'],
      ['aliased-export', 'const real = (input, config = {}) => input.outputDir;\nexport { real as processor };'],
      [
        'division-and-string',
        'const half = 4 / 2; const s = "a/b";\nexport function processor(input) { return input.outputDir; }',
      ],
      ['asi-before-export', "console.log('hi')\nexport function processor(input) { return input.outputDir; }"],
      [
        'typescript-generics',
        'export function processor(input: Record<string, unknown>, helper?: unknown) { return (input as { outputDir: string }).outputDir; }',
      ],
    ] as const) {
      const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-bundler-test-'));
      try {
        await mkdir(join(artifactDir, 'src'), { recursive: true });
        await writeFile(
          join(artifactDir, 'cyan.yaml'),
          [
            'cyanprint: 4',
            'kind: processor',
            'owner: cyanprint',
            `name: ${name}`,
            'entry: src/index.ts',
            'bundledEntry: dist/index.js',
            '',
          ].join('\n'),
          'utf8',
        );
        await writeFile(join(artifactDir, 'README.md'), `# ${name}\n`, 'utf8');
        await writeFile(join(artifactDir, 'src/index.ts'), source, 'utf8');

        await expect(buildBundle({ artifactDir, dryRun: true })).resolves.toMatchObject({ dryRun: true });
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    }
  });
});
