import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactCacheKey,
  artifactCachePath,
  createProject,
  createTempSession,
  evaluateTrust,
  executeCyanScript,
  mergeFile,
  runArtifactTests,
  runTemplateTest,
  resolveCyanCacheDir,
  safeJoin,
  sha256,
  updateProject,
} from './index';

const root = process.cwd();

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
      const runtime = `export function processor(input) { const { files } = input; return files; }\n`;
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
      await createProject({
        template: join(root, 'examples/templates/with-artifacts'),
        outDir: out,
        answers: { name: 'Artifact Project' },
        headless: true,
      });
      const readme = await Bun.file(join(out, 'README.md')).text();
      expect(readme).toContain('# ARTIFACT PROJECT');
      expect(readme).toContain('Generated locally.');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test('applies multiple scoped processors sequentially', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-multiple-processors-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-multiple-processors-out-'));
    try {
      await mkdir(join(templateDir, 'template/docs'), { recursive: true });
      await mkdir(join(templateDir, 'dist'), { recursive: true });
      const firstRuntime = join(templateDir, 'dist/append-a.js');
      const secondRuntime = join(templateDir, 'dist/append-b.js');
      const first = `export function processor(input) { const { files } = input; return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, content + "A"])); }\n`;
      const second = `export function processor(input) { const { files } = input; return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, content + "B"])); }\n`;
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

      expect(await Bun.file(join(out, 'docs/note.md')).text()).toBe('startAB');
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
      const runtime = `export function processor(input) { const { files, config } = input; return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, content + config.suffix])); }\n`;
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

  test('pipes renamed scoped processor output into the next processor', async () => {
    const templateDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-processor-rename-pipeline-'));
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-processor-rename-pipeline-out-'));
    try {
      await mkdir(join(templateDir, 'template/docs'), { recursive: true });
      await mkdir(join(templateDir, 'dist'), { recursive: true });
      const renameRuntime = join(templateDir, 'dist/rename.js');
      const appendRuntime = join(templateDir, 'dist/append.js');
      const rename = `export function processor(input) { const { files } = input; return { "docs/renamed.md": files["docs/note.md"] + "R" }; }\n`;
      const append = `export function processor(input) { const { files } = input; return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, content + "A"])); }\n`;
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

      expect(await Bun.file(join(out, 'docs/note.md')).exists()).toBe(false);
      expect(await Bun.file(join(out, 'docs/renamed.md')).text()).toBe('startRA');
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
      const runtime = `export function processor(input) { return { "../README.md": "bad" }; }\n`;
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
      const runtime = `export function processor(input) { const { files } = input; return files; }\n`;
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
          'export function processor(input) { const { files, config } = input;',
          '    const vars = config?.vars ?? {};',
          '    return Object.fromEntries(Object.entries(files).map(([path, content]) => {',
          '      let next = String(content);',
          '      for (const [name, value] of Object.entries(vars)) {',
          '        next = next.replaceAll(`__${name}__`, String(value));',
          '      }',
          '      return [path, `${next}processed\\n`];',
          '    }));',
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
        'export function resolver(input) {',
        '  return input.files.map(file => `${file.origin.template}:${file.origin.layer}`).join("\\n") + "\\n";',
        '}',
        '',
      ].join('\n'),
    );
    try {
      await createProject({ template: fixture.groupDir, outDir: fixture.outDir, answers: {}, headless: true });

      expect(await Bun.file(join(fixture.outDir, 'shared.txt')).text()).toBe('same-a:0\nsame-b:1\nsame-c:2\n');
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
    const runtime =
      resolverRuntime ??
      [
        'export function resolver(input) {',
        '    return input.files.map(file => file.content).filter(Boolean).join("");',
        '}',
        '',
      ].join('\n');
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
      await writeFile(join(artifactDir, 'snapshots/basic/data.json'), '{\n  "a": 1,\n  "b": 2\n}\n', 'utf8');

      const report = await runArtifactTests({ artifactDir });

      expect(report).toMatchObject({ kind: 'resolver', passed: 1, failed: 0 });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('command validation failures fail artifact and template reports', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-command-validation-'));
    const processorDir = join(tempRoot, 'processor');
    const pluginDir = join(tempRoot, 'plugin');
    const templateDir = join(tempRoot, 'template');
    const out = join(tempRoot, 'out');
    try {
      await mkdir(join(processorDir, 'src'), { recursive: true });
      await mkdir(join(processorDir, 'tests/basic/input'), { recursive: true });
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
      await writeFile(
        join(processorDir, 'src/index.ts'),
        'export function processor(input) { const { files } = input; return files; }\n',
        'utf8',
      );
      await writeFile(join(processorDir, 'tests/basic/input/README.md'), '# Input\n', 'utf8');
      await writeFile(
        join(processorDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: basic',
          '    input: tests/basic/input',
          '    commands:',
          '      - process.exit(1)',
          '',
        ].join('\n'),
        'utf8',
      );

      await mkdir(join(pluginDir, 'src'), { recursive: true });
      await mkdir(join(pluginDir, 'tests/basic/input'), { recursive: true });
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
      await writeFile(
        join(pluginDir, 'src/index.ts'),
        'export function plugin(input) { const { files } = input; return files; }\n',
        'utf8',
      );
      await writeFile(join(pluginDir, 'tests/basic/input/README.md'), '# Input\n', 'utf8');
      await writeFile(
        join(pluginDir, 'cyan.test.yaml'),
        [
          'cases:',
          '  - name: basic',
          '    input: tests/basic/input',
          '    commands:',
          '      - process.exit(1)',
          '',
        ].join('\n'),
        'utf8',
      );

      await mkdir(join(templateDir, 'template'), { recursive: true });
      await writeFile(join(templateDir, 'template/README.md'), '# Template\n', 'utf8');
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
        ['cases:', '  - name: basic', '    commands:', '      - process.exit(1)', ''].join('\n'),
        'utf8',
      );

      expect(await runArtifactTests({ artifactDir: processorDir })).toMatchObject({ passed: 0, failed: 1 });
      expect(await runArtifactTests({ artifactDir: pluginDir })).toMatchObject({ passed: 0, failed: 1 });
      expect(await runTemplateTest({ template: templateDir, outDir: out })).toMatchObject({ passed: 0, failed: 1 });
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
        'export function processor(input) { return { "README.md": "stale" }; }',
        'utf8',
      );
      await writeFile(
        join(artifactDir, 'src/index.ts'),
        'export function processor(input) { return { "../escape.txt": "bad" }; }',
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
});

describe('main template parity fixtures', () => {
  test('new template scaffolds all artifact kinds', async () => {
    const out = await mkdtemp(join(tmpdir(), 'cyanprint-test-template-new-'));
    try {
      const template = join(root, 'in-tree/official/templates/new');
      const report = await runTemplateTest({
        template,
        answers: join(template, 'answers.json'),
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
    test(`${name} template matches its README snapshot`, async () => {
      const out = await mkdtemp(join(tmpdir(), `cyanprint-test-template-${name}-`));
      try {
        const template = join(root, 'examples/templates', name);
        const report = await runTemplateTest({
          template,
          answers: join(template, 'answers.json'),
          outDir: out,
          snapshot: join(template, 'expected/README.md'),
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
        'export function processor(input) { return { "README.md": "from-cache\\n" }; }\n',
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
