import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactCacheKey,
  artifactCachePath,
  createProject,
  createTempSession,
  evaluateTrust,
  executeCyanScript,
  exists,
  mergeFile,
  runArtifactTests,
  runTemplateTest,
  resolveCyanCacheDir,
  safeJoin,
  sha256,
  traceProject,
  updateProject,
} from './index';

const root = process.cwd();
const identityProcessorRuntime = [
  "import { mkdir } from 'node:fs/promises';",
  "import { dirname } from 'node:path';",
  'async function put(path, content) { await mkdir(dirname(path), { recursive: true }); await Bun.write(path, content); }',
  'export async function processor(input) {',
  '  const glob = new Bun.Glob("**/*");',
  '  for await (const path of glob.scan({ cwd: input.inputDir, onlyFiles: true })) {',
  '    await put(input.outputDir + "/" + path, await Bun.file(input.inputDir + "/" + path).text());',
  '  }',
  '}',
  '',
].join('\n');
const appendProcessorRuntime = (suffix: string) =>
  [
    "import { mkdir } from 'node:fs/promises';",
    "import { dirname } from 'node:path';",
    'async function put(path, content) { await mkdir(dirname(path), { recursive: true }); await Bun.write(path, content); }',
    'export async function processor(input) {',
    '  const glob = new Bun.Glob("**/*");',
    '  for await (const path of glob.scan({ cwd: input.inputDir, onlyFiles: true })) {',
    `    await put(input.outputDir + "/" + path, (await Bun.file(input.inputDir + "/" + path).text()) + ${JSON.stringify(suffix)});`,
    '  }',
    '}',
    '',
  ].join('\n');
const folderResolverPrelude = [
  "import { mkdir } from 'node:fs/promises';",
  "import { dirname } from 'node:path';",
  'function configPath(config) { return config && typeof config === "object" && typeof config.path === "string" ? config.path : "output.txt"; }',
  'async function read(entry, path) { return await Bun.file(entry.dir + "/" + path).text().catch(() => ""); }',
  'async function put(outputDir, path, content) { const target = outputDir + "/" + path; await mkdir(dirname(target), { recursive: true }); await Bun.write(target, content); }',
  '',
].join('\n');
const folderConcatResolverRuntime = [
  folderResolverPrelude,
  'export async function resolver(input) {',
  '  const path = configPath(input.config);',
  '  const sorted = [...input.inputDirs].sort((left, right) => left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template));',
  '  const parts = await Promise.all(sorted.map(entry => read(entry, path)));',
  '  await put(input.outputDir, path, parts.filter(Boolean).join(""));',
  '}',
  '',
].join('\n');
const latestFolderResolverRuntime = [
  folderResolverPrelude,
  'export async function resolver(input) {',
  '  const path = configPath(input.config);',
  '  const sorted = [...input.inputDirs].sort((left, right) => left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template));',
  '  const latest = sorted.at(-1);',
  '  await put(input.outputDir, path, latest ? await read(latest, path) : "");',
  '}',
  '',
].join('\n');
const configAppendProcessorRuntime = [
  "import { mkdir } from 'node:fs/promises';",
  "import { dirname } from 'node:path';",
  'async function put(path, content) { await mkdir(dirname(path), { recursive: true }); await Bun.write(path, content); }',
  'export async function processor(input) {',
  '  const glob = new Bun.Glob("**/*");',
  '  for await (const path of glob.scan({ cwd: input.inputDir, onlyFiles: true })) {',
  '    await put(input.outputDir + "/" + path, (await Bun.file(input.inputDir + "/" + path).text()) + input.config.suffix);',
  '  }',
  '}',
  '',
].join('\n');

