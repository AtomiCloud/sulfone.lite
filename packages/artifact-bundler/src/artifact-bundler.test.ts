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
        'export function plugin(input) { const { files } = input; return { ...files, "MARKER.txt": "ok" }; }',
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

  test('rejects old two-argument processor bundles', async () => {
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
        'export function processor(files, config) { return files; }',
        'utf8',
      );

      await expect(buildBundle({ artifactDir, dryRun: true })).rejects.toThrow('one input object');
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  test('rejects two-argument processor bundles with default or rest parameters', async () => {
    for (const [name, source] of [
      ['default-param', 'export function processor(input, config = {}) { return input.files; }'],
      ['rest-param', 'export function processor(input, ...rest) { return input.files; }'],
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

        await expect(buildBundle({ artifactDir, dryRun: true })).rejects.toThrow('one input object');
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    }
  });

  test('rejects exported const/function-expression processor bundles', async () => {
    for (const [name, source, message] of [
      [
        'arrow-default-param',
        'export const processor = (input, config = {}) => input.files;',
        'export function processor(input)',
      ],
      [
        'function-expression',
        'export const processor = function (input) { return input.files; };',
        'export function processor(input)',
      ],
      [
        'named-function-expression',
        'export const processor = function processor(input) { return input.files; };',
        'export function processor(input)',
      ],
      [
        'decoy-comment',
        '// function processor(input) {}\nexport const processor = (input, config = {}) => input.files;',
        'export function processor(input)',
      ],
      [
        'decoy-string',
        'const decoy = "function processor(input) {}";\nexport const processor = (input, config = {}) => input.files;',
        'export function processor(input)',
      ],
      [
        'decoy-nested-function',
        'export const processor = (input, config = {}) => { function processor(input) {} return input.files; };',
        'export function processor(input)',
      ],
      [
        'aliased-export-decoy',
        'const real = (input, config = {}) => input.files;\nfunction processor(input) {}\nexport { real as processor };',
        'export function processor(input)',
      ],
      [
        'regex-decoy',
        'const processor = (input, config = {}) => { /}/.test("}"); function processor(input) {} return input.files; };\nexport { processor };',
        'export function processor(input)',
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

        await expect(buildBundle({ artifactDir, dryRun: true })).rejects.toThrow(message);
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    }
  });
});