describe('cache', () => {
  test('cache path is stable and disposable', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-cache-'));
    const ref = { kind: 'template' as const, owner: 'cyanprint', name: 'hello', version: '4' };
    try {
      expect(artifactCacheKey(ref)).toBe(artifactCacheKey(ref));
      const first = artifactCachePath(resolveCyanCacheDir(cacheRoot), ref);
      const second = artifactCachePath(resolveCyanCacheDir(cacheRoot), ref);
      expect(second).toBe(first);
      await mkdir(first, { recursive: true });
      await Bun.write(join(first, 'marker'), 'warm');
      await rm(first, { recursive: true, force: true });
      await mkdir(second, { recursive: true });
      await Bun.write(join(second, 'marker'), 'rehydrated');
      expect(await Bun.file(join(second, 'marker')).text()).toBe('rehydrated');
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test('cache path encodes owner and name path separators', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-cache-label-'));
    try {
      const path = artifactCachePath(cacheRoot, {
        kind: 'template',
        owner: '../evil',
        name: 'nested/name',
        version: '4',
      });
      expect(path.startsWith(cacheRoot)).toBe(true);
      expect(path).not.toContain('../evil');
      expect(path).not.toContain('nested/name');
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe('safe output paths', () => {
  test('allows normal children and rejects traversal', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-safe-'));
    try {
      expect(safeJoin(rootDir, 'README.md')).toBe(join(rootDir, 'README.md'));
      expect(() => safeJoin(rootDir, '../README.md')).toThrow('Refusing to write outside output directory');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe('temp session', () => {
  test('creates cyanprint-session directory under platform temp root', async () => {
    const session = await createTempSession();
    expect(session.path.startsWith(join(tmpdir(), 'cyanprint-session-'))).toBe(true);
    await session.cleanup();
  });

  test('script execution uses and cleans a cyanprint temp session', async () => {
    const scriptDir = await mkdtemp(join(tmpdir(), 'cyanprint-script-test-'));
    const scriptPath = join(scriptDir, 'cyan.ts');
    try {
      await writeFile(
        scriptPath,
        `export default function cyan(prompt, ctx) {
          ctx.deterministic.set("sessionPath", ctx.runtime.sessionPath);
          return {};
        }`,
      );
      const deterministicState: Record<string, unknown> = {};
      await executeCyanScript(scriptPath, {}, deterministicState, false);
      const sessionPath = deterministicState.sessionPath;
      expect(typeof sessionPath).toBe('string');
      if (typeof sessionPath !== 'string') {
        throw new Error('script did not return a session path');
      }
      expect(sessionPath.startsWith(join(tmpdir(), 'cyanprint-session-'))).toBe(true);
      expect(await Bun.file(sessionPath).exists()).toBe(false);
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
    }
  });

  test('script execution cleans temp session after failure', async () => {
    const scriptDir = await mkdtemp(join(tmpdir(), 'cyanprint-script-fail-test-'));
    const markerPath = join(scriptDir, 'session-path.txt');
    const scriptPath = join(scriptDir, 'cyan.ts');
    try {
      await writeFile(
        scriptPath,
        `import { writeFileSync } from "node:fs";
        export default function cyan(prompt, ctx) {
          writeFileSync(${JSON.stringify(markerPath)}, ctx.runtime.sessionPath);
          throw new Error("boom");
        }`,
      );
      await expect(executeCyanScript(scriptPath, {}, {}, false)).rejects.toThrow('boom');
      const sessionPath = await Bun.file(markerPath).text();
      expect(sessionPath.startsWith(join(tmpdir(), 'cyanprint-session-'))).toBe(true);
      expect(await Bun.file(sessionPath).exists()).toBe(false);
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
    }
  });
});

describe('manifest and cyan script', () => {
  test('headless create writes expected output and state', async () => {
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-create-'));
    try {
      const result = await createProject({
        template: join(root, 'examples/templates/hello'),
        outDir: out,
        answers: { name: 'Hello Lite' },
        headless: true,
      });
      expect(result.status).toBe('done');
      expect(await Bun.file(join(out, 'README.md')).text()).toContain('# Hello Lite');
      expect(await Bun.file(join(out, '.cyan_state.yaml')).exists()).toBe(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe('undeclared artifact', () => {
  test('rejects returned artifacts not declared in cyan.yaml', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-undeclared-template-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-undeclared-'));
    try {
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: undeclared-artifact',
          'bundledEntry: cyan.ts',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        `export default function cyan(prompt, ctx) {
          return {
            processors: [{ kind: "processor", owner: "cyanprint", name: "uppercase" }]
          };
        }`,
      );
      await expect(
        createProject({
          template: templateDir,
          outDir: out,
          answers: { name: 'Bad' },
        }),
      ).rejects.toThrow('does not declare it');
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('rejects returned artifact versions not declared in cyan.yaml', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-versioned-artifact-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-versioned-artifact-out-'));
    try {
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: versioned-artifact',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyanprint/uppercase@4',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        `export default function cyan(prompt, ctx) {
          return {
            processors: [{ kind: "processor", owner: "cyanprint", name: "uppercase", version: "5" }]
          };
        }`,
      );
      await expect(
        createProject({
          template: templateDir,
          outDir: out,
          answers: { name: 'Bad Version' },
        }),
      ).rejects.toThrow('processor:cyanprint:uppercase@5');
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('normalizes unversioned returned artifacts to a single pinned manifest version', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-pinned-artifact-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-pinned-artifact-out-'));
    try {
      await mkdir(join(templateDir, 'dist'), { recursive: true });
      const runtimeFile = join(templateDir, 'dist', 'identity-processor.js');
      const runtime = identityProcessorRuntime;
      await writeFile(runtimeFile, runtime);
      await writeFile(
        join(templateDir, '.cyan_artifact_bundles.json'),
        JSON.stringify({
          bundles: [
            {
              key: 'processor:cyanprint:identity:4',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'identity', version: '4' },
              runtimeFile,
              integrity: sha256(runtime),
            },
          ],
        }),
      );
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: pinned-artifact',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyanprint/identity@4',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        `export default function cyan(prompt, ctx) {
          return {
            processors: [{ kind: "processor", owner: "cyanprint", name: "identity" }]
          };
        }`,
      );
      const result = await createProject({
        template: templateDir,
        outDir: out,
        answers: { name: 'Pinned' },
        localFallback: false,
      });
      expect(result.artifactUses.processors).toEqual([
        { kind: 'processor', owner: 'cyanprint', name: 'identity', version: '4' },
      ]);
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe('artifact output layering', () => {
  test('applies declared processor and plugin output in order', async () => {
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-artifacts-'));
    try {
      const result = await createProject({
        template: join(root, 'examples/templates/with-artifacts'),
        outDir: out,
        answers: { name: 'Artifact Project' },
        headless: true,
      });
      expect(
        result.artifactBundles
          .map(bundle => bundle.dependency)
          .filter(dependency => dependency.kind !== 'template')
          .map(dependency => `${dependency.kind}:${dependency.owner}/${dependency.name}`)
          .sort(),
      ).toEqual([
        'plugin:cyanprint/footer',
        'processor:cyan/default',
        'processor:cyanprint/uppercase',
        'resolver:cyanprint/keep-user',
      ]);
      const readme = await Bun.file(join(out, 'README.md')).text();
      expect(readme).toContain('# ARTIFACT PROJECT');
      expect(readme).toContain('Generated locally.');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test('merges multiple scoped processor outputs as independent layers', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-multiple-processors-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-multiple-processors-out-'));
    try {
      await mkdir(join(templateDir, 'template/docs'), { recursive: true });
      await mkdir(join(templateDir, 'dist'), { recursive: true });
      const firstRuntime = join(templateDir, 'dist/append-a.js');
      const secondRuntime = join(templateDir, 'dist/append-b.js');
      const first = appendProcessorRuntime('A');
      const second = appendProcessorRuntime('B');
      await writeFile(firstRuntime, first, 'utf8');
      await writeFile(secondRuntime, second, 'utf8');
      await writeFile(
        join(templateDir, '.cyan_artifact_bundles.json'),
        JSON.stringify({
          bundles: [
            {
              key: 'processor:cyanprint:append-a',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'append-a' },
              runtimeFile: firstRuntime,
              integrity: sha256(first),
            },
            {
              key: 'processor:cyanprint:append-b',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'append-b' },
              runtimeFile: secondRuntime,
              integrity: sha256(second),
            },
          ],
        }),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: multiple-processors',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyanprint/append-a',
          '  - cyanprint/append-b',
          '',
        ].join('\n'),
      );
      await writeFile(join(templateDir, 'template/docs/note.md'), 'start', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.ts'),
        `export default async function cyan(prompt, ctx) {
          return {
            processors: [
              { name: 'cyanprint/append-a', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }] },
              { name: 'cyanprint/append-b', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }] },
            ],
          };
        }\n`,
      );

      await createProject({ template: templateDir, outDir: out, answers: {}, headless: true, localFallback: false });

      expect(await Bun.file(join(out, 'docs/note.md')).text()).toBe('startB');
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('loads scoped plugin files into the merged output folder', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-scoped-plugin-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-scoped-plugin-out-'));
    try {
      await mkdir(join(templateDir, 'template/app'), { recursive: true });
      await mkdir(join(templateDir, 'template/plugin-assets'), { recursive: true });
      await mkdir(join(templateDir, 'dist'), { recursive: true });
      const processorRuntime = join(templateDir, 'dist/identity.js');
      const pluginRuntime = join(templateDir, 'dist/scoped-plugin.js');
      const plugin = [
        "import { mkdir } from 'node:fs/promises';",
        "import { dirname } from 'node:path';",
        'async function put(path, content) { await mkdir(dirname(path), { recursive: true }); await Bun.write(path, content); }',
        'export async function plugin(input) {',
        '  const readme = await Bun.file(input.inputDir + "/README.md").text();',
        '  const asset = await Bun.file(input.inputDir + "/plugin-assets/message.txt").text();',
        '  await put(input.outputDir + "/PLUGIN_OUTPUT.txt", readme.trim() + "\\n" + asset.trim() + "\\n");',
        '}',
        '',
      ].join('\n');
      await writeFile(processorRuntime, identityProcessorRuntime, 'utf8');
      await writeFile(pluginRuntime, plugin, 'utf8');
      await writeFile(
        join(templateDir, '.cyan_artifact_bundles.json'),
        JSON.stringify({
          bundles: [
            {
              key: 'processor:cyanprint:identity',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'identity' },
              runtimeFile: processorRuntime,
              integrity: sha256(identityProcessorRuntime),
            },
            {
              key: 'plugin:cyanprint:scoped-plugin',
              dependency: { kind: 'plugin', owner: 'cyanprint', name: 'scoped-plugin' },
              runtimeFile: pluginRuntime,
              integrity: sha256(plugin),
            },
          ],
        }),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: scoped-plugin',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyanprint/identity',
          'plugins:',
          '  - cyanprint/scoped-plugin',
          '',
        ].join('\n'),
      );
      await writeFile(join(templateDir, 'template/app/README.md'), '# App\n', 'utf8');
      await writeFile(join(templateDir, 'template/plugin-assets/message.txt'), 'plugin asset\n', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.ts'),
        `export default async function cyan(prompt, ctx) {
          return {
            processors: [
              { name: 'cyanprint/identity', files: [{ root: 'template/app', glob: '**/*', type: 'Copy' }] },
            ],
            plugins: [
              { name: 'cyanprint/scoped-plugin', files: [{ root: 'template', glob: 'plugin-assets/**/*', type: 'Copy' }] },
            ],
          };
        }\n`,
      );

      await createProject({ template: templateDir, outDir: out, answers: {}, headless: true, localFallback: false });

      expect(await Bun.file(join(out, 'README.md')).text()).toBe('# App\n');
      expect(await Bun.file(join(out, 'plugin-assets/message.txt')).text()).toBe('plugin asset\n');
      expect(await Bun.file(join(out, 'PLUGIN_OUTPUT.txt')).text()).toBe('# App\nplugin asset\n');
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('merges same-path scoped processor outputs with a matching resolver', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-processor-resolver-merge-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-processor-resolver-merge-out-'));
    try {
      await mkdir(join(templateDir, 'template/docs'), { recursive: true });
      await mkdir(join(templateDir, 'dist'), { recursive: true });
      const firstRuntime = join(templateDir, 'dist/append-a.js');
      const secondRuntime = join(templateDir, 'dist/append-b.js');
      const resolverRuntime = join(templateDir, 'dist/concat.js');
      const first = appendProcessorRuntime('A');
      const second = appendProcessorRuntime('B');
      const resolver = [
        folderResolverPrelude,
        'export async function resolver(input) {',
        '  const path = configPath(input.config);',
        '  const sorted = [...input.inputDirs].sort((left, right) => left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template));',
        '  const parts = await Promise.all(sorted.map(entry => read(entry, path)));',
        '  await put(input.outputDir, path, parts.join("\\n") + "\\n");',
        '}',
        '',
      ].join('\n');
      await writeFile(firstRuntime, first, 'utf8');
      await writeFile(secondRuntime, second, 'utf8');
      await writeFile(resolverRuntime, resolver, 'utf8');
      await writeFile(
        join(templateDir, '.cyan_artifact_bundles.json'),
        JSON.stringify({
          bundles: [
            {
              key: 'processor:cyanprint:append-a',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'append-a' },
              runtimeFile: firstRuntime,
              integrity: sha256(first),
            },
            {
              key: 'processor:cyanprint:append-b',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'append-b' },
              runtimeFile: secondRuntime,
              integrity: sha256(second),
            },
            {
              key: 'resolver:cyanprint:concat',
              dependency: { kind: 'resolver', owner: 'cyanprint', name: 'concat' },
              runtimeFile: resolverRuntime,
              integrity: sha256(resolver),
            },
          ],
        }),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: processor-resolver-merge',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyanprint/append-a',
          '  - cyanprint/append-b',
          'resolvers:',
          '  - cyanprint/concat',
          '',
        ].join('\n'),
      );
      await writeFile(join(templateDir, 'template/docs/note.md'), 'start', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.ts'),
        `export default async function cyan(prompt, ctx) {
          return {
            processors: [
              { name: 'cyanprint/append-a', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }] },
              { name: 'cyanprint/append-b', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }] },
            ],
            resolvers: [{ name: 'cyanprint/concat', config: { paths: ['docs/note.md'] } }],
          };
        }\n`,
      );

      await createProject({ template: templateDir, outDir: out, answers: {}, headless: true, localFallback: false });

      expect(await Bun.file(join(out, 'docs/note.md')).text()).toBe('startA\nstartB\n');
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('keeps different archive roots separate when scoped processors emit the same path', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-processor-root-collision-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-processor-root-collision-out-'));
    try {
      await mkdir(join(templateDir, 'template-a'), { recursive: true });
      await mkdir(join(templateDir, 'template-b'), { recursive: true });
      await mkdir(join(templateDir, 'dist'), { recursive: true });
      const runtimeFile = join(templateDir, 'dist/append.js');
      const runtime = configAppendProcessorRuntime;
      await writeFile(runtimeFile, runtime, 'utf8');
      await writeFile(
        join(templateDir, '.cyan_artifact_bundles.json'),
        JSON.stringify({
          bundles: [
            {
              key: 'processor:cyanprint:append',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'append' },
              runtimeFile,
              integrity: sha256(runtime),
            },
          ],
        }),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: processor-root-collision',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyanprint/append',
          '',
        ].join('\n'),
      );
      await writeFile(join(templateDir, 'template-a/README.md'), 'first', 'utf8');
      await writeFile(join(templateDir, 'template-b/README.md'), 'second', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.ts'),
        [
          'export default function cyan(prompt, ctx) {',
          '  return {',
          '    processors: [',
          "      { name: 'cyanprint/append', files: [{ root: 'template-a', glob: '**/*', type: 'Template' }], config: { suffix: 'A' } },",
          "      { name: 'cyanprint/append', files: [{ root: 'template-b', glob: '**/*', type: 'Template' }], config: { suffix: 'B' } },",
          '    ],',
          '  };',
          '}',
          '',
        ].join('\n'),
      );

      await createProject({ template: templateDir, outDir: out, answers: {}, headless: true, localFallback: false });

      expect(await Bun.file(join(out, 'README.md')).text()).toBe('secondB');
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('merges renamed scoped processor output beside independent processor output', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-processor-rename-pipeline-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-processor-rename-pipeline-out-'));
    try {
      await mkdir(join(templateDir, 'template/docs'), { recursive: true });
      await mkdir(join(templateDir, 'dist'), { recursive: true });
      const renameRuntime = join(templateDir, 'dist/rename.js');
      const appendRuntime = join(templateDir, 'dist/append.js');
      const rename = [
        "import { mkdir } from 'node:fs/promises';",
        "import { dirname } from 'node:path';",
        'export async function processor(input) {',
        '  await mkdir(dirname(input.outputDir + "/docs/renamed.md"), { recursive: true });',
        '  const text = await Bun.file(input.inputDir + "/docs/note.md").text();',
        '  await Bun.write(input.outputDir + "/docs/renamed.md", text + "R");',
        '}',
        '',
      ].join('\n');
      const append = appendProcessorRuntime('A');
      await writeFile(renameRuntime, rename, 'utf8');
      await writeFile(appendRuntime, append, 'utf8');
      await writeFile(
        join(templateDir, '.cyan_artifact_bundles.json'),
        JSON.stringify({
          bundles: [
            {
              key: 'processor:cyanprint:rename',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'rename' },
              runtimeFile: renameRuntime,
              integrity: sha256(rename),
            },
            {
              key: 'processor:cyanprint:append',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'append' },
              runtimeFile: appendRuntime,
              integrity: sha256(append),
            },
          ],
        }),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: processor-rename-pipeline',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyanprint/rename',
          '  - cyanprint/append',
          '',
        ].join('\n'),
      );
      await writeFile(join(templateDir, 'template/docs/note.md'), 'start', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.ts'),
        `export default async function cyan(prompt, ctx) {
          return {
            processors: [
              { name: 'cyanprint/rename', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }] },
              { name: 'cyanprint/append', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }] },
            ],
          };
        }\n`,
      );

      await createProject({ template: templateDir, outDir: out, answers: {}, headless: true, localFallback: false });

      expect(await Bun.file(join(out, 'docs/note.md')).text()).toBe('startA');
      expect(await Bun.file(join(out, 'docs/renamed.md')).text()).toBe('startR');
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('rejects scoped processor output outside its scope root', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-processor-scope-escape-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-processor-scope-escape-out-'));
    try {
      await mkdir(join(templateDir, 'template/docs'), { recursive: true });
      await mkdir(join(templateDir, 'dist'), { recursive: true });
      const runtimeFile = join(templateDir, 'dist/escape.js');
      const runtime = `export async function processor(input) { await Bun.write(input.outputDir + "/../README.md", "bad"); }\n`;
      await writeFile(runtimeFile, runtime, 'utf8');
      await writeFile(
        join(templateDir, '.cyan_artifact_bundles.json'),
        JSON.stringify({
          bundles: [
            {
              key: 'processor:cyanprint:escape',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'escape' },
              runtimeFile,
              integrity: sha256(runtime),
            },
          ],
        }),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: processor-scope-escape',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyanprint/escape',
          '',
        ].join('\n'),
      );
      await writeFile(join(templateDir, 'template/docs/note.md'), 'safe', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.ts'),
        `export default async function cyan(prompt, ctx) {
          return {
            processors: [
              { name: 'cyanprint/escape', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }] },
            ],
          };
        }\n`,
      );

      await expect(
        createProject({ template: templateDir, outDir: out, answers: {}, headless: true, localFallback: false }),
      ).rejects.toThrow('unsafe output path');
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('loads distinct archive scopes with the same output path independently', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-distinct-scope-paths-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-distinct-scope-paths-out-'));
    try {
      await mkdir(join(templateDir, 'template-a'), { recursive: true });
      await mkdir(join(templateDir, 'template-b'), { recursive: true });
      await mkdir(join(templateDir, 'dist'), { recursive: true });
      const runtimeFile = join(templateDir, 'dist/identity.js');
      const runtime = identityProcessorRuntime;
      await writeFile(runtimeFile, runtime, 'utf8');
      await writeFile(
        join(templateDir, '.cyan_artifact_bundles.json'),
        JSON.stringify({
          bundles: [
            {
              key: 'processor:cyanprint:identity',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'identity' },
              runtimeFile,
              integrity: sha256(runtime),
            },
          ],
        }),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: distinct-scope-paths',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyanprint/identity',
          '',
        ].join('\n'),
      );
      await writeFile(join(templateDir, 'template-a/README.md'), 'from a\n', 'utf8');
      await writeFile(join(templateDir, 'template-b/README.md'), 'from b\n', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.ts'),
        `export default async function cyan(prompt, ctx) {
          return {
            processors: [
              {
                name: 'cyanprint/identity',
                files: [
                  { root: 'template-a', glob: '**/*', type: 'Template' },
                  { root: 'template-b', glob: '**/*', type: 'Template' },
                ],
              },
            ],
          };
        }\n`,
      );

      await createProject({ template: templateDir, outDir: out, answers: {}, headless: true, localFallback: false });

      expect(await Bun.file(join(out, 'README.md')).text()).toBe('from b\n');
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('executes child templates declared by a template group', async () => {
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-template-group-'));
    try {
      await createProject({
        template: join(root, 'examples/template-groups/basic'),
        outDir: out,
        answers: { name: 'Parent Group' },
        headless: true,
      });
      const readme = await Bun.file(join(out, 'README.md')).text();
      expect(readme).toContain('# ARTIFACT PROJECT');
      expect(readme).toContain('Generated locally.');
      expect(await Bun.file(join(out, 'GROUP.md')).text()).toContain('# Parent Group');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test('does not record pre-existing output files as generated state', async () => {
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-existing-output-'));
    try {
      await writeFile(join(out, 'KEEP.md'), '# Keep\n', 'utf8');
      const result = await createProject({
        template: join(root, 'examples/templates/hello'),
        outDir: out,
        answers: { name: 'Generated Only' },
        headless: true,
      });
      expect(result.files.map(file => file.path)).toEqual(['README.md']);
      expect(await Bun.file(join(out, 'KEEP.md')).text()).toBe('# Keep\n');
      expect(await Bun.file(join(out, '.cyan_state.yaml')).text()).not.toContain('KEEP.md');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test('persists child-only preset answers for headless updates', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-child-answers-'));
    const templatesRoot = join(tempRoot, 'examples/templates');
    const parent = join(templatesRoot, 'parent');
    const child = join(templatesRoot, 'child');
    const out = join(tempRoot, 'out');
    try {
      await mkdir(join(parent, 'template'), { recursive: true });
      await mkdir(join(child, 'template'), { recursive: true });
      await writeFile(join(parent, 'template/PARENT.md'), '# Parent\n', 'utf8');
      await writeFile(join(child, 'template/CHILD.md'), '# __CHILD_NAME__\n', 'utf8');
      await writeFile(
        join(parent, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: parent',
          'bundledEntry: cyan.ts',
          'templates:',
          '  - cyanprint/child',
          'processors:',
          '  - cyan/default',
          'presets:',
          '  templates:',
          '    cyanprint/child:',
          '      answers:',
          '        childName: Nested Answer',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(parent, 'cyan.ts'),
        [
          'export default function cyan(prompt, ctx) {',
          '  return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] };',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(child, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: child',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(child, 'cyan.ts'),
        [
          'export default async function cyan(prompt, ctx) {',
          '  const childName = await prompt.text("childName", "Child name");',
          '  return {',
          '    processors: [{',
          '      name: "cyan/default",',
          '      files: [{ root: "template", glob: "**/*", type: "Template" }],',
          '      config: { vars: { CHILD_NAME: childName } },',
          '    }],',
          '  };',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      await createProject({ template: parent, outDir: out, headless: true });

      expect(await Bun.file(join(out, 'CHILD.md')).text()).toContain('# Nested Answer');
      expect(await Bun.file(join(out, '.cyan_state.yaml')).text()).toContain('childName: Nested Answer');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('root ancestor presets win over a nearer parent for a grandchild (answers + det-state)', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-cascade-'));
    const templates = join(tempRoot, 'examples/templates');
    const out = join(tempRoot, 'out');
    const yaml = (lines: string[]) => `${lines.join('\n')}\n`;
    const emptyCyan = 'export default function cyan() { return {}; }\n';
    try {
      // A (root) -> B -> C. A presets C's answer + det-state; B presets C's answer differently.
      await mkdir(join(templates, 'a'), { recursive: true });
      await writeFile(
        join(templates, 'a/cyan.yaml'),
        yaml([
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: a',
          'bundledEntry: cyan.ts',
          'templates:',
          '  - cyanprint/b',
          'presets:',
          '  templates:',
          '    cyanprint/c:',
          '      answers:',
          '        grand: FROM_A',
          '      deterministic:',
          '        seed: A_SEED',
        ]),
      );
      await writeFile(join(templates, 'a/cyan.ts'), emptyCyan);

      await mkdir(join(templates, 'b'), { recursive: true });
      await writeFile(
        join(templates, 'b/cyan.yaml'),
        yaml([
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: b',
          'bundledEntry: cyan.ts',
          'templates:',
          '  - cyanprint/c',
          'presets:',
          '  templates:',
          '    cyanprint/c:',
          '      answers:',
          '        grand: FROM_B',
        ]),
      );
      await writeFile(join(templates, 'b/cyan.ts'), emptyCyan);

      await mkdir(join(templates, 'c/template'), { recursive: true });
      await writeFile(join(templates, 'c/template/OUT.md'), 'grand=__GRAND__\n');
      await writeFile(
        join(templates, 'c/cyan.yaml'),
        yaml([
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: c',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
        ]),
      );
      await writeFile(
        join(templates, 'c/cyan.ts'),
        [
          'export default async function cyan(prompt) {',
          '  const grand = await prompt.text("grand", "Grand");',
          '  return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }], config: { vars: { GRAND: grand } } }] };',
          '}',
          '',
        ].join('\n'),
      );

      await createProject({ template: join(templates, 'a'), outDir: out, headless: true });
      // Root A's preset wins over B's for the grandchild's answer.
      expect(await Bun.file(join(out, 'OUT.md')).text()).toBe('grand=FROM_A\n');
      // A's det-state seed cascaded through to the shared state.
      expect(await Bun.file(join(out, '.cyan_state.yaml')).text()).toContain('seed: A_SEED');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects a template included more than once in the composition', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-dup-'));
    const templates = join(tempRoot, 'examples/templates');
    const out = join(tempRoot, 'out');
    const yaml = (lines: string[]) => `${lines.join('\n')}\n`;
    const emptyCyan = 'export default function cyan() { return {}; }\n';
    const simpleTemplate = async (name: string, deps: string[] = []) => {
      await mkdir(join(templates, name, 'template'), { recursive: true });
      await writeFile(join(templates, name, `template/${name.toUpperCase()}.md`), `# ${name}\n`);
      await writeFile(
        join(templates, name, 'cyan.yaml'),
        yaml([
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          `name: ${name}`,
          'bundledEntry: cyan.ts',
          ...(deps.length ? ['templates:', ...deps.map(dep => `  - cyanprint/${dep}`)] : []),
          'processors:',
          '  - cyan/default',
        ]),
      );
      await writeFile(join(templates, name, 'cyan.ts'), emptyCyan);
    };
    try {
      await simpleTemplate('dup');
      await simpleTemplate('x', ['dup']);
      await simpleTemplate('y', ['dup']);
      await simpleTemplate('group', ['x', 'y']); // x and y both pull cyanprint/dup
      await expect(createProject({ template: join(templates, 'group'), outDir: out, headless: true })).rejects.toThrow(
        'included more than once',
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('allows two templates to share the same processor', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-shared-proc-'));
    const templates = join(tempRoot, 'examples/templates');
    const out = join(tempRoot, 'out');
    const yaml = (lines: string[]) => `${lines.join('\n')}\n`;
    const emptyCyan = 'export default function cyan() { return {}; }\n';
    const renderCyan =
      'export default function cyan() { return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] }; }\n';
    const leaf = async (name: string) => {
      await mkdir(join(templates, name, 'template'), { recursive: true });
      await writeFile(join(templates, name, `template/${name.toUpperCase()}.md`), `# ${name}\n`);
      await writeFile(
        join(templates, name, 'cyan.yaml'),
        yaml([
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          `name: ${name}`,
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
        ]),
      );
      await writeFile(join(templates, name, 'cyan.ts'), renderCyan);
    };
    try {
      await leaf('p');
      await leaf('q');
      await mkdir(join(templates, 'grp'), { recursive: true });
      await writeFile(
        join(templates, 'grp/cyan.yaml'),
        yaml([
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: grp',
          'bundledEntry: cyan.ts',
          'templates:',
          '  - cyanprint/p',
          '  - cyanprint/q',
        ]),
      );
      await writeFile(join(templates, 'grp/cyan.ts'), emptyCyan);
      const result = await createProject({ template: join(templates, 'grp'), outDir: out, headless: true });
      expect(result.files.map(file => file.path).sort()).toEqual(['P.md', 'Q.md']);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('traceProject returns provenance, per-template output, and diffs', async () => {
    const answers = JSON.parse(
      await readFile(join(root, 'examples/template-groups/basic/answers.json'), 'utf8'),
    ) as Record<string, unknown>;
    const trace = await traceProject({
      template: join(root, 'examples/template-groups/basic'),
      answers,
      headless: true,
    });
    expect(trace.tree.ref).toBe('cyanprint/basic-group');
    expect(trace.tree.children.length).toBe(2);
    expect(trace.tree.children.every(child => child.ownFiles.length > 0)).toBe(true);
    expect(trace.provenance.length).toBeGreaterThan(0);
    expect(trace.provenance.every(entry => entry.source.includes('/'))).toBe(true);
    expect(trace.provenance.some(entry => entry.decision === 'lww-override')).toBe(true);
    expect(trace.diffs.length).toBeGreaterThan(0);
  });

  test('trace provenance attributes a grandchild file to the grandchild, not the merging parent', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-trace-deep-'));
    const templates = join(tempRoot, 'examples/templates');
    const yaml = (lines: string[]) => `${lines.join('\n')}\n`;
    const emptyCyan = 'export default function cyan() { return {}; }\n';
    const renderCyan =
      'export default function cyan() { return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] }; }\n';
    const template = async (name: string, deps: string[], render: boolean) => {
      await mkdir(join(templates, name, 'template'), { recursive: true });
      if (render) {
        await writeFile(join(templates, name, `template/${name.toUpperCase()}.md`), `# ${name}\n`);
      }
      await writeFile(
        join(templates, name, 'cyan.yaml'),
        yaml([
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          `name: ${name}`,
          'bundledEntry: cyan.ts',
          ...(deps.length ? ['templates:', ...deps.map(dep => `  - cyanprint/${dep}`)] : []),
          ...(render ? ['processors:', '  - cyan/default'] : []),
        ]),
      );
      await writeFile(join(templates, name, 'cyan.ts'), render ? renderCyan : emptyCyan);
    };
    try {
      await template('deep-c', [], true);
      await template('deep-b', ['deep-c'], false);
      await template('deep-a', ['deep-b'], false);
      const trace = await traceProject({ template: join(templates, 'deep-a'), headless: true });
      const entry = trace.provenance.find(item => item.path === 'DEEP-C.md');
      expect(entry?.source).toBe('cyanprint/deep-c');
      expect(entry?.decision).toBe('added');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('interactively prompted answers from a custom adapter persist to generated state', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-adapter-'));
    const template = join(tempRoot, 'examples/templates/prompted');
    const out = join(tempRoot, 'out');
    try {
      await mkdir(join(template, 'template'), { recursive: true });
      await writeFile(join(template, 'template/OUT.md'), 'name=__NAME__\n');
      await writeFile(
        join(template, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: prompted',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(template, 'cyan.ts'),
        [
          'export default async function cyan(prompt) {',
          '  const name = await prompt.text("name", "Name");',
          '  return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }], config: { vars: { NAME: name } } }] };',
          '}',
          '',
        ].join('\n'),
      );
      // A custom adapter (like the CLI's inquirer adapter) holds its own cache; core must still
      // record its answers so update can reuse them.
      const adapterCache: Record<string, unknown> = {};
      await createProject({
        template,
        outDir: out,
        headless: false,
        promptAdapter: {
          async ask<T>(request: { name: string }): Promise<T> {
            adapterCache[request.name] = 'Prompted Project';
            return 'Prompted Project' as T;
          },
        },
      });
      expect(await Bun.file(join(out, 'OUT.md')).text()).toBe('name=Prompted Project\n');
      const state = await Bun.file(join(out, '.cyan_state.yaml')).text();
      expect(state).toContain('name: Prompted Project');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('unifiedDiff uses zero-based starts for zero-length hunk ranges', async () => {
    const { unifiedDiff } = await import('./util/unified-diff');
    expect(unifiedDiff('', 'a\nb')).toContain('@@ -0,0 +1,2 @@');
    expect(unifiedDiff('a\nb', '')).toContain('@@ -1,2 +0,0 @@');
  });

  test('prompt validation rejects out-of-range headless answers and accepts valid ones', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-validate-'));
    const template = join(tempRoot, 'examples/templates/validated');
    const out = join(tempRoot, 'out');
    try {
      await mkdir(join(template, 'template'), { recursive: true });
      await writeFile(join(template, 'template/OUT.md'), 'count=__COUNT__\n');
      await writeFile(
        join(template, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: validated',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(template, 'cyan.ts'),
        [
          'export default async function cyan(prompt) {',
          '  const count = await prompt.number("count", "Count", {',
          '    validate: value => (value >= 5 && value <= 10 ? true : "count must be between 5 and 10"),',
          '  });',
          '  return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }], config: { vars: { COUNT: String(count) } } }] };',
          '}',
          '',
        ].join('\n'),
      );
      await expect(createProject({ template, outDir: out, headless: true, answers: { count: 3 } })).rejects.toThrow(
        'count must be between 5 and 10',
      );
      await createProject({ template, outDir: out, headless: true, answers: { count: 7 } });
      expect(await Bun.file(join(out, 'OUT.md')).text()).toBe('count=7\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('createProject reports generation progress for templates and artifacts', async () => {
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-progress-'));
    const events: Array<{ kind: string; ref: string }> = [];
    try {
      await createProject({
        template: join(root, 'examples/templates/hello'),
        outDir: out,
        headless: true,
        answers: JSON.parse(await readFile(join(root, 'examples/templates/hello/answers.json'), 'utf8')) as Record<
          string,
          unknown
        >,
        onProgress: event => events.push({ kind: event.kind, ref: event.ref }),
      });
      expect(events.some(event => event.kind === 'template' && event.ref === 'cyanprint/hello')).toBe(true);
      expect(events.some(event => event.kind === 'processor' && event.ref === 'cyan/default')).toBe(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test('executes child templates returned by cyan.ts', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-runtime-template-'));
    const templatesRoot = join(tempRoot, 'examples/templates');
    const parent = join(templatesRoot, 'parent');
    const child = join(templatesRoot, 'child');
    const out = join(tempRoot, 'out');
    try {
      await mkdir(join(parent, 'template'), { recursive: true });
      await mkdir(join(child, 'template'), { recursive: true });
      await writeFile(join(parent, 'template/PARENT.md'), '# Parent\n', 'utf8');
      await writeFile(join(child, 'template/CHILD.md'), '# Child\n', 'utf8');
      await writeFile(
        join(parent, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: parent',
          'bundledEntry: cyan.ts',
          'templates:',
          '  - cyanprint/child',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(parent, 'cyan.ts'),
        [
          'export default function cyan(prompt, ctx) {',
          '  return {',
          '    processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }],',
          '    templates: [{ kind: "template", owner: "cyanprint", name: "child" }]',
          '  };',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(child, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: child',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(child, 'cyan.ts'),
        [
          'export default function cyan(prompt, ctx) {',
          '  return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] };',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await createProject({ template: parent, outDir: out, headless: true });

      expect(await Bun.file(join(out, 'CHILD.md')).text()).toContain('# Child');
      expect(await Bun.file(join(out, 'PARENT.md')).text()).toContain('# Parent');
      expect(result.artifactUses.templates).toEqual([
        { kind: 'template', owner: 'cyanprint', name: 'child', config: undefined },
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('loads template folders with copy/template modes and scoped processors', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-folder-template-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-folder-template-out-'));
    const runtimeDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-folder-template-runtime-'));
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    try {
      await mkdir(join(templateDir, 'template-text/docs'), { recursive: true });
      await mkdir(join(templateDir, 'template-copy/assets'), { recursive: true });
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: folder-template',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyanprint/suffix@4',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        [
          'export default async function cyan(prompt, ctx) {',
          "  const name = await prompt.text('name', 'Project name');",
          '  return {',
          '    processors: [{',
          "      name: 'cyanprint/suffix',",
          '      files: [',
          "        { root: 'template-text', glob: '**/*', type: 'Template' },",
          "        { root: 'template-copy', glob: '**/*', type: 'Copy' },",
          '      ],',
          '      config: { vars: { NAME: name } },',
          '    }],',
          '  };',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(templateDir, 'template-text/docs/README.md'), '# __NAME__\n', 'utf8');
      await writeFile(join(templateDir, 'template-text/PLAIN.md'), 'plain __NAME__\n', 'utf8');
      await writeFile(join(templateDir, 'template-copy/assets/pixel.bin'), bytes);
      const runtimeFile = join(runtimeDir, 'suffix.js');
      await writeFile(
        runtimeFile,
        [
          "import { mkdir } from 'node:fs/promises';",
          "import { dirname } from 'node:path';",
          'export async function processor(input) {',
          '  const vars = input.config?.vars ?? {};',
          '  const glob = new Bun.Glob("**/*");',
          '  for await (const path of glob.scan({ cwd: input.inputDir, onlyFiles: true })) {',
          '    let next = await Bun.file(input.inputDir + "/" + path).text();',
          '    for (const [name, value] of Object.entries(vars)) {',
          '      next = next.replaceAll(`__${name}__`, String(value));',
          '    }',
          '    await mkdir(dirname(input.outputDir + "/" + path), { recursive: true });',
          '    await Bun.write(input.outputDir + "/" + path, `${next}processed\\n`);',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(templateDir, '.cyan_artifact_bundles.json'),
        JSON.stringify({
          bundles: [
            {
              key: 'processor:cyanprint:suffix:4',
              dependency: { kind: 'processor', owner: 'cyanprint', name: 'suffix', version: '4' },
              runtimeFile,
              integrity: sha256(await Bun.file(runtimeFile).text()),
            },
          ],
        }),
        'utf8',
      );

      await createProject({ template: templateDir, outDir: out, answers: { name: 'Folder App' }, headless: true });

      expect(await Bun.file(join(out, 'docs/README.md')).text()).toBe('# Folder App\nprocessed\n');
      expect(await Bun.file(join(out, 'PLAIN.md')).text()).toBe('plain Folder App\nprocessed\n');
      expect(new Uint8Array(await Bun.file(join(out, 'assets/pixel.bin')).arrayBuffer())).toEqual(bytes);
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });

  test('template scripts can use every prompt input type and return pure processor data', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-all-inputs-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-all-inputs-out-'));
    try {
      await mkdir(join(templateDir, 'template'), { recursive: true });
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: all-inputs',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        [
          'export default async function cyan(prompt, ctx) {',
          "  const name = await prompt.text('name', 'Name');",
          "  const enabled = await prompt.confirm('enabled', 'Enabled?');",
          "  const color = await prompt.select('color', 'Color', { options: ['cyan', 'darkcyan'] });",
          "  const features = await prompt.multiselect('features', 'Features', { options: ['cli', 'web', 'worker'] });",
          "  const count = await prompt.number('count', 'Count');",
          '  return {',
          '    processors: [{',
          "      name: 'cyan/default',",
          "      files: [{ root: 'template', glob: '**/*', type: 'Template' }],",
          '      config: { vars: { NAME: name, ENABLED: enabled, COLOR: color, FEATURES: features.join(","), COUNT: count } },',
          '    }],',
          '  };',
          '}',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(templateDir, 'template/README.md'),
        'name=__NAME__ enabled=__ENABLED__ color=__COLOR__ features=__FEATURES__ count=__COUNT__',
        'utf8',
      );

      await createProject({
        template: templateDir,
        outDir: out,
        headless: true,
        answers: {
          name: 'Inputs',
          enabled: true,
          color: 'cyan',
          features: ['cli', 'worker'],
          count: 7,
        },
      });

      expect(await Bun.file(join(out, 'README.md')).text()).toBe(
        'name=Inputs enabled=true color=cyan features=cli,worker count=7\n',
      );
    } finally {
      await rm(templateDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test('records create-time same-path conflicts when templates have no resolver', async () => {
    const fixture = await createSamePathFixture([
      { name: 'same-a', content: 'from a\n' },
      { name: 'same-b', content: 'from b\n' },
    ]);
    try {
      await createProject({ template: fixture.groupDir, outDir: fixture.outDir, answers: {}, headless: true });

      expect(await Bun.file(join(fixture.outDir, 'shared.txt')).text()).toBe('from b\n');
      expect(await Bun.file(join(fixture.outDir, '.cyan_state.yaml')).text()).toContain('reason: no_resolver');
    } finally {
      await fixture.cleanup();
    }
  });

  test('records create-time conflicts for different resolvers and same resolver with different config', async () => {
    const fixture = await createSamePathFixture(
      [
        {
          name: 'same-a',
          content: 'from a\n',
          resolvers: [{ name: 'cyanprint/merge-a', config: { paths: ['shared.txt'], mode: 'a' } }],
        },
        {
          name: 'same-b',
          content: 'from b\n',
          resolvers: [{ name: 'cyanprint/merge-b', config: { paths: ['shared.txt'], mode: 'b' } }],
        },
        {
          name: 'same-c',
          content: 'from c\n',
          resolvers: [{ name: 'cyanprint/merge-b', config: { paths: ['shared.txt'], mode: 'c' } }],
        },
      ],
      ['merge-a', 'merge-b'],
    );
    try {
      await createProject({ template: fixture.groupDir, outDir: fixture.outDir, answers: {}, headless: true });

      const state = await Bun.file(join(fixture.outDir, '.cyan_state.yaml')).text();
      expect(await Bun.file(join(fixture.outDir, 'shared.txt')).text()).toBe('from c\n');
      expect(state).toContain('reason: different_resolver');
      expect(state).toContain('reason: same_resolver_different_config');
    } finally {
      await fixture.cleanup();
    }
  });

  test('uses matching create-time resolvers and falls back to LWW for mixed resolver groups', async () => {
    const fixture = await createSamePathFixture(
      [
        {
          name: 'same-a',
          content: 'from a\n',
          resolvers: [{ name: 'cyanprint/merge-a', config: { paths: ['shared.txt'], mode: 'same' } }],
        },
        {
          name: 'same-b',
          content: 'from b\n',
          resolvers: [{ name: 'cyanprint/merge-a', config: { paths: ['shared.txt'], mode: 'same' } }],
        },
        { name: 'same-c', content: 'from c\n' },
        {
          name: 'same-d',
          content: 'from d\n',
          resolvers: [{ name: 'cyanprint/merge-b', config: { paths: ['shared.txt'], mode: 'same' } }],
        },
        {
          name: 'same-e',
          content: 'from e\n',
          resolvers: [{ name: 'cyanprint/merge-b', config: { paths: ['shared.txt'], mode: 'same' } }],
        },
      ],
      ['merge-a', 'merge-b'],
    );
    try {
      await createProject({ template: fixture.groupDir, outDir: fixture.outDir, answers: {}, headless: true });

      const state = await Bun.file(join(fixture.outDir, '.cyan_state.yaml')).text();
      expect(await Bun.file(join(fixture.outDir, 'shared.txt')).text()).toBe('from d\nfrom e\n');
      expect(state).toContain('reason: no_resolver');
    } finally {
      await fixture.cleanup();
    }
  });

  test('fold resolvers receive every original same-path template layer', async () => {
    const fixture = await createSamePathFixture(
      [
        {
          name: 'same-a',
          content: 'from a\n',
          resolvers: [{ name: 'cyanprint/origin-fold', config: { paths: ['shared.txt'] } }],
        },
        {
          name: 'same-b',
          content: 'from b\n',
          resolvers: [{ name: 'cyanprint/origin-fold', config: { paths: ['shared.txt'] } }],
        },
        {
          name: 'same-c',
          content: 'from c\n',
          resolvers: [{ name: 'cyanprint/origin-fold', config: { paths: ['shared.txt'] } }],
        },
      ],
      ['origin-fold'],
      [
        folderResolverPrelude,
        'export async function resolver(input) {',
        '  const path = configPath(input.config);',
        '  const sorted = [...input.inputDirs].sort((left, right) => left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template));',
        '  const parts = [];',
        '  for (const entry of sorted) {',
        '    const sidecar = await Bun.file(entry.dir + "/" + entry.origin.template + ".txt").text();',
        '    parts.push(`${entry.origin.template}:${entry.origin.layer}:${sidecar.trim()}`);',
        '  }',
        '  await put(input.outputDir, path, parts.join("\\n") + "\\n");',
        '}',
        '',
      ].join('\n'),
    );
    try {
      await createProject({ template: fixture.groupDir, outDir: fixture.outDir, answers: {}, headless: true });

      expect(await Bun.file(join(fixture.outDir, 'shared.txt')).text()).toBe(
        'same-a:0:sidecar same-a\nsame-b:1:sidecar same-b\nsame-c:2:sidecar same-c\n',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test('framework resolver path overrides user config path during create merges', async () => {
    const fixture = await createSamePathFixture(
      [
        {
          name: 'same-a',
          content: 'from a\n',
          resolvers: [{ name: 'cyanprint/path-proof', config: { paths: ['shared.txt'], path: 'wrong.txt' } }],
        },
        {
          name: 'same-b',
          content: 'from b\n',
          resolvers: [{ name: 'cyanprint/path-proof', config: { paths: ['shared.txt'], path: 'wrong.txt' } }],
        },
      ],
      ['path-proof'],
    );
    try {
      await createProject({ template: fixture.groupDir, outDir: fixture.outDir, answers: {}, headless: true });

      expect(await Bun.file(join(fixture.outDir, 'shared.txt')).text()).toBe('from a\nfrom b\n');
      expect(await Bun.file(join(fixture.outDir, 'wrong.txt')).exists()).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test('records LWW conflict metadata when different create-time resolver groups meet', async () => {
    const fixture = await createSamePathFixture(
      [
        {
          name: 'same-a',
          content: 'from a\n',
          resolvers: [{ name: 'cyanprint/merge-a', config: { paths: ['shared.txt'], mode: 'same' } }],
        },
        {
          name: 'same-b',
          content: 'from b\n',
          resolvers: [{ name: 'cyanprint/merge-a', config: { paths: ['shared.txt'], mode: 'same' } }],
        },
        {
          name: 'same-c',
          content: 'from c\n',
          resolvers: [{ name: 'cyanprint/merge-b', config: { paths: ['shared.txt'], mode: 'same' } }],
        },
        {
          name: 'same-d',
          content: 'from d\n',
          resolvers: [{ name: 'cyanprint/merge-b', config: { paths: ['shared.txt'], mode: 'same' } }],
        },
      ],
      ['merge-a', 'merge-b'],
    );
    try {
      await createProject({ template: fixture.groupDir, outDir: fixture.outDir, answers: {}, headless: true });

      const state = await Bun.file(join(fixture.outDir, '.cyan_state.yaml')).text();
      expect(await Bun.file(join(fixture.outDir, 'shared.txt')).text()).toBe('from c\nfrom d\n');
      expect(state).toContain('reason: different_resolver');
    } finally {
      await fixture.cleanup();
    }
  });
});

type SamePathLayer = {
  name: string;
  content: string;
  resolvers?: Array<{ name: string; config?: unknown }>;
};

async function createSamePathFixture(layers: SamePathLayer[], resolverNames: string[] = [], resolverRuntime?: string) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-same-path-'));
  const outDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-same-path-out-'));
  const templatesRoot = join(tempRoot, 'examples/templates');
  const groupsRoot = join(tempRoot, 'examples/template-groups');
  await mkdir(templatesRoot, { recursive: true });
  await mkdir(groupsRoot, { recursive: true });
  const resolverBundles = await createSamePathResolverBundles(tempRoot, resolverNames, resolverRuntime);

  for (const layer of layers) {
    const templateDir = join(templatesRoot, layer.name);
    await mkdir(join(templateDir, 'template'), { recursive: true });
    await writeFile(join(templateDir, 'template/shared.txt'), layer.content, 'utf8');
    await writeFile(join(templateDir, `template/${layer.name}.txt`), `sidecar ${layer.name}\n`, 'utf8');
    await writeFile(
      join(templateDir, 'cyan.yaml'),
      [
        'cyanprint: 4',
        'kind: template',
        'owner: cyanprint',
        `name: ${layer.name}`,
        'bundledEntry: cyan.ts',
        'processors:',
        '  - cyan/default',
        ...(layer.resolvers?.length
          ? ['resolvers:', ...[...new Set(layer.resolvers.map(resolver => resolver.name))].map(ref => `  - ${ref}`)]
          : []),
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(templateDir, 'cyan.ts'),
      [
        'export default function cyan(prompt, ctx) {',
        '  return {',
        "    processors: [{ name: 'cyan/default', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }],",
        `    resolvers: ${JSON.stringify(layer.resolvers ?? [])},`,
        '  };',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    if (resolverBundles.length > 0) {
      await writeFile(
        join(templateDir, '.cyan_artifact_bundles.json'),
        JSON.stringify({ bundles: resolverBundles }),
        'utf8',
      );
    }
  }

  const groupDir = join(groupsRoot, 'same-path-group');
  await mkdir(groupDir, { recursive: true });
  await writeFile(
    join(groupDir, 'cyan.yaml'),
    [
      'cyanprint: 4',
      'kind: template-group',
      'owner: cyanprint',
      'name: same-path-group',
      'bundledEntry: cyan.ts',
      'templates:',
      ...layers.map(layer => `  - cyanprint/${layer.name}`),
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(groupDir, 'cyan.ts'), 'export default function cyan(prompt, ctx) { return {}; }\n', 'utf8');

  return {
    groupDir,
    outDir,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    },
  };
}

async function createSamePathResolverBundles(tempRoot: string, names: string[], resolverRuntime?: string) {
  const distDir = join(tempRoot, 'dist');
  await mkdir(distDir, { recursive: true });
  const bundles = [];
  for (const name of names) {
    const runtimeFile = join(distDir, `${name}.js`);
    const runtime = resolverRuntime ?? folderConcatResolverRuntime;
    await writeFile(runtimeFile, runtime, 'utf8');
    bundles.push({
      key: `resolver:cyanprint:${name}`,
      dependency: { kind: 'resolver', owner: 'cyanprint', name },
      runtimeFile,
      integrity: sha256(runtime),
    });
  }
  return bundles;
}

describe('standard artifact tests', () => {
  test('runs processor, plugin, and resolver test fixtures', async () => {
    const defaultProcessor = await runArtifactTests({
      artifactDir: join(root, 'in-tree/official/processors/default'),
    });
    expect(defaultProcessor).toMatchObject({ kind: 'processor', passed: 1, failed: 0 });

    const processor = await runArtifactTests({ artifactDir: join(root, 'examples/artifacts/processor-uppercase') });
    expect(processor).toMatchObject({ kind: 'processor', passed: 1, failed: 0 });

    const plugin = await runArtifactTests({ artifactDir: join(root, 'examples/artifacts/plugin-footer') });
    expect(plugin).toMatchObject({ kind: 'plugin', passed: 1, failed: 0 });

    const resolver = await runArtifactTests({ artifactDir: join(root, 'examples/artifacts/resolver-keep-user') });
    expect(resolver).toMatchObject({ kind: 'resolver', passed: 2, failed: 0 });

    const jsonResolver = await runArtifactTests({ artifactDir: join(root, 'examples/artifacts/resolver1') });
    expect(jsonResolver).toMatchObject({ kind: 'resolver', passed: 3, failed: 0 });

    const lineResolver = await runArtifactTests({ artifactDir: join(root, 'examples/artifacts/resolver2') });
    expect(lineResolver).toMatchObject({ kind: 'resolver', passed: 2, failed: 0 });
  });

  test('default processor trims generated trailing whitespace fixtures', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-default-processor-fixture-'));
    const artifactDir = join(tempRoot, 'processor-default');
    try {
      await mkdir(join(artifactDir, 'src'), { recursive: true });
      await mkdir(join(artifactDir, 'tests/basic/input'), { recursive: true });
      await mkdir(join(artifactDir, 'tests/basic/expected'), { recursive: true });
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: processor',
          'owner: cyanprint',
          'name: default',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(artifactDir, 'src/index.ts'),
        await Bun.file(join(root, 'in-tree/official/processors/default/src/index.ts')).text(),
        'utf8',
      );
      await writeFile(
        join(artifactDir, 'tests/basic/input/README.md'),
        '# Example   \n\nLine with trailing spaces    \n',
        'utf8',
      );
      await writeFile(
        join(artifactDir, 'tests/basic/expected/README.md'),
        '# Example\n\nLine with trailing spaces\n',
        'utf8',
      );

      const report = await runArtifactTests({ artifactDir });

      expect(report).toMatchObject({ passed: 1, failed: 0 });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('runs legacy Ketone-style resolver fixtures through the fold compatibility path', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-ketone-resolver-fixture-'));
    const artifactDir = join(tempRoot, 'resolver');
    try {
      await mkdir(join(artifactDir, 'inputs/basic/template-a'), { recursive: true });
      await mkdir(join(artifactDir, 'snapshots/basic'), { recursive: true });
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'username: atomi',
          'name: legacy-json',
          'description: Legacy Ketone resolver fixture',
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
      await writeFile(join(artifactDir, 'README.MD'), '# Legacy JSON Resolver\n', 'utf8');
      await writeFile(
        join(artifactDir, 'index.ts'),
        [
          "import { StartResolverWithLambda } from '@atomicloud/cyan-sdk';",
          "import type { ResolverInput, ResolverOutput } from '@atomicloud/cyan-sdk';",
          '',
          'StartResolverWithLambda((input: ResolverInput): ResolverOutput => {',
          '  const file = input.files[0];',
          '  if (!file) throw new Error("missing file");',
          '  const parsed = JSON.parse(file.content) as Record<string, unknown>;',
          '  return { path: file.path, content: JSON.stringify({ b: parsed.b, a: parsed.a }) };',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(artifactDir, 'test.cyan.yaml'),
        [
          'tests:',
          '  - name: basic',
          '    expected:',
          '      type: snapshot',
          '      value:',
          '        path: ./snapshots/basic',
          '    config: {}',
          '    resolver_inputs:',
          '      - path: ./inputs/basic/template-a',
          '        origin:',
          '          template: template-a',
          '          layer: 0',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(artifactDir, 'inputs/basic/template-a/data.json'),
        '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n',
        'utf8',
      );
      await writeFile(join(artifactDir, 'snapshots/basic/data.json'), '{"b":2,"a":1}', 'utf8');

      const report = await runArtifactTests({ artifactDir });

      expect(report).toMatchObject({ kind: 'resolver', passed: 1, failed: 0 });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('command validations run only after expected output comparison', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-command-validation-'));
    const processorDir = join(tempRoot, 'processor');
    const pluginDir = join(tempRoot, 'plugin');
    const resolverDir = join(tempRoot, 'resolver');
    const templateDir = join(tempRoot, 'template');
    const out = join(tempRoot, 'out');
    try {
      await mkdir(join(processorDir, 'src'), { recursive: true });
      await mkdir(join(processorDir, 'tests/basic/input'), { recursive: true });
      await mkdir(join(processorDir, 'tests/basic/expected'), { recursive: true });
      await writeFile(
        join(processorDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: processor',
          'owner: cyanprint',
          'name: failing-command',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(processorDir, 'src/index.ts'), identityProcessorRuntime, 'utf8');
      await writeFile(join(processorDir, 'tests/basic/input/README.md'), '# Input\n', 'utf8');
      await writeFile(join(processorDir, 'tests/basic/expected/README.md'), '# Input\n', 'utf8');
      await writeFile(
        join(processorDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: basic',
          '    input: tests/basic/input',
          '    expected: tests/basic/expected',
          '    validations:',
          '      - exit 1',
          '',
        ].join('\n'),
        'utf8',
      );

      await mkdir(join(pluginDir, 'src'), { recursive: true });
      await mkdir(join(pluginDir, 'tests/basic/input'), { recursive: true });
      await mkdir(join(pluginDir, 'tests/basic/expected'), { recursive: true });
      await writeFile(
        join(pluginDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: plugin',
          'owner: cyanprint',
          'name: failing-command',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(pluginDir, 'src/index.ts'), 'export function plugin(input) {}\n', 'utf8');
      await writeFile(join(pluginDir, 'tests/basic/input/README.md'), '# Input\n', 'utf8');
      await writeFile(join(pluginDir, 'tests/basic/expected/README.md'), '# Input\n', 'utf8');
      await writeFile(
        join(pluginDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: basic',
          '    input: tests/basic/input',
          '    expected: tests/basic/expected',
          '    validations:',
          '      - exit 1',
          '',
        ].join('\n'),
        'utf8',
      );

      await mkdir(join(resolverDir, 'src'), { recursive: true });
      await mkdir(join(resolverDir, 'tests/basic'), { recursive: true });
      await writeFile(
        join(resolverDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: resolver',
          'owner: cyanprint',
          'name: failing-command',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(resolverDir, 'src/index.ts'), latestFolderResolverRuntime, 'utf8');
      await writeFile(join(resolverDir, 'tests/basic/current.txt'), 'actual\n', 'utf8');
      await writeFile(join(resolverDir, 'tests/basic/expected.txt'), 'actual\n', 'utf8');
      await writeFile(
        join(resolverDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: basic',
          '    current: tests/basic/current.txt',
          '    expected: tests/basic/expected.txt',
          '    validations:',
          '      - exit 1',
          '',
        ].join('\n'),
        'utf8',
      );

      await mkdir(join(templateDir, 'template'), { recursive: true });
      await mkdir(join(templateDir, 'expected'), { recursive: true });
      await writeFile(join(templateDir, 'template/README.md'), '# Template\n', 'utf8');
      await writeFile(join(templateDir, 'expected/README.md'), '# Template\n', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: failing-command',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        'export default function cyan(prompt, ctx) { return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] }; }\n',
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.test.yaml'),
        ['cases:', '  - name: basic', '    expected: expected', '    validations:', '      - exit 1', ''].join('\n'),
        'utf8',
      );
      await createProject({ template: templateDir, outDir: join(templateDir, 'expected'), headless: true });

      const processorValidationReport = await runArtifactTests({ artifactDir: processorDir });
      expect(processorValidationReport).toMatchObject({ passed: 0, failed: 1 });
      expect(processorValidationReport.cases[0]?.message).toContain('Command failed');

      const pluginValidationReport = await runArtifactTests({ artifactDir: pluginDir });
      expect(pluginValidationReport).toMatchObject({ passed: 0, failed: 1 });
      expect(pluginValidationReport.cases[0]?.message).toContain('Command failed');

      const resolverValidationReport = await runArtifactTests({ artifactDir: resolverDir });
      expect(resolverValidationReport).toMatchObject({ passed: 0, failed: 1 });
      expect(resolverValidationReport.cases[0]?.message).toContain('Command failed');

      const templateValidationReport = await runTemplateTest({
        template: templateDir,
        outDir: join(out, 'validation'),
      });
      expect(templateValidationReport).toMatchObject({ passed: 0, failed: 1 });
      expect(templateValidationReport.cases[0]?.message).toContain('Command failed');

      await writeFile(join(processorDir, 'tests/basic/expected/README.md'), '# Expected mismatch\n', 'utf8');
      await writeFile(join(pluginDir, 'tests/basic/expected/README.md'), '# Expected mismatch\n', 'utf8');
      await writeFile(join(resolverDir, 'tests/basic/expected.txt'), 'expected mismatch\n', 'utf8');
      await writeFile(join(templateDir, 'expected/README.md'), '# Expected mismatch\n', 'utf8');

      const processorMismatchReport = await runArtifactTests({ artifactDir: processorDir });
      expect(processorMismatchReport).toMatchObject({ passed: 0, failed: 1 });
      expect(processorMismatchReport.cases[0]?.message).toContain('Output mismatch');
      expect(processorMismatchReport.cases[0]?.message).not.toContain('Command failed');

      const pluginMismatchReport = await runArtifactTests({ artifactDir: pluginDir });
      expect(pluginMismatchReport).toMatchObject({ passed: 0, failed: 1 });
      expect(pluginMismatchReport.cases[0]?.message).toContain('Output mismatch');
      expect(pluginMismatchReport.cases[0]?.message).not.toContain('Command failed');

      const resolverMismatchReport = await runArtifactTests({ artifactDir: resolverDir });
      expect(resolverMismatchReport).toMatchObject({ passed: 0, failed: 1 });
      expect(resolverMismatchReport.cases[0]?.message).toContain('Resolver output mismatch');
      expect(resolverMismatchReport.cases[0]?.message).not.toContain('Command failed');

      const templateMismatchReport = await runTemplateTest({ template: templateDir, outDir: join(out, 'mismatch') });
      expect(templateMismatchReport).toMatchObject({ passed: 0, failed: 1 });
      expect(templateMismatchReport.cases[0]?.message).toContain('Output mismatch');
      expect(templateMismatchReport.cases[0]?.message).not.toContain('Command failed');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('template tests pass with expected output and no README snapshot', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-template-expected-only-'));
    const templateDir = join(tempRoot, 'template');
    const out = join(tempRoot, 'out');
    try {
      await mkdir(join(templateDir, 'template'), { recursive: true });
      await mkdir(join(templateDir, 'expected'), { recursive: true });
      await writeFile(join(templateDir, 'template/README.md'), '# Template\n', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: expected-only',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        'export default function cyan(prompt, ctx) { return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] }; }\n',
        'utf8',
      );
      await createProject({ template: templateDir, outDir: join(templateDir, 'expected'), headless: true });
      await rm(join(templateDir, 'expected/.cyan_state.yaml'), { force: true });
      await writeFile(
        join(templateDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: basic',
          '    expected: expected',
          '    validations:',
          '      - test -f README.md',
          '',
        ].join('\n'),
        'utf8',
      );

      expect(await runTemplateTest({ template: templateDir, outDir: out })).toMatchObject({ passed: 1, failed: 0 });
      const updateReport = await runTemplateTest({ template: templateDir, outDir: out, updateSnapshots: true });
      expect(updateReport).toMatchObject({ passed: 1, failed: 0, snapshotUpdated: 1 });
      expect(await Bun.file(join(templateDir, 'expected/.cyan_state.yaml')).exists()).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('template tests fail without cyan.test.yaml or legacy snapshot', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-template-unasserted-'));
    const templateDir = join(tempRoot, 'template');
    try {
      await mkdir(join(templateDir, 'template'), { recursive: true });
      await writeFile(join(templateDir, 'template/README.md'), '# Template\n', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: unasserted',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        'export default function cyan(prompt, ctx) { return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] }; }\n',
        'utf8',
      );

      const report = await runTemplateTest({ template: templateDir, outDir: join(tempRoot, 'out') });
      expect(report).toMatchObject({ passed: 0, failed: 1 });
      expect(report.cases[0]?.message).toContain('Template tests need cyan.test.yaml');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('template expected fixture update preserves empty expected output folders', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-template-empty-expected-'));
    const templateDir = join(tempRoot, 'template');
    try {
      await mkdir(join(templateDir, 'template'), { recursive: true });
      await mkdir(join(templateDir, 'expected'), { recursive: true });
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: empty-output',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        'export default function cyan(prompt, ctx) { return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] }; }\n',
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.test.yaml'),
        ['cases:', '  - name: basic', '    expected: expected', ''].join('\n'),
        'utf8',
      );

      const updateReport = await runTemplateTest({
        template: templateDir,
        outDir: join(tempRoot, 'out'),
        updateSnapshots: true,
      });
      expect(updateReport).toMatchObject({ passed: 1, failed: 0, snapshotUpdated: 1 });
      expect(await exists(join(templateDir, 'expected'))).toBe(true);
      expect(await runTemplateTest({ template: templateDir, outDir: join(tempRoot, 'out-next') })).toMatchObject({
        passed: 1,
        failed: 0,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('template tests accept inline answers and deterministic state', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-template-inline-state-'));
    const templateDir = join(tempRoot, 'template');
    const out = join(tempRoot, 'out');
    try {
      await mkdir(join(templateDir, 'template'), { recursive: true });
      await mkdir(join(templateDir, 'expected'), { recursive: true });
      await writeFile(join(templateDir, 'template/README.md'), '# @@ NAME @@-@@ SLUG @@\n', 'utf8');
      await writeFile(join(templateDir, 'expected/README.md'), '# Inline-seeded\n', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: inline-state',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        [
          'export default async function cyan(prompt, ctx) {',
          '  const name = await prompt.text("name", "Project name");',
          '  const slug = ctx.deterministic.get("slug");',
          '  return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }], config: { vars: { NAME: name, SLUG: slug }, parser: { varSyntax: [["@@", "@@"]] } } }] };',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: inline',
          '    answers:',
          '      name: Inline',
          '    deterministicState:',
          '      slug: seeded',
          '    expected: expected',
          '    validations:',
          "      - grep -q '# Inline-seeded' README.md",
          '',
        ].join('\n'),
        'utf8',
      );

      expect(await runTemplateTest({ template: templateDir, outDir: out })).toMatchObject({ passed: 1, failed: 0 });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('template expected output compares and updates binary files byte for byte', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-template-binary-'));
    const templateDir = join(tempRoot, 'template');
    const out = join(tempRoot, 'out');
    const binary = new Uint8Array([0, 1, 2, 253, 254, 255]);
    try {
      await mkdir(join(templateDir, 'template/assets'), { recursive: true });
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: binary\nbundledEntry: cyan.ts\nprocessors:\n  - cyan/default\n',
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        'export default function cyan() { return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Copy" }] }] }; }\n',
        'utf8',
      );
      await writeFile(join(templateDir, 'template/assets/pixel.bin'), binary);
      await writeFile(
        join(templateDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: basic',
          '    expected: expected',
          '    validations:',
          '      - test -f assets/pixel.bin',
          '',
        ].join('\n'),
        'utf8',
      );
      await createProject({ template: templateDir, outDir: join(templateDir, 'expected'), headless: true });

      expect(await runTemplateTest({ template: templateDir, outDir: out })).toMatchObject({ passed: 1, failed: 0 });
      await writeFile(join(templateDir, 'expected/assets/pixel.bin'), new Uint8Array([0, 1, 2, 3]));
      expect(await runTemplateTest({ template: templateDir, outDir: out })).toMatchObject({ passed: 0, failed: 1 });
      const updateReport = await runTemplateTest({ template: templateDir, outDir: out, updateSnapshots: true });
      expect(updateReport).toMatchObject({ passed: 1, failed: 0, snapshotUpdated: 1 });
      expect(new Uint8Array(await Bun.file(join(templateDir, 'expected/assets/pixel.bin')).arrayBuffer())).toEqual(
        binary,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects escaping processor output when updating artifact snapshots', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-artifact-snapshot-'));
    try {
      await mkdir(join(artifactDir, 'src'), { recursive: true });
      await mkdir(join(artifactDir, 'dist'), { recursive: true });
      await mkdir(join(artifactDir, 'tests/basic/input'), { recursive: true });
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: processor',
          'owner: cyanprint',
          'name: escape',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(artifactDir, 'dist/index.js'),
        'export async function processor(input) { await Bun.write(input.outputDir + "/README.md", "stale"); }',
        'utf8',
      );
      await writeFile(
        join(artifactDir, 'src/index.ts'),
        'export async function processor(input) { await Bun.write(input.outputDir + "/../escape.txt", "bad"); }',
        'utf8',
      );
      await writeFile(join(artifactDir, 'tests/basic/input/README.md'), '# Input\n', 'utf8');
      const report = await runArtifactTests({ artifactDir, updateSnapshots: true });
      expect(report.failed).toBe(1);
      expect(await Bun.file(join(artifactDir, 'tests/basic/escape.txt')).exists()).toBe(false);
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  test('rejects removed commands field in cyanprint test manifests', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-removed-commands-'));
    const processorDir = join(tempRoot, 'processor');
    const templateDir = join(tempRoot, 'template');
    try {
      await mkdir(join(processorDir, 'src'), { recursive: true });
      await mkdir(join(processorDir, 'tests/basic/input'), { recursive: true });
      await mkdir(join(processorDir, 'tests/basic/expected'), { recursive: true });
      await writeFile(
        join(processorDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: processor',
          'owner: cyanprint',
          'name: removed-commands',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(processorDir, 'src/index.ts'), identityProcessorRuntime);
      await writeFile(join(processorDir, 'tests/basic/input/README.md'), '# Input\n', 'utf8');
      await writeFile(join(processorDir, 'tests/basic/expected/README.md'), '# Input\n', 'utf8');
      await writeFile(
        join(processorDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: basic',
          '    input: tests/basic/input',
          '    expected: tests/basic/expected',
          '    commands:',
          '      - exit 0',
          '    snapshot: tests/basic/expected/README.md',
          '',
        ].join('\n'),
        'utf8',
      );

      await mkdir(join(templateDir, 'template'), { recursive: true });
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: removed-commands\nbundledEntry: cyan.ts\nprocessors:\n  - cyan/default\n',
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        'export default function cyan(prompt, ctx) { return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] }; }\n',
        'utf8',
      );
      await writeFile(join(templateDir, 'template/README.md'), '# Template\n', 'utf8');
      await createProject({ template: templateDir, outDir: join(templateDir, 'expected'), headless: true });
      await writeFile(
        join(templateDir, 'cyan.test.yaml'),
        ['cases:', '  - name: basic', '    expected: expected', '    commands:', '      - exit 0', ''].join('\n'),
        'utf8',
      );

      await expect(runArtifactTests({ artifactDir: processorDir })).rejects.toThrow('commands');
      await expect(runTemplateTest({ template: templateDir, outDir: join(tempRoot, 'out') })).rejects.toThrow(
        'commands',
      );

      await writeFile(
        join(processorDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: basic',
          '    input: tests/basic/input',
          '    expected: tests/basic/expected',
          '    snapshot: tests/basic/expected/README.md',
          '',
        ].join('\n'),
        'utf8',
      );
      await expect(runArtifactTests({ artifactDir: processorDir })).rejects.toThrow('snapshot');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('failing validations do not mutate expected output when updating snapshots', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-update-validation-'));
    const processorDir = join(tempRoot, 'processor');
    const resolverDir = join(tempRoot, 'resolver');
    const templateDir = join(tempRoot, 'template');
    try {
      await mkdir(join(processorDir, 'src'), { recursive: true });
      await mkdir(join(processorDir, 'tests/basic/input'), { recursive: true });
      await mkdir(join(processorDir, 'tests/basic/expected'), { recursive: true });
      await writeFile(
        join(processorDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: processor',
          'owner: cyanprint',
          'name: update-validation',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(processorDir, 'src/index.ts'),
        'export async function processor(input) { await Bun.write(input.outputDir + "/README.md", "# New\\n"); }\n',
        'utf8',
      );
      await writeFile(join(processorDir, 'tests/basic/input/README.md'), '# Input\n', 'utf8');
      await writeFile(join(processorDir, 'tests/basic/expected/README.md'), '# Old\n', 'utf8');
      await writeFile(
        join(processorDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: basic',
          '    input: tests/basic/input',
          '    expected: tests/basic/expected',
          '    validations:',
          '      - exit 1',
          '',
        ].join('\n'),
        'utf8',
      );

      await mkdir(join(resolverDir, 'src'), { recursive: true });
      await mkdir(join(resolverDir, 'tests/text'), { recursive: true });
      await mkdir(join(resolverDir, 'tests/folder/current'), { recursive: true });
      await mkdir(join(resolverDir, 'tests/folder/expected'), { recursive: true });
      await mkdir(join(resolverDir, 'tests/fold/input-a'), { recursive: true });
      await mkdir(join(resolverDir, 'tests/fold/input-b'), { recursive: true });
      await mkdir(join(resolverDir, 'tests/fold/expected'), { recursive: true });
      await writeFile(
        join(resolverDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: resolver',
          'owner: cyanprint',
          'name: update-validation',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(resolverDir, 'src/index.ts'), latestFolderResolverRuntime, 'utf8');
      await writeFile(join(resolverDir, 'tests/text/current.txt'), 'new text\n', 'utf8');
      await writeFile(join(resolverDir, 'tests/text/expected.txt'), 'old text\n', 'utf8');
      await writeFile(join(resolverDir, 'tests/folder/current/file.txt'), 'new folder\n', 'utf8');
      await writeFile(join(resolverDir, 'tests/folder/expected/file.txt'), 'old folder\n', 'utf8');
      await writeFile(join(resolverDir, 'tests/fold/input-a/file.txt'), 'first fold\n', 'utf8');
      await writeFile(join(resolverDir, 'tests/fold/input-b/file.txt'), 'new fold\n', 'utf8');
      await writeFile(join(resolverDir, 'tests/fold/expected/file.txt'), 'old fold\n', 'utf8');
      await writeFile(
        join(resolverDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: text',
          '    current: tests/text/current.txt',
          '    expected: tests/text/expected.txt',
          '    validations:',
          '      - exit 1',
          '  - name: folder',
          '    current: tests/folder/current',
          '    expected: tests/folder/expected',
          '    validations:',
          '      - exit 1',
          '  - name: fold',
          '    resolverInputs:',
          '      - path: tests/fold/input-a',
          '        origin: { template: a, layer: 0 }',
          '      - path: tests/fold/input-b',
          '        origin: { template: b, layer: 1 }',
          '    expected: tests/fold/expected',
          '    validations:',
          '      - exit 1',
          '',
        ].join('\n'),
        'utf8',
      );

      await mkdir(join(templateDir, 'template'), { recursive: true });
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: update-validation\nbundledEntry: cyan.ts\nprocessors:\n  - cyan/default\n',
        'utf8',
      );
      await writeFile(
        join(templateDir, 'cyan.ts'),
        'export default function cyan(prompt, ctx) { return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] }; }\n',
        'utf8',
      );
      await writeFile(join(templateDir, 'template/README.md'), '# New\n', 'utf8');
      await mkdir(join(templateDir, 'expected'), { recursive: true });
      await writeFile(join(templateDir, 'expected/README.md'), '# Old\n', 'utf8');
      await writeFile(
        join(templateDir, 'cyan.test.yaml'),
        ['cases:', '  - name: basic', '    expected: expected', '    validations:', '      - exit 1', ''].join('\n'),
        'utf8',
      );

      const processorReport = await runArtifactTests({ artifactDir: processorDir, updateSnapshots: true });
      expect(processorReport).toMatchObject({ passed: 0, failed: 1, snapshotUpdated: 0 });
      expect(await Bun.file(join(processorDir, 'tests/basic/expected/README.md')).text()).toBe('# Old\n');

      const resolverReport = await runArtifactTests({ artifactDir: resolverDir, updateSnapshots: true });
      expect(resolverReport).toMatchObject({ passed: 0, failed: 3, snapshotUpdated: 0 });
      expect(await Bun.file(join(resolverDir, 'tests/text/expected.txt')).text()).toBe('old text\n');
      expect(await Bun.file(join(resolverDir, 'tests/folder/expected/file.txt')).text()).toBe('old folder\n');
      expect(await Bun.file(join(resolverDir, 'tests/fold/expected/file.txt')).text()).toBe('old fold\n');

      const templateReport = await runTemplateTest({
        template: templateDir,
        outDir: join(tempRoot, 'template-out'),
        updateSnapshots: true,
      });
      expect(templateReport).toMatchObject({ passed: 0, failed: 1, snapshotUpdated: 0 });
      expect(await Bun.file(join(templateDir, 'expected/README.md')).text()).toBe('# Old\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('main template parity fixtures', () => {
  test('new template scaffolds all artifact kinds', async () => {
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-template-new-'));
    try {
      const template = 'in-tree/official/templates/new';
      const report = await runTemplateTest({
        template,
        answers: join(root, template, 'answers.json'),
        outDir: out,
      });
      expect(report).toMatchObject({ passed: 4, failed: 0 });
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test('new template generated runtime artifacts pass their own artifact tests', async () => {
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-template-new-generated-'));
    try {
      const template = join(root, 'in-tree/official/templates/new');
      const generated = [
        ['processor', 'answers-processor.json'],
        ['plugin', 'answers-plugin.json'],
        ['resolver', 'answers-resolver.json'],
      ] as const;
      for (const [kind, answers] of generated) {
        const artifactOut = join(out, kind);
        await createProject({
          template,
          outDir: artifactOut,
          headless: true,
          answers: JSON.parse(await Bun.file(join(template, answers)).text()) as Record<string, unknown>,
        });
        const report = await runArtifactTests({ artifactDir: artifactOut });
        expect(report, kind).toMatchObject({ passed: 1, failed: 0 });
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  for (const name of ['workspace', 'nix']) {
    test(`${name} template matches its expected output fixture`, async () => {
      const out = await mkdtemp(join(tmpdir(), `cyanprint-test-template-${name}-`));
      try {
        const template = `examples/templates/${name}`;
        const report = await runTemplateTest({
          template,
          answers: join(root, template, 'answers.json'),
          outDir: out,
        });
        expect(report).toMatchObject({ passed: 1, failed: 0 });
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    });
  }
});

describe('update three state resolver merge trust safety post generation command machine readable errors', () => {
  test('update reuses answers and merge exposes conflicts', async () => {
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-update-'));
    try {
      await createProject({
        template: join(root, 'examples/templates/update-v1'),
        outDir: out,
        answers: { name: 'Update Project' },
      });
      const update = await updateProject({
        projectDir: out,
        template: join(root, 'examples/templates/update-v2'),
        answers: { tagline: 'Updated with pinned answers.' },
      });
      expect(update.status).toBe('done');
      expect(mergeFile({ prior: 'a', current: 'b', target: 'c' }).status).toBe('conflicted');
      expect(evaluateTrust({ trusted: true, version: '4', integrity: 'abc' }).scope).toBe('version');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test('update reuses deterministic state from the previous install', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-update-deterministic-'));
    const v1 = join(tempRoot, 'v1');
    const v2 = join(tempRoot, 'v2');
    const out = join(tempRoot, 'out');
    try {
      for (const [dir, fallback] of [
        [v1, 'stable-id'],
        [v2, 'changed-id'],
      ] as const) {
        await mkdir(join(dir, 'template'), { recursive: true });
        await writeFile(join(dir, 'template/README.md'), '# @@ ID @@\n', 'utf8');
        await writeFile(
          join(dir, 'cyan.yaml'),
          [
            'cyanprint: 4',
            'kind: template',
            'owner: cyanprint',
            'name: deterministic-update',
            'bundledEntry: cyan.ts',
            'processors:',
            '  - cyan/default',
            '',
          ].join('\n'),
          'utf8',
        );
        await writeFile(
          join(dir, 'cyan.ts'),
          [
            'export default function cyan(prompt, ctx) {',
            `  const id = ctx.deterministic.get("id") ?? ${JSON.stringify(fallback)};`,
            '  ctx.deterministic.set("id", id);',
            '  return { processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }], config: { vars: { ID: id }, parser: { varSyntax: [["@@", "@@"]] } } }] };',
            '}',
            '',
          ].join('\n'),
          'utf8',
        );
      }

      await createProject({ template: v1, outDir: out, headless: true });
      await updateProject({ projectDir: out, template: v2, headless: true });

      expect(await Bun.file(join(out, 'README.md')).text()).toBe('# stable-id\n');
      expect(await Bun.file(join(out, '.cyan_state.yaml')).text()).toContain('id: stable-id');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('update records resolver output in generated state', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-update-resolver-'));
    const v1 = join(tempRoot, 'v1');
    const v2 = join(tempRoot, 'v2');
    const out = join(tempRoot, 'out');
    try {
      for (const [dir, value] of [
        [v1, 'generated v1'],
        [v2, 'generated v2'],
      ] as const) {
        await mkdir(join(dir, 'template'), { recursive: true });
        await writeFile(join(dir, 'template/README.md'), value, 'utf8');
        await writeFile(
          join(dir, 'cyan.yaml'),
          [
            'cyanprint: 4',
            'kind: template',
            'owner: cyanprint',
            'name: resolver-output-state',
            'bundledEntry: cyan.ts',
            'processors:',
            '  - cyan/default',
            'resolvers:',
            '  - cyanprint/keep-user',
            '',
          ].join('\n'),
          'utf8',
        );
        await writeFile(
          join(dir, 'cyan.ts'),
          [
            'export default async function cyan() {',
            '  return {',
            '    processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }],',
            '    resolvers: [{ name: "cyanprint/keep-user", config: { paths: ["README.md"] } }],',
            '  };',
            '}',
            '',
          ].join('\n'),
          'utf8',
        );
      }
      await createProject({ template: v1, outDir: out, headless: true });
      await writeFile(join(out, 'README.md'), '# User Edit\n\nKeep me.\n', 'utf8');
      const update = await updateProject({
        projectDir: out,
        template: v2,
      });
      expect(update.status).toBe('done');
      const state = await Bun.file(join(out, '.cyan_state.yaml')).text();
      expect(state).toContain('# User Edit');
      expect(state).toContain(sha256('# User Edit\n\nKeep me.\n'));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('update conflicts when a text-tracked resolver file is replaced with binary bytes', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-update-binary-current-conflict-'));
    const v1 = join(tempRoot, 'v1');
    const v2 = join(tempRoot, 'v2');
    const out = join(tempRoot, 'out');
    try {
      for (const [dir, value] of [
        [v1, 'v1'],
        [v2, 'v2'],
      ] as const) {
        await mkdir(join(dir, 'template'), { recursive: true });
        await writeFile(join(dir, 'template/README.md'), value, 'utf8');
        await writeFile(
          join(dir, 'cyan.yaml'),
          [
            'cyanprint: 4',
            'kind: template',
            'owner: cyanprint',
            'name: binary-current-conflict',
            'bundledEntry: cyan.ts',
            'processors:',
            '  - cyan/default',
            'resolvers:',
            '  - cyanprint/keep-user',
            '',
          ].join('\n'),
          'utf8',
        );
        await writeFile(
          join(dir, 'cyan.ts'),
          [
            'export default async function cyan(prompt, ctx) {',
            '  return {',
            '    processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }],',
            '    resolvers: [{ name: "cyanprint/keep-user", config: { paths: ["README.md"] } }],',
            '  };',
            '}',
            '',
          ].join('\n'),
          'utf8',
        );
      }
      await createProject({ template: v1, outDir: out, headless: true });
      await writeFile(join(out, 'README.md'), new Uint8Array([0xff, 0xfe, 0xfd, 0x00]));

      const update = await updateProject({ projectDir: out, template: v2 });

      expect(update).toMatchObject({
        status: 'conflict',
        conflicts: [{ path: 'README.md', reason: 'user_edit_and_target_changed' }],
      });
      expect(new Uint8Array(await Bun.file(join(out, 'README.md')).arrayBuffer())).toEqual(
        new Uint8Array([0xff, 0xfe, 0xfd, 0x00]),
      );
      expect(await Bun.file(join(out, '.cyan_conflicts/README.md.target')).exists()).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('update conflicts instead of choosing between ambiguous matching resolvers', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-update-ambiguous-resolver-'));
    const v1 = join(tempRoot, 'v1');
    const v2 = join(tempRoot, 'v2');
    const out = join(tempRoot, 'out');
    try {
      for (const [dir, value] of [
        [v1, 'v1'],
        [v2, 'v2'],
      ] as const) {
        await mkdir(join(dir, 'template'), { recursive: true });
        await writeFile(join(dir, 'template/README.md'), value, 'utf8');
        await writeFile(
          join(dir, 'cyan.yaml'),
          [
            'cyanprint: 4',
            'kind: template',
            'owner: cyanprint',
            'name: ambiguous-resolver-update',
            'bundledEntry: cyan.ts',
            'processors:',
            '  - cyan/default',
            'resolvers:',
            '  - cyanprint/resolver1',
            '  - cyanprint/resolver2',
            '',
          ].join('\n'),
          'utf8',
        );
        await writeFile(
          join(dir, 'cyan.ts'),
          [
            'export default async function cyan() {',
            '  return {',
            '    processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }],',
            '    resolvers: [',
            '      { name: "cyanprint/resolver1", config: { paths: ["README.md"] } },',
            '      { name: "cyanprint/resolver2", config: { paths: ["README.md"] } },',
            '    ],',
            '  };',
            '}',
            '',
          ].join('\n'),
          'utf8',
        );
      }
      await createProject({ template: v1, outDir: out, headless: true });
      await writeFile(join(out, 'README.md'), 'user edit', 'utf8');

      const update = await updateProject({ projectDir: out, template: v2 });

      expect(update).toMatchObject({
        status: 'conflict',
        conflicts: [{ path: 'README.md', reason: 'user_edit_and_target_changed_ambiguous_resolver' }],
      });
      expect(await Bun.file(join(out, 'README.md')).text()).toBe('user edit');
      expect(await Bun.file(join(out, '.cyan_conflicts/README.md.target')).text()).toBe('v2\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('update preserves generated binary files when target changes', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-update-binary-'));
    const v1 = join(tempRoot, 'v1');
    const v2 = join(tempRoot, 'v2');
    const out = join(tempRoot, 'out');
    try {
      for (const dir of [v1, v2]) {
        await mkdir(join(dir, 'template'), { recursive: true });
        await writeFile(
          join(dir, 'cyan.yaml'),
          [
            'cyanprint: 4',
            'kind: template',
            'owner: cyanprint',
            'name: binary-update',
            'bundledEntry: cyan.ts',
            'processors:',
            '  - cyan/default',
            '',
          ].join('\n'),
          'utf8',
        );
      }
      await writeFile(join(v1, 'template/asset.bin'), new Uint8Array([0, 1]));
      await writeFile(join(v2, 'template/asset.bin'), new Uint8Array([254, 254]));
      for (const dir of [v1, v2]) {
        await writeFile(
          join(dir, 'cyan.ts'),
          [
            'export default async () => ({',
            '  processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Copy" }] }],',
            '});',
            '',
          ].join('\n'),
          'utf8',
        );
      }

      await createProject({ template: v1, outDir: out, headless: true });
      const update = await updateProject({ projectDir: out, template: v2 });

      expect(update.status).toBe('done');
      expect(new Uint8Array(await Bun.file(join(out, 'asset.bin')).arrayBuffer())).toEqual(new Uint8Array([254, 254]));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('update reports conflict instead of resurrecting user-deleted generated files', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-update-deleted-'));
    const v1 = join(tempRoot, 'v1');
    const v2 = join(tempRoot, 'v2');
    const out = join(tempRoot, 'out');
    try {
      for (const dir of [v1, v2]) {
        await mkdir(join(dir, 'template'), { recursive: true });
        await writeFile(
          join(dir, 'cyan.yaml'),
          [
            'cyanprint: 4',
            'kind: template',
            'owner: cyanprint',
            'name: deleted-update',
            'bundledEntry: cyan.ts',
            'processors:',
            '  - cyan/default',
            '',
          ].join('\n'),
          'utf8',
        );
      }
      await writeFile(join(v1, 'template/README.md'), 'v1', 'utf8');
      await writeFile(join(v2, 'template/README.md'), 'v2', 'utf8');
      for (const dir of [v1, v2]) {
        await writeFile(
          join(dir, 'cyan.ts'),
          'export default async () => ({ processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] });\n',
          'utf8',
        );
      }

      await createProject({ template: v1, outDir: out, headless: true });
      await rm(join(out, 'README.md'), { force: true });
      const update = await updateProject({ projectDir: out, template: v2 });

      expect(update).toMatchObject({
        status: 'conflict',
        conflicts: [{ path: 'README.md', reason: 'user_deleted_and_target_changed' }],
      });
      expect(await Bun.file(join(out, 'README.md')).exists()).toBe(false);
      expect(await Bun.file(join(out, '.cyan_conflicts/README.md.target')).text()).toBe('v2\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('conflicted update does not partially write clean target files', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-update-atomic-conflict-'));
    const v1 = join(tempRoot, 'v1');
    const v2 = join(tempRoot, 'v2');
    const out = join(tempRoot, 'out');
    try {
      for (const dir of [v1, v2]) {
        await mkdir(join(dir, 'template'), { recursive: true });
        await writeFile(
          join(dir, 'cyan.yaml'),
          [
            'cyanprint: 4',
            'kind: template',
            'owner: cyanprint',
            'name: atomic-update',
            'bundledEntry: cyan.ts',
            'processors:',
            '  - cyan/default',
            '',
          ].join('\n'),
          'utf8',
        );
      }
      await writeFile(join(v1, 'template/A.md'), 'a1', 'utf8');
      await writeFile(join(v1, 'template/B.md'), 'b1', 'utf8');
      await writeFile(join(v2, 'template/A.md'), 'a2', 'utf8');
      await writeFile(join(v2, 'template/B.md'), 'b2', 'utf8');
      for (const dir of [v1, v2]) {
        await writeFile(
          join(dir, 'cyan.ts'),
          'export default async () => ({ processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] });\n',
          'utf8',
        );
      }

      await createProject({ template: v1, outDir: out, headless: true });
      await writeFile(join(out, 'B.md'), 'user edit', 'utf8');
      const update = await updateProject({ projectDir: out, template: v2 });

      expect(update.status).toBe('conflict');
      expect(await Bun.file(join(out, 'A.md')).text()).toBe('a1\n');
      expect(await Bun.file(join(out, 'B.md')).text()).toBe('user edit');
      expect(await Bun.file(join(out, '.cyan_conflicts/B.md.target')).text()).toBe('b2\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('update reports conflict when generated file is replaced by a directory', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-update-directory-conflict-'));
    const v1 = join(tempRoot, 'v1');
    const v2 = join(tempRoot, 'v2');
    const out = join(tempRoot, 'out');
    try {
      for (const dir of [v1, v2]) {
        await mkdir(join(dir, 'template'), { recursive: true });
        await writeFile(
          join(dir, 'cyan.yaml'),
          [
            'cyanprint: 4',
            'kind: template',
            'owner: cyanprint',
            'name: directory-conflict',
            'bundledEntry: cyan.ts',
            'processors:',
            '  - cyan/default',
            '',
          ].join('\n'),
          'utf8',
        );
      }
      await writeFile(join(v1, 'template/README.md'), 'v1', 'utf8');
      await writeFile(join(v2, 'template/README.md'), 'v2', 'utf8');
      for (const dir of [v1, v2]) {
        await writeFile(
          join(dir, 'cyan.ts'),
          'export default async () => ({ processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] });\n',
          'utf8',
        );
      }

      await createProject({ template: v1, outDir: out, headless: true });
      await rm(join(out, 'README.md'));
      await mkdir(join(out, 'README.md'));
      const update = await updateProject({ projectDir: out, template: v2 });

      expect(update).toMatchObject({
        status: 'conflict',
        conflicts: [{ path: 'README.md', reason: 'user_replaced_file_with_directory' }],
      });
      expect(await Bun.file(join(out, '.cyan_conflicts/README.md.target')).text()).toBe('v2\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('update preserves prior generated state when regenerated target is unchanged from prior', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-update-unchanged-target-'));
    const v1 = join(tempRoot, 'v1');
    const v2 = join(tempRoot, 'v2');
    const v3 = join(tempRoot, 'v3');
    const out = join(tempRoot, 'out');
    try {
      for (const dir of [v1, v2, v3]) {
        await mkdir(join(dir, 'template'), { recursive: true });
        await writeFile(
          join(dir, 'cyan.yaml'),
          [
            'cyanprint: 4',
            'kind: template',
            'owner: cyanprint',
            'name: unchanged-target',
            'bundledEntry: cyan.ts',
            'processors:',
            '  - cyan/default',
            '',
          ].join('\n'),
          'utf8',
        );
      }
      await writeFile(join(v1, 'template/README.md'), 'same', 'utf8');
      await writeFile(join(v1, 'template/OTHER.md'), 'old', 'utf8');
      await writeFile(join(v2, 'template/README.md'), 'same', 'utf8');
      await writeFile(join(v2, 'template/OTHER.md'), 'new', 'utf8');
      await writeFile(join(v3, 'template/README.md'), 'changed', 'utf8');
      await writeFile(join(v3, 'template/OTHER.md'), 'new', 'utf8');
      for (const dir of [v1, v2, v3]) {
        await writeFile(
          join(dir, 'cyan.ts'),
          'export default async () => ({ processors: [{ name: "cyan/default", files: [{ root: "template", glob: "**/*", type: "Template" }] }] });\n',
          'utf8',
        );
      }

      await createProject({ template: v1, outDir: out, headless: true });
      await writeFile(join(out, 'README.md'), 'user edit', 'utf8');
      const update = await updateProject({ projectDir: out, template: v2 });

      expect(update.status).toBe('done');
      expect(await Bun.file(join(out, 'README.md')).text()).toBe('user edit');
      expect(await Bun.file(join(out, 'OTHER.md')).text()).toBe('new\n');
      const stateAfterUnchangedTarget = await Bun.file(join(out, '.cyan_state.yaml')).text();
      expect(stateAfterUnchangedTarget).toContain('same');
      expect(stateAfterUnchangedTarget).not.toContain('user edit');

      const nextUpdate = await updateProject({ projectDir: out, template: v3 });

      expect(nextUpdate).toMatchObject({
        status: 'conflict',
        conflicts: [{ path: 'README.md', reason: 'user_edit_and_target_changed' }],
      });
      expect(await Bun.file(join(out, 'README.md')).text()).toBe('user edit');
      expect(await Bun.file(join(out, '.cyan_conflicts/README.md.target')).text()).toBe('changed\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('registry-hydrated templates resolve unversioned artifacts from pinned cache entries', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-cache-artifact-'));
    const template = join(tempRoot, 'template');
    const runtime = join(tempRoot, 'runtime');
    const out = join(tempRoot, 'out');
    try {
      await mkdir(template, { recursive: true });
      await mkdir(runtime, { recursive: true });
      await writeFile(
        join(template, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: cached-default',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyan/default',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(template, 'cyan.ts'),
        [
          'export default async () => ({',
          '  processors: [{ kind: "processor", owner: "cyan", name: "default" }],',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(runtime, 'processor.js'),
        'export async function processor(input) { await Bun.write(input.outputDir + "/README.md", "from-cache\\n"); }\n',
        'utf8',
      );
      await writeFile(
        join(template, '.cyan_artifact_bundles.json'),
        JSON.stringify({
          bundles: [
            {
              key: 'processor:cyan:default:4',
              dependency: { kind: 'processor', owner: 'cyan', name: 'default', version: '4' },
              runtimeFile: join(runtime, 'processor.js'),
              integrity: sha256(await Bun.file(join(runtime, 'processor.js')).text()),
            },
          ],
        }),
        'utf8',
      );

      await createProject({ template, outDir: out, headless: true });

      expect(await Bun.file(join(out, 'README.md')).text()).toBe('from-cache\n');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('template resolver parity fixtures merge cross-template updates', async () => {
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-template-resolvers-'));
    try {
      await createProject({
        template: join(root, 'examples/templates/template-resolver-1'),
        outDir: out,
        headless: true,
      });
      await writeFile(join(out, '.gitignore'), 'ignore-type-1\ninternal\n', 'utf8');
      await writeFile(
        join(out, 'c1.json'),
        `${JSON.stringify({ nodes: { user: true }, list: [9] }, null, 2)}\n`,
        'utf8',
      );
      await writeFile(
        join(out, 'c2.json'),
        `${JSON.stringify({ nodes: { user: true }, list: [9] }, null, 2)}\n`,
        'utf8',
      );
      await writeFile(
        join(out, 'c3.json'),
        `${JSON.stringify({ nodes: { user: true }, list: [2, 9] }, null, 2)}\n`,
        'utf8',
      );

      const result = await updateProject({
        projectDir: out,
        template: join(root, 'examples/templates/template-resolver-2'),
        headless: true,
      });

      expect(result.status).toBe('done');
      expect(await Bun.file(join(out, 'from-1.txt')).exists()).toBe(false);
      expect(await Bun.file(join(out, 'from-2.txt')).exists()).toBe(true);
      const gitignore = await Bun.file(join(out, '.gitignore')).text();
      expect(gitignore).toContain('ignore-type-1');
      expect(gitignore).toContain('ignore-type-2');
      expect(gitignore).toContain('internal');
      expect(JSON.parse(await Bun.file(join(out, 'c1.json')).text()).list).toEqual([1, 9, 3]);
      expect(JSON.parse(await Bun.file(join(out, 'c2.json')).text()).list).toEqual([3]);
      expect(JSON.parse(await Bun.file(join(out, 'c3.json')).text()).list).toEqual([1, 2, 9, 3]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test('post-generation commands run inside the generated project directory', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-command-cwd-'));
    const template = join(tempRoot, 'template');
    const out = join(tempRoot, 'out');
    try {
      await mkdir(template, { recursive: true });
      await writeFile(
        join(template, 'cyan.yaml'),
        ['cyanprint: 4', 'kind: template', 'owner: cyanprint', 'name: command-cwd', 'bundledEntry: cyan.ts', ''].join(
          '\n',
        ),
        'utf8',
      );
      await writeFile(
        join(template, 'cyan.ts'),
        [
          'export default async () => ({',
          '  commands: [{',
          '    command: "bun",',
          '    args: ["--eval", "await Bun.write(\\"post-command-cwd.txt\\", process.cwd())"],',
          '    allow: true,',
          '  }],',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );

      await createProject({ template, outDir: out, headless: true });

      expect(await realpath(await Bun.file(join(out, 'post-command-cwd.txt')).text())).toBe(await realpath(out));
      expect(await Bun.file(join(out, '.cyan_state.yaml')).text()).toContain('post-command-cwd.txt');
      expect(await Bun.file(join(root, 'post-command-cwd.txt')).exists()).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(join(root, 'post-command-cwd.txt'), { force: true });
    }
  });
});
