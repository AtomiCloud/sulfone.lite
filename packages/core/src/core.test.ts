import { describe, expect, test } from 'bun:test';
import { link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import {
  applyMergedTree,
  artifactCacheKey,
  artifactCachePath,
  buildGeneratedState,
  createProject,
  createTempSession,
  evaluateTrust,
  executeCyanScript,
  exists,
  gitThreeWayMerge,
  loadGeneratedState,
  migrateGeneratedState,
  resolveCyanCacheDir,
  resolveLayers,
  runArtifactTests,
  runTemplateTest,
  safeJoin,
  sha256,
  traceProject,
  updateProject,
  writeGeneratedState,
} from './index';

const root = process.cwd();

/** Create a FIFO (named pipe) at `path`; used to prove the write guard rejects special files. */
async function mkfifo(path: string): Promise<void> {
  const proc = Bun.spawn(['mkfifo', path], { stdout: 'ignore', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`mkfifo failed (${code}): ${await new Response(proc.stderr).text()}`);
  }
}

// Keep processor-output cache writes out of the developer's real ~/.cyan cache.
process.env.CYANPRINT_CACHE_DIR = await mkdtemp(join(tmpdir(), 'cyanprint-test-global-cache-'));

const LONG = 120_000;

// ---------------------------------------------------------------------------
// Inline artifact runtimes (entry === bundledEntry .ts files)
// ---------------------------------------------------------------------------

/** Substitutes `__KEY__` markers from `config.vars` over every scoped text file. */
const varsProcessorRuntime = [
  "import { mkdir } from 'node:fs/promises';",
  "import { dirname } from 'node:path';",
  'export async function processor(input) {',
  '  const vars = (input.config && input.config.vars) || {};',
  "  const glob = new Bun.Glob('**/*');",
  '  for await (const path of glob.scan({ cwd: input.inputDir, onlyFiles: true, dot: true })) {',
  "    let text = await Bun.file(input.inputDir + '/' + path).text();",
  '    for (const [key, value] of Object.entries(vars)) {',
  "      text = text.replaceAll('__' + key + '__', String(value));",
  '    }',
  "    await mkdir(dirname(input.outputDir + '/' + path), { recursive: true });",
  "    await Bun.write(input.outputDir + '/' + path, text);",
  '  }',
  '}',
  '',
].join('\n');

const identityProcessorRuntime = [
  "import { mkdir } from 'node:fs/promises';",
  "import { dirname } from 'node:path';",
  'export async function processor(input) {',
  "  const glob = new Bun.Glob('**/*');",
  '  for await (const path of glob.scan({ cwd: input.inputDir, onlyFiles: true, dot: true })) {',
  "    await mkdir(dirname(input.outputDir + '/' + path), { recursive: true });",
  "    await Bun.write(input.outputDir + '/' + path, await Bun.file(input.inputDir + '/' + path).text());",
  '  }',
  '}',
  '',
].join('\n');

/** Appends `config.suffix` to every scoped file. */
const appendProcessorRuntime = [
  "import { mkdir } from 'node:fs/promises';",
  "import { dirname } from 'node:path';",
  'export async function processor(input) {',
  "  const suffix = (input.config && input.config.suffix) || '';",
  "  const glob = new Bun.Glob('**/*');",
  '  for await (const path of glob.scan({ cwd: input.inputDir, onlyFiles: true, dot: true })) {',
  "    const text = await Bun.file(input.inputDir + '/' + path).text();",
  "    await mkdir(dirname(input.outputDir + '/' + path), { recursive: true });",
  "    await Bun.write(input.outputDir + '/' + path, text + suffix);",
  '  }',
  '}',
  '',
].join('\n');

const uppercaseProcessorRuntime = [
  "import { mkdir } from 'node:fs/promises';",
  "import { dirname } from 'node:path';",
  'export async function processor(input) {',
  "  const glob = new Bun.Glob('**/*');",
  '  for await (const path of glob.scan({ cwd: input.inputDir, onlyFiles: true, dot: true })) {',
  "    const text = await Bun.file(input.inputDir + '/' + path).text();",
  "    await mkdir(dirname(input.outputDir + '/' + path), { recursive: true });",
  "    await Bun.write(input.outputDir + '/' + path, text.toUpperCase());",
  '  }',
  '}',
  '',
].join('\n');

const renameProcessorRuntime = [
  "import { mkdir } from 'node:fs/promises';",
  "import { dirname } from 'node:path';",
  'export async function processor(input) {',
  "  const text = await Bun.file(input.inputDir + '/docs/note.md').text();",
  "  await mkdir(dirname(input.outputDir + '/docs/renamed.md'), { recursive: true });",
  "  await Bun.write(input.outputDir + '/docs/renamed.md', text + 'R');",
  '}',
  '',
].join('\n');

const escapeProcessorRuntime =
  'export async function processor(input) { await Bun.write(input.outputDir + "/../README.md", "bad"); }\n';

// Synthesizes fresh probe-surface OUTPUT paths (`probes/tests.ts`, `probes.yaml`) that never
// existed as template inputs — reviewer-2's loop-4 vector. The input-side `globTemplateFiles`
// filter cannot catch these because they are minted by the processor, not read off disk; only
// the generated-tree waist filter keeps them out of the repo (AC5).
const probeEmittingProcessorRuntime = [
  "import { mkdir } from 'node:fs/promises';",
  "import { dirname } from 'node:path';",
  'export async function processor(input) {',
  "  const glob = new Bun.Glob('**/*');",
  '  for await (const path of glob.scan({ cwd: input.inputDir, onlyFiles: true, dot: true })) {',
  "    const text = await Bun.file(input.inputDir + '/' + path).text();",
  "    await mkdir(dirname(input.outputDir + '/' + path), { recursive: true });",
  "    await Bun.write(input.outputDir + '/' + path, text);",
  '  }',
  '  // Mint a probe surface out of thin air: no such input path exists.',
  "  await mkdir(input.outputDir + '/probes', { recursive: true });",
  "  await Bun.write(input.outputDir + '/probes/tests.ts', '// synthesized probe\\n');",
  "  await Bun.write(input.outputDir + '/probes.yaml', 'contractVersion: 1\\nfeatures: []\\n');",
  '}',
  '',
].join('\n');

const footerPluginRuntime = [
  'export async function plugin(input) {',
  "  const readme = await Bun.file(input.outputDir + '/README.md').text();",
  "  await Bun.write(input.outputDir + '/README.md', readme + 'Generated locally.\\n');",
  '}',
  '',
].join('\n');

/** New resolver API: one call per path with every variation; returns the merged file. */
const concatResolverRuntime = [
  'export function resolver(input) {',
  '  const sorted = [...input.files].sort((left, right) => left.origin.layer - right.origin.layer);',
  "  return { path: sorted[0].path, content: sorted.map(file => file.content).join('') };",
  '}',
  '',
].join('\n');

/** Echoes every variation's origin (template, layer, processor ref + invocation). */
const originResolverRuntime = [
  'export function resolver(input) {',
  '  const sorted = [...input.files].sort((left, right) => left.origin.layer - right.origin.layer);',
  '  const lines = sorted.map(',
  '    file =>',
  "      file.origin.template + ':' + file.origin.layer +",
  "      (file.origin.processor ? ':' + file.origin.processor.ref + '#' + file.origin.processor.invocation : ''),",
  '  );',
  "  return { path: sorted[0].path, content: lines.join('\\n') + '\\n' };",
  '}',
  '',
].join('\n');

/** Hermetic-cache probe: appends a marker to an absolute side-channel counter file. */
const counterProcessorRuntime = (counterFile: string): string =>
  [
    `const counterFile = ${JSON.stringify(counterFile)};`,
    'export async function processor(input) {',
    "  const current = await Bun.file(counterFile).text().catch(() => '');",
    "  await Bun.write(counterFile, current + 'x');",
    "  await Bun.write(input.outputDir + '/GENERATED.md', 'generated\\n');",
    '}',
    '',
  ].join('\n');

// ---------------------------------------------------------------------------
// Fixture helpers: temp workspace with examples/templates + examples/artifacts
// ---------------------------------------------------------------------------

type Fixture = {
  root: string;
  templates: string;
  artifacts: string;
  out: string;
  cleanup: () => Promise<void>;
};

async function makeFixture(prefix: string): Promise<Fixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), `cyanprint-test-${prefix}-`));
  const templates = join(fixtureRoot, 'examples/templates');
  const artifacts = join(fixtureRoot, 'examples/artifacts');
  await mkdir(templates, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  return {
    root: fixtureRoot,
    templates,
    artifacts,
    out: join(fixtureRoot, 'out'),
    cleanup: async () => {
      await rm(fixtureRoot, { recursive: true, force: true });
    },
  };
}

async function writeArtifact(
  fixture: Fixture,
  args: { kind: 'processor' | 'plugin' | 'resolver'; name: string; owner?: string; version?: string; runtime: string },
): Promise<string> {
  const dir = join(fixture.artifacts, `${args.kind}-${args.owner ?? 'cyanprint'}-${args.name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'cyan.yaml'),
    YAML.stringify({
      cyanprint: 4,
      kind: args.kind,
      owner: args.owner ?? 'cyanprint',
      name: args.name,
      ...(args.version ? { version: args.version } : {}),
      entry: 'index.ts',
      bundledEntry: 'index.ts',
    }),
    'utf8',
  );
  await writeFile(join(dir, 'index.ts'), args.runtime, 'utf8');
  return dir;
}

const emptyCyan = 'export default function cyan() { return {}; }\n';
const renderCyan = [
  'export default function cyan() {',
  "  return { processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }] };",
  '}',
  '',
].join('\n');

type TemplateSpec = {
  name: string;
  owner?: string;
  version?: string;
  kind?: 'template' | 'template-group';
  /** Directory name override (defaults to the template name). */
  dir?: string;
  /** Files under `template/` rendered through the `cyanprint/vars` processor by default. */
  files?: Record<string, string>;
  templates?: Record<
    string,
    { answers?: Record<string, unknown>; deterministicState?: Record<string, unknown> } | null
  >;
  processors?: string[];
  plugins?: string[];
  resolvers?: Array<{ ref: string; config?: Record<string, unknown>; files: string[] }>;
  cyanTs?: string;
};

async function writeTemplate(fixture: Fixture, spec: TemplateSpec): Promise<string> {
  const dir = join(fixture.templates, spec.dir ?? spec.name);
  await mkdir(dir, { recursive: true });
  const hasFiles = Boolean(spec.files && Object.keys(spec.files).length > 0);
  const processors = spec.processors ?? (hasFiles ? ['cyanprint/vars'] : []);
  const manifest: Record<string, unknown> = {
    cyanprint: 4,
    kind: spec.kind ?? 'template',
    owner: spec.owner ?? 'cyanprint',
    name: spec.name,
    bundledEntry: 'cyan.ts',
  };
  if (spec.version) {
    manifest.version = spec.version;
  }
  if (spec.templates) {
    manifest.templates = spec.templates;
  }
  if (processors.length > 0) {
    manifest.processors = processors;
  }
  if (spec.plugins?.length) {
    manifest.plugins = spec.plugins;
  }
  if (spec.resolvers?.length) {
    manifest.resolvers = spec.resolvers.map(entry => ({
      ref: entry.ref,
      config: entry.config ?? {},
      files: entry.files,
    }));
  }
  await writeFile(join(dir, 'cyan.yaml'), YAML.stringify(manifest), 'utf8');
  for (const [path, content] of Object.entries(spec.files ?? {})) {
    const target = join(dir, 'template', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await writeFile(join(dir, 'cyan.ts'), spec.cyanTs ?? (hasFiles ? renderCyan : emptyCyan), 'utf8');
  return dir;
}

async function writeVarsProcessor(fixture: Fixture): Promise<void> {
  await writeArtifact(fixture, { kind: 'processor', name: 'vars', runtime: varsProcessorRuntime });
}

async function readOut(out: string, path: string): Promise<string> {
  return await Bun.file(join(out, path)).text();
}

function lwwEntries(provenance: Array<{ decision: string }>): number {
  return provenance.filter(entry => entry.decision === 'lww-override').length;
}

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

describe('static composition guardrails', () => {
  test('cyan.ts returning templates is a hard error', async () => {
    const scriptDir = await mkdtemp(join(tmpdir(), 'cyanprint-script-dyn-'));
    try {
      const scriptPath = join(scriptDir, 'cyan.ts');
      await writeFile(scriptPath, 'export default function cyan() { return { templates: [] }; }\n');
      await expect(executeCyanScript(scriptPath, {}, {}, false)).rejects.toThrow(
        'templates cannot be returned from cyan.ts; declare them in cyan.yaml',
      );
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
    }
  });

  test('cyan.ts returning resolvers is a hard error', async () => {
    const scriptDir = await mkdtemp(join(tmpdir(), 'cyanprint-script-res-'));
    try {
      const scriptPath = join(scriptDir, 'cyan.ts');
      await writeFile(
        scriptPath,
        'export default function cyan() { return { resolvers: [{ name: "cyanprint/x" }] }; }\n',
      );
      await expect(executeCyanScript(scriptPath, {}, {}, false)).rejects.toThrow(
        'resolvers cannot be returned from cyan.ts',
      );
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
    }
  });

  test(
    'createProject rejects templates returned from cyan.ts end to end',
    async () => {
      const fixture = await makeFixture('dyn-create');
      try {
        await writeVarsProcessor(fixture);
        await writeTemplate(fixture, { name: 'child', files: { 'CHILD.md': '# Child\n' } });
        const parent = await writeTemplate(fixture, {
          name: 'parent',
          templates: { 'cyanprint/child': {} },
          cyanTs: [
            'export default function cyan() {',
            "  return { templates: [{ owner: 'cyanprint', name: 'child' }] };",
            '}',
            '',
          ].join('\n'),
        });
        await expect(createProject({ template: parent, outDir: fixture.out, headless: true })).rejects.toThrow(
          'templates cannot be returned from cyan.ts',
        );
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'rejects removed manifest fields (presets, api, commutative) with clear errors',
    async () => {
      const fixture = await makeFixture('removed-fields');
      try {
        const cases: Array<{ field: string; yaml: string; message: string }> = [
          {
            field: 'presets',
            yaml: 'presets:\n  templates:\n    cyanprint/child:\n      answers:\n        name: X\n',
            message: 'presets: has been removed',
          },
          { field: 'api', yaml: 'api: 1\n', message: 'api: has been removed' },
          { field: 'commutative', yaml: 'commutative: true\n', message: 'commutative: has been removed' },
        ];
        for (const testCase of cases) {
          const dir = join(fixture.templates, `removed-${testCase.field}`);
          await mkdir(dir, { recursive: true });
          await writeFile(
            join(dir, 'cyan.yaml'),
            [
              'cyanprint: 4',
              'kind: template',
              'owner: cyanprint',
              `name: removed-${testCase.field}`,
              'bundledEntry: cyan.ts',
              testCase.yaml,
            ].join('\n'),
            'utf8',
          );
          await writeFile(join(dir, 'cyan.ts'), emptyCyan, 'utf8');
          await expect(
            createProject({ template: dir, outDir: join(fixture.out, testCase.field), headless: true }),
          ).rejects.toThrow(testCase.message);
        }
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test('rejects the legacy list form of the templates section', async () => {
    const fixture = await makeFixture('templates-list');
    try {
      const dir = join(fixture.templates, 'legacy-list');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: legacy-list',
          'bundledEntry: cyan.ts',
          'templates:',
          '  - cyanprint/child',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(dir, 'cyan.ts'), emptyCyan, 'utf8');
      await expect(createProject({ template: dir, outDir: fixture.out, headless: true })).rejects.toThrow(
        'cyan.yaml is invalid',
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('create basics', () => {
  test(
    'headless create writes expected output and persisted state shape',
    async () => {
      const fixture = await makeFixture('create-basic');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, {
          name: 'hello',
          files: { 'README.md': '# __NAME__\n' },
          cyanTs: [
            'export default async function cyan(prompt) {',
            "  const name = await prompt.text('name', 'Project name');",
            "  return { processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }], config: { vars: { NAME: name } } }] };",
            '}',
            '',
          ].join('\n'),
        });
        const result = await createProject({
          template,
          outDir: fixture.out,
          answers: { name: 'Hello Lite' },
          headless: true,
        });
        expect(result.status).toBe('done');
        expect(result.conflicts).toEqual([]);
        expect(result.files.map(file => file.path)).toEqual(['README.md']);
        expect(await readOut(fixture.out, 'README.md')).toBe('# Hello Lite\n');

        const state = await loadGeneratedState(fixture.out);
        expect(state.cyanprint).toBe(4);
        expect(state.templates.length).toBe(1);
        const installed = state.templates[0];
        expect(installed?.owner).toBe('cyanprint');
        expect(installed?.name).toBe('hello');
        expect(installed?.version).toBe('local');
        expect(installed?.active).toBe(true);
        expect(installed?.source).toBe(resolve(template));
        expect(installed?.history.length).toBe(1);
        expect(installed?.history[0]?.answers).toEqual({ name: 'Hello Lite' });
        // files carry only path + sha256 — never content.
        expect(state.files).toEqual([{ path: 'README.md', sha256: sha256('# Hello Lite\n') }]);
        const readme = state.provenance.find(entry => entry.path === 'README.md');
        expect(readme?.decision).toBe('added');
        expect(readme?.source).toBe('cyanprint/hello@local');
        expect(readme?.segment).toBeUndefined();
        expect(readme?.contributors).toBeUndefined();
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'does not record pre-existing output files as generated state',
    async () => {
      const fixture = await makeFixture('create-existing-files');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, { name: 'keep', files: { 'README.md': '# Generated\n' } });
        await mkdir(fixture.out, { recursive: true });
        await writeFile(join(fixture.out, 'KEEP.md'), '# Keep\n', 'utf8');
        const result = await createProject({ template, outDir: fixture.out, headless: true });
        expect(result.files.map(file => file.path)).toEqual(['README.md']);
        expect(await readOut(fixture.out, 'KEEP.md')).toBe('# Keep\n');
        expect(await Bun.file(join(fixture.out, '.cyan_state.yaml')).text()).not.toContain('KEEP.md');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test('rejects returned artifacts not declared in cyan.yaml', async () => {
    const fixture = await makeFixture('undeclared');
    try {
      const template = await writeTemplate(fixture, {
        name: 'undeclared-artifact',
        processors: [],
        cyanTs: [
          'export default function cyan() {',
          "  return { processors: [{ owner: 'cyanprint', name: 'uppercase' }] };",
          '}',
          '',
        ].join('\n'),
      });
      await expect(createProject({ template, outDir: fixture.out, headless: true })).rejects.toThrow(
        'does not declare it',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects returned artifact versions not declared in cyan.yaml', async () => {
    const fixture = await makeFixture('undeclared-version');
    try {
      const template = await writeTemplate(fixture, {
        name: 'versioned-artifact',
        processors: ['cyanprint/uppercase@4'],
        cyanTs: [
          'export default function cyan() {',
          "  return { processors: [{ owner: 'cyanprint', name: 'uppercase', version: '5' }] };",
          '}',
          '',
        ].join('\n'),
      });
      await expect(createProject({ template, outDir: fixture.out, headless: true })).rejects.toThrow(
        'cyanprint:uppercase@5',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test(
    'normalizes unversioned returned artifacts to a single pinned manifest version',
    async () => {
      const fixture = await makeFixture('pinned-artifact');
      try {
        const templateDir = join(fixture.templates, 'pinned-artifact');
        await mkdir(join(templateDir, 'dist'), { recursive: true });
        const runtimeFile = join(templateDir, 'dist', 'identity-processor.js');
        await writeFile(runtimeFile, identityProcessorRuntime, 'utf8');
        await writeFile(
          join(templateDir, '.cyan_artifact_bundles.json'),
          JSON.stringify({
            bundles: [
              {
                key: 'processor:cyanprint:identity:4',
                dependency: { kind: 'processor', owner: 'cyanprint', name: 'identity', version: '4' },
                runtimeFile,
                integrity: sha256(identityProcessorRuntime),
              },
            ],
          }),
          'utf8',
        );
        await writeFile(
          join(templateDir, 'cyan.yaml'),
          YAML.stringify({
            cyanprint: 4,
            kind: 'template',
            owner: 'cyanprint',
            name: 'pinned-artifact',
            bundledEntry: 'cyan.ts',
            processors: ['cyanprint/identity@4'],
          }),
          'utf8',
        );
        await writeFile(
          join(templateDir, 'cyan.ts'),
          [
            'export default function cyan() {',
            "  return { processors: [{ owner: 'cyanprint', name: 'identity' }] };",
            '}',
            '',
          ].join('\n'),
          'utf8',
        );

        await createProject({ template: templateDir, outDir: fixture.out, headless: true, localFallback: false });

        const state = await loadGeneratedState(fixture.out);
        const processorArtifacts = (state.templates[0]?.artifacts ?? []).filter(entry => entry.kind === 'processor');
        expect(processorArtifacts).toEqual([
          {
            kind: 'processor',
            owner: 'cyanprint',
            name: 'identity',
            version: '4',
            integrity: sha256(identityProcessorRuntime),
          },
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'registry-hydrated templates resolve unversioned artifacts from pinned cache entries',
    async () => {
      const fixture = await makeFixture('cache-artifact');
      try {
        const templateDir = join(fixture.templates, 'cached-default');
        const runtimeDir = join(fixture.root, 'runtime');
        await mkdir(templateDir, { recursive: true });
        await mkdir(runtimeDir, { recursive: true });
        const runtime =
          'export async function processor(input) { await Bun.write(input.outputDir + "/README.md", "from-cache\\n"); }\n';
        await writeFile(join(runtimeDir, 'processor.js'), runtime, 'utf8');
        await writeFile(
          join(templateDir, 'cyan.yaml'),
          YAML.stringify({
            cyanprint: 4,
            kind: 'template',
            owner: 'cyanprint',
            name: 'cached-default',
            bundledEntry: 'cyan.ts',
            processors: ['cyan/default'],
          }),
          'utf8',
        );
        await writeFile(
          join(templateDir, 'cyan.ts'),
          "export default async () => ({ processors: [{ owner: 'cyan', name: 'default' }] });\n",
          'utf8',
        );
        await writeFile(
          join(templateDir, '.cyan_artifact_bundles.json'),
          JSON.stringify({
            bundles: [
              {
                key: 'processor:cyan:default:4',
                dependency: { kind: 'processor', owner: 'cyan', name: 'default', version: '4' },
                runtimeFile: join(runtimeDir, 'processor.js'),
                integrity: sha256(runtime),
              },
            ],
          }),
          'utf8',
        );

        await createProject({ template: templateDir, outDir: fixture.out, headless: true, localFallback: false });

        expect(await readOut(fixture.out, 'README.md')).toBe('from-cache\n');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'template scripts can use every prompt input type',
    async () => {
      const fixture = await makeFixture('all-inputs');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, {
          name: 'all-inputs',
          files: {
            'README.md': 'name=__NAME__ enabled=__ENABLED__ color=__COLOR__ features=__FEATURES__ count=__COUNT__\n',
          },
          cyanTs: [
            'export default async function cyan(prompt) {',
            "  const name = await prompt.text('name', 'Name');",
            "  const enabled = await prompt.confirm('enabled', 'Enabled?');",
            "  const color = await prompt.select('color', 'Color', { options: ['cyan', 'darkcyan'] });",
            "  const features = await prompt.multiselect('features', 'Features', { options: ['cli', 'web', 'worker'] });",
            "  const count = await prompt.number('count', 'Count');",
            '  return {',
            '    processors: [{',
            "      name: 'cyanprint/vars',",
            "      files: [{ root: 'template', glob: '**/*', type: 'Template' }],",
            "      config: { vars: { NAME: name, ENABLED: enabled, COLOR: color, FEATURES: features.join(','), COUNT: count } },",
            '    }],',
            '  };',
            '}',
            '',
          ].join('\n'),
        });
        await createProject({
          template,
          outDir: fixture.out,
          headless: true,
          answers: { name: 'Inputs', enabled: true, color: 'cyan', features: ['cli', 'worker'], count: 7 },
        });
        expect(await readOut(fixture.out, 'README.md')).toBe(
          'name=Inputs enabled=true color=cyan features=cli,worker count=7\n',
        );
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'prompt validation rejects out-of-range headless answers and accepts valid ones',
    async () => {
      const fixture = await makeFixture('validate');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, {
          name: 'validated',
          files: { 'OUT.md': 'count=__COUNT__\n' },
          cyanTs: [
            'export default async function cyan(prompt) {',
            "  const count = await prompt.number('count', 'Count', {",
            "    validate: value => (value >= 5 && value <= 10 ? true : 'count must be between 5 and 10'),",
            '  });',
            "  return { processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }], config: { vars: { COUNT: String(count) } } }] };",
            '}',
            '',
          ].join('\n'),
        });
        await expect(
          createProject({ template, outDir: fixture.out, headless: true, answers: { count: 3 } }),
        ).rejects.toThrow('count must be between 5 and 10');
        await createProject({ template, outDir: fixture.out, headless: true, answers: { count: 7 } });
        expect(await readOut(fixture.out, 'OUT.md')).toBe('count=7\n');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'interactively prompted answers from a custom adapter persist to generated state',
    async () => {
      const fixture = await makeFixture('adapter');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, {
          name: 'prompted',
          files: { 'OUT.md': 'name=__NAME__\n' },
          cyanTs: [
            'export default async function cyan(prompt) {',
            "  const name = await prompt.text('name', 'Name');",
            "  return { processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }], config: { vars: { NAME: name } } }] };",
            '}',
            '',
          ].join('\n'),
        });
        await createProject({
          template,
          outDir: fixture.out,
          headless: false,
          promptAdapter: {
            async ask<T>(): Promise<T> {
              return 'Prompted Project' as T;
            },
          },
        });
        expect(await readOut(fixture.out, 'OUT.md')).toBe('name=Prompted Project\n');
        const state = await loadGeneratedState(fixture.out);
        expect(state.templates[0]?.history[0]?.answers).toEqual({ name: 'Prompted Project' });
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'createProject reports generation progress for templates and artifacts',
    async () => {
      const fixture = await makeFixture('progress');
      const events: Array<{ kind: string; ref: string }> = [];
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, { name: 'progress', files: { 'README.md': '# P\n' } });
        await createProject({
          template,
          outDir: fixture.out,
          headless: true,
          onProgress: event => events.push({ kind: event.kind, ref: event.ref }),
        });
        expect(events.some(event => event.kind === 'template' && event.ref === 'cyanprint/progress')).toBe(true);
        expect(events.some(event => event.kind === 'processor' && event.ref === 'cyanprint/vars')).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'post-generation commands run inside the generated project directory',
    async () => {
      const fixture = await makeFixture('command-cwd');
      try {
        const template = await writeTemplate(fixture, {
          name: 'command-cwd',
          cyanTs: [
            'export default async () => ({',
            '  commands: [{',
            "    command: 'bun',",
            '    args: ["--eval", "await Bun.write(\\"post-command-cwd.txt\\", process.cwd())"],',
            '    allow: true,',
            '  }],',
            '});',
            '',
          ].join('\n'),
        });
        await createProject({ template, outDir: fixture.out, headless: true });
        expect(await realpath(await readOut(fixture.out, 'post-command-cwd.txt'))).toBe(await realpath(fixture.out));
        expect(await Bun.file(join(fixture.out, '.cyan_state.yaml')).text()).toContain('post-command-cwd.txt');
        // The command-created file is attributed to the template whose command ran.
        const state = await loadGeneratedState(fixture.out);
        const entry = state.provenance.find(item => item.path === 'post-command-cwd.txt');
        expect(entry?.source).toBe('cyanprint/command-cwd@local');
        expect(await Bun.file(join(root, 'post-command-cwd.txt')).exists()).toBe(false);
      } finally {
        await fixture.cleanup();
        await rm(join(root, 'post-command-cwd.txt'), { force: true });
      }
    },
    LONG,
  );

  test(
    'loads template folders with copy/template modes through one scoped processor',
    async () => {
      const fixture = await makeFixture('folder-modes');
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
      try {
        await writeVarsProcessor(fixture);
        const templateDir = join(fixture.templates, 'folder-template');
        await mkdir(join(templateDir, 'template-text/docs'), { recursive: true });
        await mkdir(join(templateDir, 'template-copy/assets'), { recursive: true });
        await writeFile(
          join(templateDir, 'cyan.yaml'),
          YAML.stringify({
            cyanprint: 4,
            kind: 'template',
            owner: 'cyanprint',
            name: 'folder-template',
            bundledEntry: 'cyan.ts',
            processors: ['cyanprint/vars'],
          }),
          'utf8',
        );
        await writeFile(join(templateDir, 'template-text/docs/README.md'), '# __NAME__\n', 'utf8');
        await writeFile(join(templateDir, 'template-copy/assets/pixel.bin'), bytes);
        await writeFile(
          join(templateDir, 'cyan.ts'),
          [
            'export default async function cyan(prompt) {',
            "  const name = await prompt.text('name', 'Project name');",
            '  return {',
            '    processors: [{',
            "      name: 'cyanprint/vars',",
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

        await createProject({
          template: templateDir,
          outDir: fixture.out,
          answers: { name: 'Folder App' },
          headless: true,
        });

        expect(await readOut(fixture.out, 'docs/README.md')).toBe('# Folder App\n');
        expect(new Uint8Array(await Bun.file(join(fixture.out, 'assets/pixel.bin')).arrayBuffer())).toEqual(bytes);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );
});

describe('composition via the templates dictionary', () => {
  test(
    'embedded answers and deterministicState reach the child and bubble into persisted state',
    async () => {
      const fixture = await makeFixture('embedded-config');
      try {
        await writeVarsProcessor(fixture);
        await writeTemplate(fixture, {
          name: 'child',
          files: { 'CHILD.md': 'name=__CHILD_NAME__ seed=__SEED__\n' },
          cyanTs: [
            'export default async function cyan(prompt, ctx) {',
            "  const childName = await prompt.text('childName', 'Child name');",
            "  const seed = ctx.deterministic.get('seed');",
            "  return { processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }], config: { vars: { CHILD_NAME: childName, SEED: seed } } }] };",
            '}',
            '',
          ].join('\n'),
        });
        const parent = await writeTemplate(fixture, {
          name: 'parent',
          files: { 'PARENT.md': '# Parent\n' },
          templates: {
            'cyanprint/child': {
              answers: { childName: 'Nested Answer' },
              deterministicState: { seed: 'A_SEED' },
            },
          },
        });

        await createProject({ template: parent, outDir: fixture.out, headless: true });

        expect(await readOut(fixture.out, 'CHILD.md')).toBe('name=Nested Answer seed=A_SEED\n');
        expect(await readOut(fixture.out, 'PARENT.md')).toBe('# Parent\n');
        const state = await loadGeneratedState(fixture.out);
        const history = state.templates[0]?.history[0];
        // Child answers bubble up into the root's persisted answer bag for updates.
        expect(history?.answers.childName).toBe('Nested Answer');
        expect(history?.deterministicState.seed).toBe('A_SEED');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'rejects a template included more than once in the composition',
    async () => {
      const fixture = await makeFixture('dup');
      try {
        await writeVarsProcessor(fixture);
        await writeTemplate(fixture, { name: 'dup', files: { 'DUP.md': '# dup\n' } });
        await writeTemplate(fixture, { name: 'x', templates: { 'cyanprint/dup': {} } });
        await writeTemplate(fixture, { name: 'y', templates: { 'cyanprint/dup': {} } });
        const group = await writeTemplate(fixture, {
          name: 'group',
          templates: { 'cyanprint/x': {}, 'cyanprint/y': {} },
        });
        await expect(createProject({ template: group, outDir: fixture.out, headless: true })).rejects.toThrow(
          'included more than once',
        );
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'allows two templates to share the same processor',
    async () => {
      const fixture = await makeFixture('shared-proc');
      try {
        await writeVarsProcessor(fixture);
        await writeTemplate(fixture, { name: 'p', files: { 'P.md': '# p\n' } });
        await writeTemplate(fixture, { name: 'q', files: { 'Q.md': '# q\n' } });
        const group = await writeTemplate(fixture, {
          name: 'grp',
          kind: 'template-group',
          templates: { 'cyanprint/p': {}, 'cyanprint/q': {} },
        });
        const result = await createProject({ template: group, outDir: fixture.out, headless: true });
        expect(result.files.map(file => file.path).sort()).toEqual(['P.md', 'Q.md']);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );
});

describe('tier 1 — processor outputs', () => {
  test(
    'conflicting processor outputs fall back to LWW by invocation with processor origins recorded',
    async () => {
      const fixture = await makeFixture('tier1-lww');
      try {
        await writeArtifact(fixture, { kind: 'processor', name: 'append', runtime: appendProcessorRuntime });
        const template = await writeTemplate(fixture, {
          name: 'tier1',
          files: { 'docs/note.md': 'start' },
          processors: ['cyanprint/append'],
          cyanTs: [
            'export default async function cyan() {',
            '  return {',
            '    processors: [',
            "      { name: 'cyanprint/append', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }], config: { suffix: 'A' } },",
            "      { name: 'cyanprint/append', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }], config: { suffix: 'B' } },",
            '    ],',
            '  };',
            '}',
            '',
          ].join('\n'),
        });

        await createProject({ template, outDir: fixture.out, headless: true });

        expect(await readOut(fixture.out, 'docs/note.md')).toBe('startB');
        const state = await loadGeneratedState(fixture.out);
        const decision = state.provenance.find(entry => entry.path === 'docs/note.md');
        expect(decision?.decision).toBe('lww-override');
        expect(decision?.segment).toBe('processor');
        expect(decision?.source).toBe('cyanprint/tier1@local');
        expect(decision?.contributors).toEqual([
          { template: 'cyanprint/tier1@local', layer: 0, processor: { ref: 'cyanprint/append', invocation: 0 } },
          { template: 'cyanprint/tier1@local', layer: 1, processor: { ref: 'cyanprint/append', invocation: 1 } },
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'conflicting processor outputs merge through the nominated resolver with processor origins',
    async () => {
      const fixture = await makeFixture('tier1-resolver');
      try {
        await writeArtifact(fixture, { kind: 'processor', name: 'append', runtime: appendProcessorRuntime });
        await writeArtifact(fixture, { kind: 'resolver', name: 'origins', runtime: originResolverRuntime });
        const template = await writeTemplate(fixture, {
          name: 'tier1r',
          files: { 'docs/note.md': 'start' },
          processors: ['cyanprint/append'],
          resolvers: [{ ref: 'cyanprint/origins', config: {}, files: ['docs/**'] }],
          cyanTs: [
            'export default async function cyan() {',
            '  return {',
            '    processors: [',
            "      { name: 'cyanprint/append', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }], config: { suffix: 'A' } },",
            "      { name: 'cyanprint/append', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }], config: { suffix: 'B' } },",
            '    ],',
            '  };',
            '}',
            '',
          ].join('\n'),
        });

        await createProject({ template, outDir: fixture.out, headless: true });

        // The resolver saw every variation, each carrying its processor ref + invocation.
        expect(await readOut(fixture.out, 'docs/note.md')).toBe(
          'cyanprint/tier1r@local:0:cyanprint/append#0\ncyanprint/tier1r@local:1:cyanprint/append#1\n',
        );
        const state = await loadGeneratedState(fixture.out);
        const decision = state.provenance.find(entry => entry.path === 'docs/note.md');
        expect(decision?.decision).toBe('resolver-merged');
        expect(decision?.segment).toBe('processor');
        expect(decision?.resolver).toBe('cyanprint/origins');
        expect(decision?.contributors?.map(origin => origin.processor?.invocation)).toEqual([0, 1]);
        expect(lwwEntries(state.provenance)).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'merges renamed scoped processor output beside independent processor output',
    async () => {
      const fixture = await makeFixture('tier1-rename');
      try {
        await writeArtifact(fixture, { kind: 'processor', name: 'append', runtime: appendProcessorRuntime });
        await writeArtifact(fixture, { kind: 'processor', name: 'rename', runtime: renameProcessorRuntime });
        const template = await writeTemplate(fixture, {
          name: 'rename-pipeline',
          files: { 'docs/note.md': 'start' },
          processors: ['cyanprint/rename', 'cyanprint/append'],
          cyanTs: [
            'export default async function cyan() {',
            '  return {',
            '    processors: [',
            "      { name: 'cyanprint/rename', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }] },",
            "      { name: 'cyanprint/append', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }], config: { suffix: 'A' } },",
            '    ],',
            '  };',
            '}',
            '',
          ].join('\n'),
        });

        await createProject({ template, outDir: fixture.out, headless: true });

        expect(await readOut(fixture.out, 'docs/note.md')).toBe('startA');
        expect(await readOut(fixture.out, 'docs/renamed.md')).toBe('startR');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'rejects scoped processor output outside its sandbox',
    async () => {
      const fixture = await makeFixture('tier1-escape');
      try {
        await writeArtifact(fixture, { kind: 'processor', name: 'escape', runtime: escapeProcessorRuntime });
        const template = await writeTemplate(fixture, {
          name: 'scope-escape',
          files: { 'docs/note.md': 'safe' },
          processors: ['cyanprint/escape'],
          cyanTs: [
            'export default async function cyan() {',
            "  return { processors: [{ name: 'cyanprint/escape', files: [{ root: 'template', glob: 'docs/**/*', type: 'Template' }] }] };",
            '}',
            '',
          ].join('\n'),
        });
        await expect(createProject({ template, outDir: fixture.out, headless: true })).rejects.toThrow(
          'unsafe output path',
        );
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'loads distinct scopes with the same output path as one overlaid invocation input',
    async () => {
      const fixture = await makeFixture('tier1-scopes');
      try {
        await writeArtifact(fixture, { kind: 'processor', name: 'identity', runtime: identityProcessorRuntime });
        const templateDir = join(fixture.templates, 'distinct-scopes');
        await mkdir(join(templateDir, 'template-a'), { recursive: true });
        await mkdir(join(templateDir, 'template-b'), { recursive: true });
        await writeFile(join(templateDir, 'template-a/README.md'), 'from a\n', 'utf8');
        await writeFile(join(templateDir, 'template-b/README.md'), 'from b\n', 'utf8');
        await writeFile(
          join(templateDir, 'cyan.yaml'),
          YAML.stringify({
            cyanprint: 4,
            kind: 'template',
            owner: 'cyanprint',
            name: 'distinct-scopes',
            bundledEntry: 'cyan.ts',
            processors: ['cyanprint/identity'],
          }),
          'utf8',
        );
        await writeFile(
          join(templateDir, 'cyan.ts'),
          [
            'export default async function cyan() {',
            '  return {',
            '    processors: [{',
            "      name: 'cyanprint/identity',",
            '      files: [',
            "        { root: 'template-a', glob: '**/*', type: 'Template' },",
            "        { root: 'template-b', glob: '**/*', type: 'Template' },",
            '      ],',
            '    }],',
            '  };',
            '}',
            '',
          ].join('\n'),
          'utf8',
        );

        await createProject({ template: templateDir, outDir: fixture.out, headless: true });

        expect(await readOut(fixture.out, 'README.md')).toBe('from b\n');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'plugins transform the resolved tier-1 layer and see their scoped extra files',
    async () => {
      const fixture = await makeFixture('plugin');
      try {
        await writeArtifact(fixture, { kind: 'processor', name: 'uppercase', runtime: uppercaseProcessorRuntime });
        await writeArtifact(fixture, { kind: 'plugin', name: 'footer', runtime: footerPluginRuntime });
        const template = await writeTemplate(fixture, {
          name: 'with-artifacts',
          files: { 'README.md': '# artifact project\n' },
          processors: ['cyanprint/uppercase'],
          plugins: ['cyanprint/footer'],
          cyanTs: [
            'export default async function cyan() {',
            '  return {',
            "    processors: [{ name: 'cyanprint/uppercase', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }],",
            "    plugins: [{ name: 'cyanprint/footer' }],",
            '  };',
            '}',
            '',
          ].join('\n'),
        });

        const result = await createProject({ template, outDir: fixture.out, headless: true });

        const readme = await readOut(fixture.out, 'README.md');
        expect(readme).toContain('# ARTIFACT PROJECT');
        expect(readme).toContain('Generated locally.');
        expect(
          result.artifactBundles
            .map(bundle => bundle.dependency)
            .filter(dependency => dependency.kind !== 'template')
            .map(dependency => `${dependency.kind}:${dependency.owner}/${dependency.name}`)
            .sort(),
        ).toEqual(['plugin:cyanprint/footer', 'processor:cyanprint/uppercase']);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'loads scoped plugin files into the plugin input alongside generated output',
    async () => {
      const fixture = await makeFixture('scoped-plugin');
      try {
        await writeArtifact(fixture, { kind: 'processor', name: 'identity', runtime: identityProcessorRuntime });
        const scopedPluginRuntime = [
          "import { mkdir } from 'node:fs/promises';",
          "import { dirname } from 'node:path';",
          'export async function plugin(input) {',
          "  const readme = await Bun.file(input.inputDir + '/README.md').text();",
          "  const asset = await Bun.file(input.inputDir + '/plugin-assets/message.txt').text();",
          "  await mkdir(dirname(input.outputDir + '/PLUGIN_OUTPUT.txt'), { recursive: true });",
          "  await Bun.write(input.outputDir + '/PLUGIN_OUTPUT.txt', readme.trim() + '\\n' + asset.trim() + '\\n');",
          '}',
          '',
        ].join('\n');
        await writeArtifact(fixture, { kind: 'plugin', name: 'scoped-plugin', runtime: scopedPluginRuntime });
        const templateDir = join(fixture.templates, 'scoped-plugin');
        await mkdir(join(templateDir, 'template/app'), { recursive: true });
        await mkdir(join(templateDir, 'template/plugin-assets'), { recursive: true });
        await writeFile(join(templateDir, 'template/app/README.md'), '# App\n', 'utf8');
        await writeFile(join(templateDir, 'template/plugin-assets/message.txt'), 'plugin asset\n', 'utf8');
        await writeFile(
          join(templateDir, 'cyan.yaml'),
          YAML.stringify({
            cyanprint: 4,
            kind: 'template',
            owner: 'cyanprint',
            name: 'scoped-plugin',
            bundledEntry: 'cyan.ts',
            processors: ['cyanprint/identity'],
            plugins: ['cyanprint/scoped-plugin'],
          }),
          'utf8',
        );
        await writeFile(
          join(templateDir, 'cyan.ts'),
          [
            'export default async function cyan() {',
            '  return {',
            "    processors: [{ name: 'cyanprint/identity', files: [{ root: 'template/app', glob: '**/*', type: 'Template' }] }],",
            "    plugins: [{ name: 'cyanprint/scoped-plugin', files: [{ root: 'template', glob: 'plugin-assets/**/*', type: 'Copy' }] }],",
            '  };',
            '}',
            '',
          ].join('\n'),
          'utf8',
        );

        await createProject({ template: templateDir, outDir: fixture.out, headless: true });

        expect(await readOut(fixture.out, 'README.md')).toBe('# App\n');
        expect(await readOut(fixture.out, 'plugin-assets/message.txt')).toBe('plugin asset\n');
        expect(await readOut(fixture.out, 'PLUGIN_OUTPUT.txt')).toBe('# App\nplugin asset\n');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );
});

type SamePathLayer = {
  name: string;
  content: string;
  resolver?: { ref: string; config?: Record<string, unknown> };
};

/**
 * Leaves that all emit `shared.txt` plus a sidecar `<NAME>.md`, grouped under one
 * template-group whose children follow the layer order.
 */
async function writeSamePathGroup(
  fixture: Fixture,
  layers: SamePathLayer[],
  group?: Partial<TemplateSpec> & { ownContent?: string },
): Promise<string> {
  await writeVarsProcessor(fixture);
  for (const layer of layers) {
    await writeTemplate(fixture, {
      name: layer.name,
      files: { 'shared.txt': layer.content, [`${layer.name.toUpperCase()}.md`]: `# ${layer.name}\n` },
      resolvers: layer.resolver
        ? [{ ref: layer.resolver.ref, config: layer.resolver.config ?? {}, files: ['shared.txt'] }]
        : undefined,
    });
  }
  return await writeTemplate(fixture, {
    name: 'grp',
    kind: 'template-group',
    templates: Object.fromEntries(layers.map(layer => [`cyanprint/${layer.name}`, {}])),
    files: group?.ownContent ? { 'shared.txt': group.ownContent } : undefined,
    resolvers: group?.resolvers,
    cyanTs: group?.cyanTs,
  });
}

describe('tier 2 — dependency tree', () => {
  test(
    'unanimous resolver nomination merges all variations in one call',
    async () => {
      const fixture = await makeFixture('tier2-consensus');
      try {
        await writeArtifact(fixture, { kind: 'resolver', name: 'concat', runtime: concatResolverRuntime });
        const group = await writeSamePathGroup(fixture, [
          { name: 'same-a', content: 'from a\n', resolver: { ref: 'cyanprint/concat' } },
          { name: 'same-b', content: 'from b\n', resolver: { ref: 'cyanprint/concat' } },
        ]);

        await createProject({ template: group, outDir: fixture.out, headless: true });

        expect(await readOut(fixture.out, 'shared.txt')).toBe('from a\nfrom b\n');
        const state = await loadGeneratedState(fixture.out);
        const decision = state.provenance.find(entry => entry.path === 'shared.txt');
        expect(decision?.decision).toBe('resolver-merged');
        expect(decision?.segment).toBe('dependency');
        expect(decision?.resolver).toBe('cyanprint/concat');
        expect(decision?.contributors).toEqual([
          { template: 'cyanprint/same-a@local', layer: 0 },
          { template: 'cyanprint/same-b@local', layer: 1 },
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'same resolver with different config is no consensus — LWW wins',
    async () => {
      const fixture = await makeFixture('tier2-config');
      try {
        await writeArtifact(fixture, { kind: 'resolver', name: 'concat', runtime: concatResolverRuntime });
        const group = await writeSamePathGroup(fixture, [
          { name: 'same-a', content: 'from a\n', resolver: { ref: 'cyanprint/concat', config: { mode: 'a' } } },
          { name: 'same-b', content: 'from b\n', resolver: { ref: 'cyanprint/concat', config: { mode: 'b' } } },
        ]);

        await createProject({ template: group, outDir: fixture.out, headless: true });

        expect(await readOut(fixture.out, 'shared.txt')).toBe('from b\n');
        const state = await loadGeneratedState(fixture.out);
        const decision = state.provenance.find(entry => entry.path === 'shared.txt');
        expect(decision?.decision).toBe('lww-override');
        expect(decision?.segment).toBe('dependency');
        expect(decision?.source).toBe('cyanprint/same-b@local');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'different resolver nominations are no consensus — LWW wins',
    async () => {
      const fixture = await makeFixture('tier2-mixed');
      try {
        await writeArtifact(fixture, { kind: 'resolver', name: 'concat', runtime: concatResolverRuntime });
        await writeArtifact(fixture, { kind: 'resolver', name: 'concat2', runtime: concatResolverRuntime });
        const group = await writeSamePathGroup(fixture, [
          { name: 'same-a', content: 'from a\n', resolver: { ref: 'cyanprint/concat' } },
          { name: 'same-b', content: 'from b\n', resolver: { ref: 'cyanprint/concat2' } },
        ]);

        await createProject({ template: group, outDir: fixture.out, headless: true });

        expect(await readOut(fixture.out, 'shared.txt')).toBe('from b\n');
        const state = await loadGeneratedState(fixture.out);
        expect(state.provenance.find(entry => entry.path === 'shared.txt')?.decision).toBe('lww-override');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'AllNone (no template nominates a resolver) falls back to LWW',
    async () => {
      const fixture = await makeFixture('tier2-none');
      try {
        const group = await writeSamePathGroup(fixture, [
          { name: 'same-a', content: 'from a\n' },
          { name: 'same-b', content: 'from b\n' },
        ]);

        await createProject({ template: group, outDir: fixture.out, headless: true });

        expect(await readOut(fixture.out, 'shared.txt')).toBe('from b\n');
        const state = await loadGeneratedState(fixture.out);
        const decision = state.provenance.find(entry => entry.path === 'shared.txt');
        expect(decision?.decision).toBe('lww-override');
        expect(decision?.segment).toBe('dependency');
        expect(decision?.contributors?.length).toBe(2);
        // Non-conflicting sibling files keep plain 'added' provenance.
        const added = state.provenance.find(entry => entry.path === 'SAME-A.md');
        expect(added?.decision).toBe('added');
        expect(added?.source).toBe('cyanprint/same-a@local');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    "the parent's own post-plugin layer is last, so self wins LWW over dependencies",
    async () => {
      const fixture = await makeFixture('tier2-self');
      try {
        const group = await writeSamePathGroup(
          fixture,
          [
            { name: 'same-a', content: 'from a\n' },
            { name: 'same-b', content: 'from b\n' },
          ],
          { ownContent: 'from group\n' },
        );

        await createProject({ template: group, outDir: fixture.out, headless: true });

        expect(await readOut(fixture.out, 'shared.txt')).toBe('from group\n');
        const state = await loadGeneratedState(fixture.out);
        const decision = state.provenance.find(entry => entry.path === 'shared.txt');
        expect(decision?.decision).toBe('lww-override');
        expect(decision?.source).toBe('cyanprint/grp@local');
        expect(decision?.contributors?.map(origin => origin.template)).toEqual([
          'cyanprint/same-a@local',
          'cyanprint/same-b@local',
          'cyanprint/grp@local',
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'the resolver receives every same-path variation with template origins in one call',
    async () => {
      const fixture = await makeFixture('tier2-origins');
      try {
        await writeArtifact(fixture, { kind: 'resolver', name: 'origins', runtime: originResolverRuntime });
        const group = await writeSamePathGroup(fixture, [
          { name: 'same-a', content: 'from a\n', resolver: { ref: 'cyanprint/origins' } },
          { name: 'same-b', content: 'from b\n', resolver: { ref: 'cyanprint/origins' } },
          { name: 'same-c', content: 'from c\n', resolver: { ref: 'cyanprint/origins' } },
        ]);

        await createProject({ template: group, outDir: fixture.out, headless: true });

        expect(await readOut(fixture.out, 'shared.txt')).toBe(
          'cyanprint/same-a@local:0\ncyanprint/same-b@local:1\ncyanprint/same-c@local:2\n',
        );
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );
});

describe('tier 3 — multi-install (create upserts into an existing project)', () => {
  test(
    'sibling templates layer by installedAt with LWW, user edits survive the merge, and history upserts',
    async () => {
      const fixture = await makeFixture('tier3');
      try {
        await writeVarsProcessor(fixture);
        const first = await writeTemplate(fixture, {
          name: 'first',
          files: { 'shared.txt': 'from first\n', 'FIRST.md': '# first\n', 'USER.md': 'original\n' },
        });
        const second = await writeTemplate(fixture, {
          name: 'second',
          files: { 'shared.txt': 'from second\n', 'SECOND.md': '# second\n' },
        });

        await createProject({ template: first, outDir: fixture.out, headless: true });
        // A user edit to a file the sibling never touches must survive the upsert merge.
        await writeFile(join(fixture.out, 'USER.md'), 'edited by user\n', 'utf8');

        const result = await createProject({ template: second, outDir: fixture.out, headless: true });

        expect(result.status).toBe('done');
        expect(result.conflicts).toEqual([]);
        expect(await readOut(fixture.out, 'shared.txt')).toBe('from second\n');
        expect(await readOut(fixture.out, 'FIRST.md')).toBe('# first\n');
        expect(await readOut(fixture.out, 'SECOND.md')).toBe('# second\n');
        expect(await readOut(fixture.out, 'USER.md')).toBe('edited by user\n');

        const state = await loadGeneratedState(fixture.out);
        expect(state.templates.map(entry => entry.name).sort()).toEqual(['first', 'second']);
        expect(state.templates.every(entry => entry.active)).toBe(true);
        const decision = state.provenance.find(entry => entry.path === 'shared.txt');
        expect(decision?.decision).toBe('lww-override');
        expect(decision?.segment).toBe('sibling');
        expect(decision?.source).toBe('cyanprint/second@local');
        expect(decision?.contributors?.map(origin => origin.template)).toEqual([
          'cyanprint/first@local',
          'cyanprint/second@local',
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'sibling conflicts merge through a unanimously nominated resolver',
    async () => {
      const fixture = await makeFixture('tier3-resolver');
      try {
        await writeVarsProcessor(fixture);
        await writeArtifact(fixture, { kind: 'resolver', name: 'concat', runtime: concatResolverRuntime });
        const first = await writeTemplate(fixture, {
          name: 'first',
          files: { 'shared.txt': 'from first\n' },
          resolvers: [{ ref: 'cyanprint/concat', config: {}, files: ['shared.txt'] }],
        });
        const second = await writeTemplate(fixture, {
          name: 'second',
          files: { 'shared.txt': 'from second\n' },
          resolvers: [{ ref: 'cyanprint/concat', config: {}, files: ['shared.txt'] }],
        });

        await createProject({ template: first, outDir: fixture.out, headless: true });
        const result = await createProject({ template: second, outDir: fixture.out, headless: true });

        expect(result.status).toBe('done');
        expect(await readOut(fixture.out, 'shared.txt')).toBe('from first\nfrom second\n');
        const state = await loadGeneratedState(fixture.out);
        const decision = state.provenance.find(entry => entry.path === 'shared.txt');
        expect(decision?.decision).toBe('resolver-merged');
        expect(decision?.segment).toBe('sibling');
        expect(decision?.resolver).toBe('cyanprint/concat');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    're-creating the same template upserts a new history entry and regenerates output',
    async () => {
      const fixture = await makeFixture('tier3-recreate');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, {
          name: 'recreate',
          files: { 'OUT.md': 'name=__NAME__\n' },
          cyanTs: [
            'export default async function cyan(prompt) {',
            "  const name = await prompt.text('name', 'Name');",
            "  return { processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }], config: { vars: { NAME: name } } }] };",
            '}',
            '',
          ].join('\n'),
        });

        await createProject({ template, outDir: fixture.out, headless: true, answers: { name: 'One' } });
        const result = await createProject({ template, outDir: fixture.out, headless: true, answers: { name: 'Two' } });

        expect(result.status).toBe('done');
        expect(await readOut(fixture.out, 'OUT.md')).toBe('name=Two\n');
        const state = await loadGeneratedState(fixture.out);
        expect(state.templates.length).toBe(1);
        expect(state.templates[0]?.history.length).toBe(2);
        expect(state.templates[0]?.history[0]?.answers).toEqual({ name: 'One' });
        expect(state.templates[0]?.history[1]?.answers).toEqual({ name: 'Two' });
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'a conflicted upsert leaves state untouched and skips post-generation commands',
    async () => {
      const fixture = await makeFixture('tier3-conflict');
      try {
        await writeVarsProcessor(fixture);
        const commandCyan = [
          'export default function cyan() {',
          '  return {',
          "    processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }],",
          "    commands: [{ command: 'touch', args: ['command-ran.txt'], allow: true }],",
          '  };',
          '}',
          '',
        ].join('\n');
        const v1 = await writeTemplate(fixture, {
          name: 'upsert-conflict',
          dir: 'upsert-conflict-old',
          files: { 'README.md': 'template old\n' },
        });
        const v2 = await writeTemplate(fixture, {
          name: 'upsert-conflict',
          dir: 'upsert-conflict-new',
          files: { 'README.md': 'template new\n' },
          cyanTs: commandCyan,
        });

        await createProject({ template: v1, outDir: fixture.out, headless: true });
        await writeFile(join(fixture.out, 'README.md'), 'user edit\n', 'utf8');
        const before = await loadGeneratedState(fixture.out);

        const result = await createProject({ template: v2, outDir: fixture.out, headless: true });

        expect(result.status).toBe('conflict');
        expect(result.conflicts).toEqual(['README.md']);
        expect(await readOut(fixture.out, 'README.md')).toContain('<<<<<<<');
        // Post-generation commands must not run over marker-bearing files, and state
        // must not record the incoming generation as accepted.
        expect(await exists(join(fixture.out, 'command-ran.txt'))).toBe(false);
        const after = await loadGeneratedState(fixture.out);
        expect(after.templates[0]?.history.length).toBe(before.templates[0]?.history.length ?? -1);
        expect(after.templates[0]?.source).toBe(before.templates[0]?.source ?? 'missing');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'a clean upsert runs post-generation commands and records their output in state',
    async () => {
      const fixture = await makeFixture('tier3-clean-command');
      try {
        await writeVarsProcessor(fixture);
        // v2 adds a post-generation command that writes a file not present in the template
        // tree; a clean upsert must run it AND record the file it creates in state.
        const commandCyan = [
          'export default function cyan() {',
          '  return {',
          "    processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }],",
          '    commands: [{ command: "bun", args: ["--eval", "await Bun.write(\\"generated-by-command.txt\\", \\"fromcommand\\")"], allow: true }],',
          '  };',
          '}',
          '',
        ].join('\n');
        const v1 = await writeTemplate(fixture, {
          name: 'upsert-clean',
          dir: 'upsert-clean-old',
          files: { 'README.md': 'shared\n' },
        });
        const v2 = await writeTemplate(fixture, {
          name: 'upsert-clean',
          dir: 'upsert-clean-new',
          files: { 'README.md': 'shared\n' },
          cyanTs: commandCyan,
        });

        await createProject({ template: v1, outDir: fixture.out, headless: true });
        const result = await createProject({ template: v2, outDir: fixture.out, headless: true });

        expect(result.status).toBe('done');
        // Command ran: its file is on disk...
        expect(await readOut(fixture.out, 'generated-by-command.txt')).toBe('fromcommand');
        // ...and — parity with a fresh create — it is recorded in state, not silently dropped.
        const state = await loadGeneratedState(fixture.out);
        expect(state.files.some(file => file.path === 'generated-by-command.txt')).toBe(true);
        // Provenance names the template whose command created the file, never 'unknown'.
        const commandEntry = state.provenance.find(entry => entry.path === 'generated-by-command.txt');
        expect(commandEntry?.source).toBe('cyanprint/upsert-clean@local');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );
});

describe('applyMergedTree', () => {
  test('applies deletions before writes so a merge can replace a file with a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-apply-merge-'));
    try {
      // ours has `foo` as a FILE on disk; the merge turns it into a directory.
      const ours = [{ path: 'foo', content: 'old\n' }];
      await writeFile(join(dir, 'foo'), 'old\n', 'utf8');
      const merge = await gitThreeWayMerge({
        base: ours,
        ours,
        theirs: [{ path: 'foo/bar.txt', content: 'new\n' }],
      });
      expect(merge.conflicts).toEqual([]);
      // Writing before deleting would mkdir `foo` while the old file exists → EEXIST.
      await applyMergedTree(dir, merge);
      expect(await Bun.file(join(dir, 'foo/bar.txt')).text()).toBe('new\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('prunes emptied directories so a merge can replace a directory with a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-apply-merge-'));
    try {
      // ours has `foo` as a DIRECTORY on disk; the merge turns it into a file.
      const ours = [{ path: 'foo/bar.txt', content: 'old\n' }];
      await mkdir(join(dir, 'foo'), { recursive: true });
      await writeFile(join(dir, 'foo/bar.txt'), 'old\n', 'utf8');
      const merge = await gitThreeWayMerge({
        base: ours,
        ours,
        theirs: [{ path: 'foo', content: 'flat\n' }],
      });
      expect(merge.conflicts).toEqual([]);
      // Deleting foo/bar.txt leaves an empty `foo/` dir; it must be pruned before the
      // file write, or writing `foo` fails with EISDIR.
      await applyMergedTree(dir, merge);
      expect(await Bun.file(join(dir, 'foo')).text()).toBe('flat\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('keeps sibling content when pruning emptied directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-apply-merge-'));
    try {
      const ours = [
        { path: 'pkg/removed.txt', content: 'bye\n' },
        { path: 'pkg/kept.txt', content: 'stay\n' },
      ];
      await mkdir(join(dir, 'pkg'), { recursive: true });
      await writeFile(join(dir, 'pkg/removed.txt'), 'bye\n', 'utf8');
      await writeFile(join(dir, 'pkg/kept.txt'), 'stay\n', 'utf8');
      const merge = await gitThreeWayMerge({
        base: ours,
        ours,
        theirs: [{ path: 'pkg/kept.txt', content: 'stay\n' }],
      });
      expect(merge.conflicts).toEqual([]);
      await applyMergedTree(dir, merge);
      expect(await exists(join(dir, 'pkg/removed.txt'))).toBe(false);
      expect(await Bun.file(join(dir, 'pkg/kept.txt')).text()).toBe('stay\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses to write through a directory symlink (no escape outside the project root)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-apply-merge-'));
    const outside = await mkdtemp(join(tmpdir(), 'cyanprint-outside-'));
    try {
      // User planted a directory symlink inside the project: `assets -> <outside>`.
      // readProjectFiles is symlink-blind, so a merge that adds `assets/config.txt` looks clean.
      await symlink(outside, join(dir, 'assets'));
      const merge = await gitThreeWayMerge({
        base: [],
        ours: [],
        theirs: [{ path: 'assets/config.txt', content: 'new\n' }],
      });
      expect(merge.conflicts).toEqual([]);
      // Without the guard this would follow the symlink and write <outside>/config.txt.
      await expect(applyMergedTree(dir, merge)).rejects.toThrow(/symlink/);
      expect(await exists(join(outside, 'config.txt'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('refuses to write through a file symlink (no escape outside the project root)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-apply-merge-'));
    const outside = await mkdtemp(join(tmpdir(), 'cyanprint-outside-'));
    try {
      // User replaced a generated file with a symlink to an outside target.
      await writeFile(join(outside, 'target.txt'), 'original\n', 'utf8');
      await symlink(join(outside, 'target.txt'), join(dir, 'foo.txt'));
      const merge = await gitThreeWayMerge({
        base: [],
        ours: [],
        theirs: [{ path: 'foo.txt', content: 'rewritten\n' }],
      });
      expect(merge.conflicts).toEqual([]);
      await expect(applyMergedTree(dir, merge)).rejects.toThrow(/symlink/);
      // The outside target is untouched — the write did not follow the link.
      expect(await Bun.file(join(outside, 'target.txt')).text()).toBe('original\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('refuses to delete through a directory symlink (no escape outside the project root)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-apply-merge-'));
    const outside = await mkdtemp(join(tmpdir(), 'cyanprint-outside-'));
    try {
      // User replaced a generated directory with a symlink: `assets -> <outside>`, where the
      // outside target holds real user data. A merge that deletes managed `assets/config.txt`
      // would, without a guard, follow the symlinked parent and unlink <outside>/config.txt.
      await writeFile(join(outside, 'config.txt'), 'outside\n', 'utf8');
      await symlink(outside, join(dir, 'assets'));
      await expect(
        applyMergedTree(dir, { files: [], deletions: ['assets/config.txt'], conflicts: [] }),
      ).rejects.toThrow(/symlink/);
      // The outside file survives — the delete did not follow the link.
      expect(await Bun.file(join(outside, 'config.txt')).text()).toBe('outside\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('refuses to write through a hard-linked managed file (no escape outside the project root)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-apply-merge-'));
    const outside = await mkdtemp(join(tmpdir(), 'cyanprint-outside-'));
    try {
      // User hard-linked an in-project path to an outside inode: `foo.txt` and
      // `<outside>/target.txt` share one inode. lstat sees a regular file (isSymbolicLink()
      // false), so the symlink guard alone would let the write truncate the shared inode.
      await writeFile(join(outside, 'target.txt'), 'original\n', 'utf8');
      await link(join(outside, 'target.txt'), join(dir, 'foo.txt'));
      const merge = await gitThreeWayMerge({
        base: [],
        ours: [],
        theirs: [{ path: 'foo.txt', content: 'rewritten\n' }],
      });
      expect(merge.conflicts).toEqual([]);
      await expect(applyMergedTree(dir, merge)).rejects.toThrow(/hard link/);
      // The shared inode is untouched — the write did not rewrite the outside file.
      expect(await Bun.file(join(outside, 'target.txt')).text()).toBe('original\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('refuses to write a binary file through a hard link (no escape outside the project root)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-apply-merge-'));
    const outside = await mkdtemp(join(tmpdir(), 'cyanprint-outside-'));
    try {
      await writeFile(join(outside, 'target.bin'), Buffer.from([0, 1, 2]));
      await link(join(outside, 'target.bin'), join(dir, 'logo.bin'));
      const merge = await gitThreeWayMerge({
        base: [],
        ours: [],
        theirs: [{ path: 'logo.bin', bytesBase64: Buffer.from([9, 9, 9]).toString('base64') }],
      });
      expect(merge.conflicts).toEqual([]);
      await expect(applyMergedTree(dir, merge)).rejects.toThrow(/hard link/);
      expect([...(await Bun.file(join(outside, 'target.bin')).bytes())]).toEqual([0, 1, 2]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('refuses to write through a special file / FIFO (no redirect into a pipe reader)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-apply-merge-'));
    try {
      // User planted a FIFO at a managed path. lstat sees neither a symlink nor a regular file,
      // so the symlink+hardlink guards alone would let `Bun.write`/`writeFile` open the pipe and
      // redirect generated bytes into a reader (data loss) or block forever with no reader.
      const fifo = join(dir, 'foo.txt');
      await mkfifo(fifo);
      // A reader keeps the (guard-removed) write from blocking, so the genuineness proof fails
      // cleanly instead of hanging; with the guard in place the reject happens before any open.
      const reader = Bun.spawn(['cat', fifo], { stdout: 'ignore', stderr: 'ignore' });
      try {
        const merge = await gitThreeWayMerge({
          base: [],
          ours: [],
          theirs: [{ path: 'foo.txt', content: 'rewritten\n' }],
        });
        expect(merge.conflicts).toEqual([]);
        await expect(applyMergedTree(dir, merge)).rejects.toThrow(/special file/);
        // The path is still a FIFO — the write did not open the pipe.
        expect((await lstat(fifo)).isFIFO()).toBe(true);
      } finally {
        reader.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('writeGeneratedState link safety', () => {
  const state = buildGeneratedState({ templates: [], files: [], provenance: [] });

  test('refuses to write .cyan_state.yaml through a symlink (no escape outside the project root)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-state-'));
    const outside = await mkdtemp(join(tmpdir(), 'cyanprint-outside-'));
    try {
      // User planted `.cyan_state.yaml -> <outside>/target.yaml`. writeText follows it, so
      // without the guard the state would be persisted outside the project root.
      await writeFile(join(outside, 'target.yaml'), 'original\n', 'utf8');
      await symlink(join(outside, 'target.yaml'), join(dir, '.cyan_state.yaml'));
      await expect(writeGeneratedState(dir, state)).rejects.toThrow(/symlink/);
      expect(await Bun.file(join(outside, 'target.yaml')).text()).toBe('original\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('refuses to write .cyan_state.yaml through a hard link (no escape outside the project root)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-state-'));
    const outside = await mkdtemp(join(tmpdir(), 'cyanprint-outside-'));
    try {
      await writeFile(join(outside, 'target.yaml'), 'original\n', 'utf8');
      await link(join(outside, 'target.yaml'), join(dir, '.cyan_state.yaml'));
      await expect(writeGeneratedState(dir, state)).rejects.toThrow(/hard link/);
      expect(await Bun.file(join(outside, 'target.yaml')).text()).toBe('original\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('refuses to write .cyan_state.yaml through a special file / FIFO (no redirect into a pipe reader)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-state-'));
    try {
      // User planted `.cyan_state.yaml` as a FIFO. `writeText`'s `writeFile` would open the pipe,
      // sending state YAML to a reader (silent data loss) or blocking forever with no reader.
      const fifo = join(dir, '.cyan_state.yaml');
      await mkfifo(fifo);
      const reader = Bun.spawn(['cat', fifo], { stdout: 'ignore', stderr: 'ignore' });
      try {
        await expect(writeGeneratedState(dir, state)).rejects.toThrow(/special file/);
        expect((await lstat(fifo)).isFIFO()).toBe(true);
      } finally {
        reader.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveLayers identical variations', () => {
  const failingInvoker = async (): Promise<string> => {
    throw new Error('resolver must not be invoked');
  };

  test('byte-identical multi-layer content passes through without a decision', async () => {
    const result = await resolveLayers({
      layers: [
        { template: 'cyanprint/a@1', files: [{ path: 'LICENSE', content: 'MIT\n' }], resolvers: [] },
        {
          template: 'cyanprint/b@1',
          files: [
            { path: 'LICENSE', content: 'MIT\n' },
            { path: 'b.txt', content: 'b\n' },
          ],
          resolvers: [],
        },
      ],
      segment: 'dependency',
      invokeResolver: failingInvoker,
    });

    // No lww-override for identical bytes — nothing can be lost, so strict template
    // tests must not demand an assertion for shared identical files.
    expect(result.decisions).toEqual([]);
    expect(result.files).toEqual([
      { path: 'LICENSE', content: 'MIT\n' },
      { path: 'b.txt', content: 'b\n' },
    ]);
  });

  test('identical binary variations pass through; differing content still records lww-override', async () => {
    const result = await resolveLayers({
      layers: [
        {
          template: 'cyanprint/a@1',
          files: [
            { path: 'logo.bin', bytesBase64: 'AAE=' },
            { path: 'shared.txt', content: 'from a\n' },
          ],
          resolvers: [],
        },
        {
          template: 'cyanprint/b@1',
          files: [
            { path: 'logo.bin', bytesBase64: 'AAE=' },
            { path: 'shared.txt', content: 'from b\n' },
          ],
          resolvers: [],
        },
      ],
      segment: 'sibling',
      invokeResolver: failingInvoker,
    });

    expect(result.decisions).toEqual([
      {
        path: 'shared.txt',
        source: 'cyanprint/b@1',
        decision: 'lww-override',
        segment: 'sibling',
        contributors: [
          { template: 'cyanprint/a@1', layer: 0 },
          { template: 'cyanprint/b@1', layer: 1 },
        ],
      },
    ]);
    expect(result.files.find(file => file.path === 'shared.txt')?.content).toBe('from b\n');
    expect(result.files.find(file => file.path === 'logo.bin')?.bytesBase64).toBe('AAE=');
  });
});

/** Two fixture dirs for one template ref: v1 (`version: '1'`) and v2 (`version: '2'`). */
async function writeVersionPair(
  fixture: Fixture,
  args: {
    name: string;
    v1Files: Record<string, string>;
    v2Files: Record<string, string>;
    v1CyanTs?: string;
    v2CyanTs?: string;
    processors?: string[];
  },
): Promise<{
  v1: string;
  v2: string;
  resolveTemplateSource: (source: { source: string; version?: string }) => Promise<string>;
  resolveUpdateTarget: () => Promise<{ templateDir: string; version: string }>;
}> {
  const v1 = await writeTemplate(fixture, {
    name: args.name,
    dir: `${args.name}-v1`,
    version: '1',
    files: args.v1Files,
    cyanTs: args.v1CyanTs,
    processors: args.processors,
  });
  const v2 = await writeTemplate(fixture, {
    name: args.name,
    dir: `${args.name}-v2`,
    version: '2',
    files: args.v2Files,
    cyanTs: args.v2CyanTs,
    processors: args.processors,
  });
  return {
    v1,
    v2,
    resolveTemplateSource: async ({ version }) => (version === '2' ? v2 : v1),
    resolveUpdateTarget: async () => ({ templateDir: v2, version: '2' }),
  };
}

describe('update', () => {
  test(
    'update floats to the resolved target, reuses answers, preserves user edits, and appends history',
    async () => {
      const fixture = await makeFixture('update-bump');
      try {
        await writeVarsProcessor(fixture);
        const promptedCyan = (extra: boolean): string =>
          [
            'export default async function cyan(prompt) {',
            "  const name = await prompt.text('name', 'Name');",
            ...(extra ? ["  const tagline = await prompt.text('tagline', 'Tagline', { default: 'none' });"] : []),
            "  return { processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }], config: { vars: { NAME: name" +
              (extra ? ', TAGLINE: tagline' : '') +
              ' } } }] };',
            '}',
            '',
          ].join('\n');
        const pair = await writeVersionPair(fixture, {
          name: 'upd',
          v1Files: { 'README.md': 'title=__NAME__\nbody v1\n', 'KEEP.md': 'keep\n' },
          v2Files: { 'README.md': 'title=__NAME__\nbody v2\ntag=__TAGLINE__\n', 'KEEP.md': 'keep\n' },
          v1CyanTs: promptedCyan(false),
          v2CyanTs: promptedCyan(true),
        });

        await createProject({
          template: pair.v1,
          outDir: fixture.out,
          headless: true,
          answers: { name: 'Update Project' },
        });
        await writeFile(join(fixture.out, 'KEEP.md'), 'keep\nuser line\n', 'utf8');

        const update = await updateProject({
          projectDir: fixture.out,
          answers: { tagline: 'Updated with pinned answers.' },
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });

        expect(update.status).toBe('done');
        expect(update.conflicts).toEqual([]);
        expect(update.updated).toEqual([{ ref: 'cyanprint/upd', from: '1', to: '2' }]);
        expect(update.reusedAnswers).toContain('name');
        expect(await readOut(fixture.out, 'README.md')).toBe(
          'title=Update Project\nbody v2\ntag=Updated with pinned answers.\n',
        );
        expect(await readOut(fixture.out, 'KEEP.md')).toBe('keep\nuser line\n');

        const state = await loadGeneratedState(fixture.out);
        expect(state.templates[0]?.version).toBe('2');
        expect(state.templates[0]?.history.length).toBe(2);
        expect(state.templates[0]?.history[0]?.version).toBe('1');
        expect(state.templates[0]?.history[1]?.version).toBe('2');
        expect(state.templates[0]?.history[1]?.answers).toEqual({
          name: 'Update Project',
          tagline: 'Updated with pinned answers.',
        });

        // Trust policy is unchanged by the update flow.
        expect(evaluateTrust({ trusted: true, version: '4', integrity: 'abc' }).scope).toBe('version');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'update of an unversioned local source is a no-op by design',
    async () => {
      const fixture = await makeFixture('update-local');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, { name: 'local-only', files: { 'README.md': 'local\n' } });
        await createProject({ template, outDir: fixture.out, headless: true });

        const update = await updateProject({ projectDir: fixture.out, headless: true });

        expect(update.status).toBe('done');
        expect(update.updated).toEqual([]);
        const state = await loadGeneratedState(fixture.out);
        expect(state.templates[0]?.history.length).toBe(1);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    '--template floats only the target and persists new state only for changed versions',
    async () => {
      const fixture = await makeFixture('update-targeted');
      try {
        await writeVarsProcessor(fixture);
        const pair = await writeVersionPair(fixture, {
          name: 'upd-a',
          v1Files: { 'A.md': 'a v1\n' },
          v2Files: { 'A.md': 'a v2\n' },
        });
        const other = await writeTemplate(fixture, {
          name: 'upd-b',
          version: '1',
          files: { 'B.md': 'b\n' },
        });

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        await createProject({ template: other, outDir: fixture.out, headless: true });

        const update = await updateProject({
          projectDir: fixture.out,
          template: 'cyanprint/upd-a',
          headless: true,
          resolveTemplateSource: async ({ source, version }) =>
            source === resolve(pair.v1) || source === resolve(pair.v2)
              ? await pair.resolveTemplateSource({ source, version })
              : other,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });

        expect(update.status).toBe('done');
        expect(update.updated).toEqual([{ ref: 'cyanprint/upd-a', from: '1', to: '2' }]);
        expect(await readOut(fixture.out, 'A.md')).toBe('a v2\n');
        expect(await readOut(fixture.out, 'B.md')).toBe('b\n');

        const state = await loadGeneratedState(fixture.out);
        const updatedEntry = state.templates.find(entry => entry.name === 'upd-a');
        const untouchedEntry = state.templates.find(entry => entry.name === 'upd-b');
        expect(updatedEntry?.version).toBe('2');
        expect(updatedEntry?.history.length).toBe(2);
        // Only templates whose version actually changed get a new history entry.
        expect(untouchedEntry?.version).toBe('1');
        expect(untouchedEntry?.history.length).toBe(1);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'both-changed lines stay in-file as standard git conflict markers',
    async () => {
      const fixture = await makeFixture('update-conflict');
      try {
        await writeVarsProcessor(fixture);
        const pair = await writeVersionPair(fixture, {
          name: 'conflicting',
          v1Files: { 'README.md': 'hello v1\n' },
          v2Files: { 'README.md': 'hello v2\n' },
        });

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        await writeFile(join(fixture.out, 'README.md'), 'hello user\n', 'utf8');

        const update = await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });

        expect(update.status).toBe('conflict');
        expect(update.conflicts).toEqual(['README.md']);
        const readme = await readOut(fixture.out, 'README.md');
        expect(readme).toContain('<<<<<<<');
        expect(readme).toContain('hello user');
        expect(readme).toContain('hello v2');
        expect(readme).toContain('>>>>>>>');

        // State must not advance while conflicts are pending: a retry has to merge from
        // the ORIGINAL base, not treat the half-accepted incoming tree as the baseline.
        const pending = await loadGeneratedState(fixture.out);
        expect(pending.templates[0]?.version).toBe('1');
        expect(pending.templates[0]?.history.length).toBe(1);

        // Resolve the conflict, retry: the update completes and only now state advances.
        await writeFile(join(fixture.out, 'README.md'), 'hello v2\n', 'utf8');
        const retry = await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });
        expect(retry.status).toBe('done');
        const state = await loadGeneratedState(fixture.out);
        expect(state.templates[0]?.version).toBe('2');
        expect(state.templates[0]?.history.length).toBe(2);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'update refreshes generated files matched by the generated .gitignore',
    async () => {
      const fixture = await makeFixture('update-gitignored');
      try {
        await writeVarsProcessor(fixture);
        const pair = await writeVersionPair(fixture, {
          name: 'ignored-gen',
          v1Files: { '.gitignore': 'generated.txt\n', 'generated.txt': 'gen v1\n' },
          v2Files: { '.gitignore': 'generated.txt\n', 'generated.txt': 'gen v2\n' },
        });

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        const update = await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });

        expect(update.status).toBe('done');
        // The file is matched by the generation's own .gitignore; the merge must still
        // carry the new content instead of silently keeping the stale on-disk copy.
        expect(await readOut(fixture.out, 'generated.txt')).toBe('gen v2\n');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'files the new version dropped are deleted from the project',
    async () => {
      const fixture = await makeFixture('update-delete');
      try {
        await writeVarsProcessor(fixture);
        const pair = await writeVersionPair(fixture, {
          name: 'dropping',
          v1Files: { 'README.md': 'same\n', 'OLD.md': 'old\n' },
          v2Files: { 'README.md': 'same\n' },
        });

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        const update = await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });

        expect(update.status).toBe('done');
        expect(await exists(join(fixture.out, 'OLD.md'))).toBe(false);
        expect(await readOut(fixture.out, 'README.md')).toBe('same\n');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'conflicted updates still apply clean changes to other files',
    async () => {
      const fixture = await makeFixture('update-partial');
      try {
        await writeVarsProcessor(fixture);
        const pair = await writeVersionPair(fixture, {
          name: 'partial',
          v1Files: { 'A.md': 'a1\n', 'B.md': 'b1\n' },
          v2Files: { 'A.md': 'a2\n', 'B.md': 'b2\n' },
        });

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        await writeFile(join(fixture.out, 'B.md'), 'user edit\n', 'utf8');

        const update = await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });

        expect(update.status).toBe('conflict');
        expect(update.conflicts).toEqual(['B.md']);
        expect(await readOut(fixture.out, 'A.md')).toBe('a2\n');
        expect(await readOut(fixture.out, 'B.md')).toContain('<<<<<<<');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'update reports a conflict when the user deleted a file the new version changed',
    async () => {
      const fixture = await makeFixture('update-user-deleted');
      try {
        await writeVarsProcessor(fixture);
        const pair = await writeVersionPair(fixture, {
          name: 'deleted',
          v1Files: { 'README.md': 'v1\n', 'STAY.md': 'stay\n' },
          v2Files: { 'README.md': 'v2\n', 'STAY.md': 'stay\n' },
        });

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        await rm(join(fixture.out, 'README.md'), { force: true });

        const update = await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });

        expect(update.status).toBe('conflict');
        expect(update.conflicts).toEqual(['README.md']);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'update reuses deterministic state from the previous install',
    async () => {
      const fixture = await makeFixture('update-deterministic');
      try {
        await writeVarsProcessor(fixture);
        const deterministicCyan = (fallback: string): string =>
          [
            'export default function cyan(prompt, ctx) {',
            `  const id = ctx.deterministic.get('id') ?? ${JSON.stringify(fallback)};`,
            "  ctx.deterministic.set('id', id);",
            "  return { processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }], config: { vars: { ID: id } } }] };",
            '}',
            '',
          ].join('\n');
        const pair = await writeVersionPair(fixture, {
          name: 'deterministic-update',
          v1Files: { 'README.md': '# __ID__\n' },
          v2Files: { 'README.md': '# __ID__\n' },
          v1CyanTs: deterministicCyan('stable-id'),
          v2CyanTs: deterministicCyan('changed-id'),
        });

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });

        expect(await readOut(fixture.out, 'README.md')).toBe('# stable-id\n');
        const state = await loadGeneratedState(fixture.out);
        expect(state.templates[0]?.history[1]?.deterministicState).toEqual({ id: 'stable-id' });
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'update preserves generated binary files when the target changes them',
    async () => {
      const fixture = await makeFixture('update-binary');
      try {
        await writeVarsProcessor(fixture);
        const copyCyan = [
          'export default async () => ({',
          "  processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Copy' }] }],",
          '});',
          '',
        ].join('\n');
        const pair = await writeVersionPair(fixture, {
          name: 'binary-update',
          v1Files: {},
          v2Files: {},
          v1CyanTs: copyCyan,
          v2CyanTs: copyCyan,
          processors: ['cyanprint/vars'],
        });
        // One top-level and one nested binary: the merge repo must create parent
        // directories for binary writes, exactly as it does for text files.
        await mkdir(join(pair.v1, 'template/assets/nested'), { recursive: true });
        await mkdir(join(pair.v2, 'template/assets/nested'), { recursive: true });
        await writeFile(join(pair.v1, 'template/asset.bin'), new Uint8Array([0, 1]));
        await writeFile(join(pair.v2, 'template/asset.bin'), new Uint8Array([254, 254]));
        await writeFile(join(pair.v1, 'template/assets/nested/icon.bin'), new Uint8Array([0, 2]));
        await writeFile(join(pair.v2, 'template/assets/nested/icon.bin'), new Uint8Array([253, 253]));

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        const update = await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });

        expect(update.status).toBe('done');
        expect(new Uint8Array(await Bun.file(join(fixture.out, 'asset.bin')).arrayBuffer())).toEqual(
          new Uint8Array([254, 254]),
        );
        expect(new Uint8Array(await Bun.file(join(fixture.out, 'assets/nested/icon.bin')).arrayBuffer())).toEqual(
          new Uint8Array([253, 253]),
        );
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'a clean update runs the changed template post-generation commands and records their output',
    async () => {
      const fixture = await makeFixture('update-command');
      try {
        await writeVarsProcessor(fixture);
        // v2 gains a post-generation command that stamps the resolved version into a file
        // outside the template tree. A clean update must run it and record the file.
        const commandCyan = (version: string): string =>
          [
            'export default function cyan() {',
            '  return {',
            "    processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }],",
            `    commands: [{ command: "bun", args: ["--eval", "await Bun.write(\\"command-stamp.txt\\", \\"v${version}\\")"], allow: true }],`,
            '  };',
            '}',
            '',
          ].join('\n');
        const pair = await writeVersionPair(fixture, {
          name: 'cmd-upd',
          v1Files: { 'README.md': 'body v1\n' },
          v2Files: { 'README.md': 'body v2\n' },
          v1CyanTs: commandCyan('1'),
          v2CyanTs: commandCyan('2'),
        });

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        expect(await readOut(fixture.out, 'command-stamp.txt')).toBe('v1');

        const update = await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });

        expect(update.status).toBe('done');
        // The changed template's command re-ran on update...
        expect(await readOut(fixture.out, 'command-stamp.txt')).toBe('v2');
        // ...and its output is recorded in state, so a later update treats it as
        // generated content rather than an untracked user file.
        const state = await loadGeneratedState(fixture.out);
        expect(state.templates[0]?.version).toBe('2');
        expect(state.files.some(file => file.path === 'command-stamp.txt')).toBe(true);
        // Provenance attributes the command's file to the template that ran it.
        const stampEntry = state.provenance.find(entry => entry.path === 'command-stamp.txt');
        expect(stampEntry?.source).toBe('cyanprint/cmd-upd@2');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );
});

describe('legacy state migration', () => {
  test('migrateGeneratedState lifts single-template state files in place', () => {
    const migrated = migrateGeneratedState({
      cyanprint: 4,
      template: { owner: 'cyanprint', name: 'legacy', version: '3', source: '/somewhere/legacy' },
      answers: { name: 'Legacy' },
      deterministicState: { seed: 's' },
      files: [{ path: 'README.md', sha256: 'abc', content: '# stale\n' }],
      artifacts: [],
    });
    expect(migrated.cyanprint).toBe(4);
    expect(migrated.templates.length).toBe(1);
    const entry = migrated.templates[0];
    expect(entry?.owner).toBe('cyanprint');
    expect(entry?.name).toBe('legacy');
    expect(entry?.version).toBe('3');
    expect(entry?.source).toBe('/somewhere/legacy');
    expect(entry?.active).toBe(true);
    expect(entry?.history.length).toBe(1);
    expect(entry?.history[0]?.answers).toEqual({ name: 'Legacy' });
    expect(entry?.history[0]?.deterministicState).toEqual({ seed: 's' });
    // Legacy embedded content is dropped: files carry only path + sha256.
    expect(migrated.files).toEqual([{ path: 'README.md', sha256: 'abc' }]);
    expect(migrated.provenance).toEqual([]);
  });

  test(
    'create into a legacy single-template project migrates state and upserts the new template',
    async () => {
      const fixture = await makeFixture('legacy-upsert');
      try {
        await writeVarsProcessor(fixture);
        const original = await writeTemplate(fixture, { name: 'legacy-app', files: { 'APP.md': '# app\n' } });
        const sibling = await writeTemplate(fixture, { name: 'legacy-addon', files: { 'ADDON.md': '# addon\n' } });

        await createProject({ template: original, outDir: fixture.out, headless: true });
        // Rewrite the state to the pre-multi-install single-template shape.
        await writeFile(
          join(fixture.out, '.cyan_state.yaml'),
          YAML.stringify({
            cyanprint: 4,
            template: { owner: 'cyanprint', name: 'legacy-app', version: 'local', source: resolve(original) },
            answers: {},
            deterministicState: {},
            files: [{ path: 'APP.md', sha256: sha256('# app\n') }],
            artifacts: [],
          }),
          'utf8',
        );

        const result = await createProject({ template: sibling, outDir: fixture.out, headless: true });

        expect(result.status).toBe('done');
        expect(await readOut(fixture.out, 'APP.md')).toBe('# app\n');
        expect(await readOut(fixture.out, 'ADDON.md')).toBe('# addon\n');
        const state = await loadGeneratedState(fixture.out);
        expect(state.templates.map(entry => entry.name).sort()).toEqual(['legacy-addon', 'legacy-app']);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );
});

describe('template tests (cyan.test.yaml)', () => {
  test(
    'strict merge assertions: unasserted LWW fails, asserted LWW passes with ignore + gitignore exclusion',
    async () => {
      const fixture = await makeFixture('template-test-strict');
      try {
        await writeVarsProcessor(fixture);
        await writeTemplate(fixture, {
          name: 'ta',
          files: { 'shared.txt': 'from a\n', 'A.md': '# a\n', '.gitignore': 'build/\n' },
        });
        await writeTemplate(fixture, {
          name: 'tb',
          files: { 'shared.txt': 'from b\n', 'B.md': '# b\n', 'debug.log': 'log\n', 'build/cache.txt': 'cache\n' },
        });
        const group = await writeTemplate(fixture, {
          name: 'grp',
          kind: 'template-group',
          templates: { 'cyanprint/ta': {}, 'cyanprint/tb': {} },
        });
        // The expected tree omits debug.log (ignore: glob) and build/ (output's own .gitignore).
        const expectedDir = join(group, 'expected');
        await mkdir(expectedDir, { recursive: true });
        await writeFile(join(expectedDir, 'shared.txt'), 'from b\n', 'utf8');
        await writeFile(join(expectedDir, 'A.md'), '# a\n', 'utf8');
        await writeFile(join(expectedDir, 'B.md'), '# b\n', 'utf8');
        await writeFile(join(expectedDir, '.gitignore'), 'build/\n', 'utf8');

        // 1. Strict by default: the tier-2 LWW on shared.txt is not asserted -> fail.
        await writeFile(
          join(group, 'cyan.test.yaml'),
          YAML.stringify({ cases: [{ name: 'strict', expected: 'expected' }] }),
          'utf8',
        );
        const strictReport = await runTemplateTest({ template: group, outDir: join(fixture.out, 'strict') });
        expect(strictReport).toMatchObject({ passed: 0, failed: 1 });
        expect(strictReport.cases[0]?.message).toContain('unasserted lww-override');

        // 2. Asserting the LWW (and excluding volatile files) passes byte-for-byte.
        await writeFile(
          join(group, 'cyan.test.yaml'),
          YAML.stringify({
            cases: [
              {
                name: 'asserted',
                expected: 'expected',
                ignore: ['*.log'],
                merges: [{ path: 'shared.txt', decision: 'lww', segment: 'dependency' }],
              },
            ],
          }),
          'utf8',
        );
        expect(await runTemplateTest({ template: group, outDir: join(fixture.out, 'asserted') })).toMatchObject({
          passed: 1,
          failed: 0,
        });

        // 3. A merges assertion that does not match the recorded decision fails.
        await writeFile(
          join(group, 'cyan.test.yaml'),
          YAML.stringify({
            cases: [
              {
                name: 'wrong',
                expected: 'expected',
                ignore: ['*.log'],
                merges: [{ path: 'shared.txt', decision: 'resolver', resolver: 'cyanprint/concat' }],
              },
            ],
          }),
          'utf8',
        );
        const wrongReport = await runTemplateTest({ template: group, outDir: join(fixture.out, 'wrong') });
        expect(wrongReport).toMatchObject({ passed: 0, failed: 1 });
        expect(wrongReport.cases[0]?.message).toContain('merges assertion not satisfied');

        // 4. The discouraged allowUnassertedLww escape hatch accepts the unasserted LWW.
        await writeFile(
          join(group, 'cyan.test.yaml'),
          YAML.stringify({
            cases: [{ name: 'escape', expected: 'expected', ignore: ['*.log'], allowUnassertedLww: true }],
          }),
          'utf8',
        );
        expect(await runTemplateTest({ template: group, outDir: join(fixture.out, 'escape') })).toMatchObject({
          passed: 1,
          failed: 0,
        });
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'merges assertions match resolver-merged decisions including the resolver ref',
    async () => {
      const fixture = await makeFixture('template-test-resolver');
      try {
        await writeArtifact(fixture, { kind: 'resolver', name: 'concat', runtime: concatResolverRuntime });
        const group = await writeSamePathGroup(fixture, [
          { name: 'same-a', content: 'from a\n', resolver: { ref: 'cyanprint/concat' } },
          { name: 'same-b', content: 'from b\n', resolver: { ref: 'cyanprint/concat' } },
        ]);
        const expectedDir = join(group, 'expected');
        await mkdir(expectedDir, { recursive: true });
        await writeFile(join(expectedDir, 'shared.txt'), 'from a\nfrom b\n', 'utf8');
        await writeFile(join(expectedDir, 'SAME-A.md'), '# same-a\n', 'utf8');
        await writeFile(join(expectedDir, 'SAME-B.md'), '# same-b\n', 'utf8');
        await writeFile(
          join(group, 'cyan.test.yaml'),
          YAML.stringify({
            cases: [
              {
                name: 'merged',
                expected: 'expected',
                merges: [
                  { path: 'shared.txt', decision: 'resolver', resolver: 'cyanprint/concat', segment: 'dependency' },
                ],
              },
            ],
          }),
          'utf8',
        );
        expect(await runTemplateTest({ template: group, outDir: fixture.out })).toMatchObject({ passed: 1, failed: 0 });
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'template tests accept inline answers and deterministic state',
    async () => {
      const fixture = await makeFixture('template-test-inline');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, {
          name: 'inline-state',
          files: { 'README.md': '# __NAME__-__SLUG__\n' },
          cyanTs: [
            'export default async function cyan(prompt, ctx) {',
            "  const name = await prompt.text('name', 'Project name');",
            "  const slug = ctx.deterministic.get('slug');",
            "  return { processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }], config: { vars: { NAME: name, SLUG: slug } } }] };",
            '}',
            '',
          ].join('\n'),
        });
        const expectedDir = join(template, 'expected');
        await mkdir(expectedDir, { recursive: true });
        await writeFile(join(expectedDir, 'README.md'), '# Inline-seeded\n', 'utf8');
        await writeFile(
          join(template, 'cyan.test.yaml'),
          YAML.stringify({
            cases: [
              {
                name: 'inline',
                answers: { name: 'Inline' },
                deterministicState: { slug: 'seeded' },
                expected: 'expected',
                validations: ["grep -q '# Inline-seeded' README.md"],
              },
            ],
          }),
          'utf8',
        );
        expect(await runTemplateTest({ template, outDir: fixture.out })).toMatchObject({ passed: 1, failed: 0 });
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'template tests pass with expected output and snapshot updates never persist state files',
    async () => {
      const fixture = await makeFixture('template-test-expected');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, {
          name: 'expected-only',
          files: { 'README.md': '# Template\n' },
        });
        const expectedDir = join(template, 'expected');
        await mkdir(expectedDir, { recursive: true });
        await writeFile(join(expectedDir, 'README.md'), '# Template\n', 'utf8');
        await writeFile(
          join(template, 'cyan.test.yaml'),
          YAML.stringify({ cases: [{ name: 'basic', expected: 'expected', validations: ['test -f README.md'] }] }),
          'utf8',
        );

        expect(await runTemplateTest({ template, outDir: fixture.out })).toMatchObject({ passed: 1, failed: 0 });
        const updateReport = await runTemplateTest({ template, outDir: fixture.out, updateSnapshots: true });
        expect(updateReport).toMatchObject({ passed: 1, failed: 0, snapshotUpdated: 1 });
        expect(await Bun.file(join(template, 'expected/.cyan_state.yaml')).exists()).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'template tests fail without cyan.test.yaml or a legacy snapshot',
    async () => {
      const fixture = await makeFixture('template-test-missing');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, { name: 'unasserted', files: { 'README.md': '# Template\n' } });
        const report = await runTemplateTest({ template, outDir: fixture.out });
        expect(report).toMatchObject({ passed: 0, failed: 1 });
        expect(report.cases[0]?.message).toContain('Template tests need cyan.test.yaml');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'template expected fixture update preserves empty expected output folders',
    async () => {
      const fixture = await makeFixture('template-test-empty');
      try {
        const template = await writeTemplate(fixture, { name: 'empty-output' });
        await mkdir(join(template, 'expected'), { recursive: true });
        await writeFile(
          join(template, 'cyan.test.yaml'),
          YAML.stringify({ cases: [{ name: 'basic', expected: 'expected' }] }),
          'utf8',
        );

        const updateReport = await runTemplateTest({ template, outDir: fixture.out, updateSnapshots: true });
        expect(updateReport).toMatchObject({ passed: 1, failed: 0, snapshotUpdated: 1 });
        expect(await exists(join(template, 'expected'))).toBe(true);
        expect(await runTemplateTest({ template, outDir: join(fixture.root, 'out-next') })).toMatchObject({
          passed: 1,
          failed: 0,
        });
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'template expected output compares and updates binary files byte for byte',
    async () => {
      const fixture = await makeFixture('template-test-binary');
      const binary = new Uint8Array([0, 1, 2, 253, 254, 255]);
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, {
          name: 'binary',
          cyanTs: [
            'export default function cyan() {',
            "  return { processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Copy' }] }] };",
            '}',
            '',
          ].join('\n'),
          processors: ['cyanprint/vars'],
        });
        await mkdir(join(template, 'template/assets'), { recursive: true });
        await writeFile(join(template, 'template/assets/pixel.bin'), binary);
        const expectedDir = join(template, 'expected/assets');
        await mkdir(expectedDir, { recursive: true });
        await writeFile(join(expectedDir, 'pixel.bin'), binary);
        await writeFile(
          join(template, 'cyan.test.yaml'),
          YAML.stringify({
            cases: [{ name: 'basic', expected: 'expected', validations: ['test -f assets/pixel.bin'] }],
          }),
          'utf8',
        );

        expect(await runTemplateTest({ template, outDir: fixture.out })).toMatchObject({ passed: 1, failed: 0 });
        await writeFile(join(expectedDir, 'pixel.bin'), new Uint8Array([0, 1, 2, 3]));
        expect(await runTemplateTest({ template, outDir: fixture.out })).toMatchObject({ passed: 0, failed: 1 });
        const updateReport = await runTemplateTest({ template, outDir: fixture.out, updateSnapshots: true });
        expect(updateReport).toMatchObject({ passed: 1, failed: 0, snapshotUpdated: 1 });
        expect(new Uint8Array(await Bun.file(join(expectedDir, 'pixel.bin')).arrayBuffer())).toEqual(binary);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'rejects removed commands and snapshot fields in template test manifests',
    async () => {
      const fixture = await makeFixture('template-test-removed');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, { name: 'removed-commands', files: { 'README.md': '# T\n' } });
        await writeFile(
          join(template, 'cyan.test.yaml'),
          YAML.stringify({ cases: [{ name: 'basic', expected: 'expected', commands: ['exit 0'] }] }),
          'utf8',
        );
        await expect(runTemplateTest({ template, outDir: fixture.out })).rejects.toThrow('commands');
        await writeFile(
          join(template, 'cyan.test.yaml'),
          YAML.stringify({ cases: [{ name: 'basic', expected: 'expected', snapshot: 'README.md' }] }),
          'utf8',
        );
        await expect(runTemplateTest({ template, outDir: fixture.out })).rejects.toThrow('snapshot');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'command validations run only after the expected output comparison, and never mutate snapshots on failure',
    async () => {
      const fixture = await makeFixture('template-test-validations');
      try {
        await writeVarsProcessor(fixture);
        const template = await writeTemplate(fixture, { name: 'failing-command', files: { 'README.md': '# New\n' } });
        const expectedDir = join(template, 'expected');
        await mkdir(expectedDir, { recursive: true });
        await writeFile(join(expectedDir, 'README.md'), '# New\n', 'utf8');
        await writeFile(
          join(template, 'cyan.test.yaml'),
          YAML.stringify({ cases: [{ name: 'basic', expected: 'expected', validations: ['exit 1'] }] }),
          'utf8',
        );

        const validationReport = await runTemplateTest({ template, outDir: join(fixture.out, 'validation') });
        expect(validationReport).toMatchObject({ passed: 0, failed: 1 });
        expect(validationReport.cases[0]?.message).toContain('Command failed');

        // A mismatch is reported before validations run.
        await writeFile(join(expectedDir, 'README.md'), '# Expected mismatch\n', 'utf8');
        const mismatchReport = await runTemplateTest({ template, outDir: join(fixture.out, 'mismatch') });
        expect(mismatchReport).toMatchObject({ passed: 0, failed: 1 });
        expect(mismatchReport.cases[0]?.message).toContain('Output mismatch');
        expect(mismatchReport.cases[0]?.message).not.toContain('Command failed');

        // updateSnapshots with failing validations must not rewrite the expected tree.
        await writeFile(join(expectedDir, 'README.md'), '# Old\n', 'utf8');
        const updateReport = await runTemplateTest({
          template,
          outDir: join(fixture.out, 'update'),
          updateSnapshots: true,
        });
        expect(updateReport).toMatchObject({ passed: 0, failed: 1, snapshotUpdated: 0 });
        expect(await Bun.file(join(expectedDir, 'README.md')).text()).toBe('# Old\n');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );
});

/** Standalone artifact dir for runArtifactTests: src entry compiled into a temp runtime. */
async function writeStandaloneArtifact(
  dir: string,
  args: { kind: 'processor' | 'plugin' | 'resolver'; name: string; runtime: string },
): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'cyan.yaml'),
    YAML.stringify({
      cyanprint: 4,
      kind: args.kind,
      owner: 'cyanprint',
      name: args.name,
      entry: 'src/index.ts',
      bundledEntry: 'dist/index.js',
    }),
    'utf8',
  );
  await writeFile(join(dir, 'src/index.ts'), args.runtime, 'utf8');
}

describe('artifact tests (runArtifactTests)', () => {
  test(
    'runs processor, plugin, and resolver fixtures via convention tests directories',
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-artifact-convention-'));
      try {
        const processorDir = join(tempRoot, 'processor');
        await writeStandaloneArtifact(processorDir, {
          kind: 'processor',
          name: 'uppercase',
          runtime: uppercaseProcessorRuntime,
        });
        await mkdir(join(processorDir, 'tests/basic/input'), { recursive: true });
        await mkdir(join(processorDir, 'tests/basic/expected'), { recursive: true });
        await writeFile(join(processorDir, 'tests/basic/input/README.md'), '# hi\n', 'utf8');
        await writeFile(join(processorDir, 'tests/basic/expected/README.md'), '# HI\n', 'utf8');
        expect(await runArtifactTests({ artifactDir: processorDir })).toMatchObject({
          kind: 'processor',
          passed: 1,
          failed: 0,
        });

        const pluginDir = join(tempRoot, 'plugin');
        await writeStandaloneArtifact(pluginDir, { kind: 'plugin', name: 'footer', runtime: footerPluginRuntime });
        await mkdir(join(pluginDir, 'tests/basic/input'), { recursive: true });
        await mkdir(join(pluginDir, 'tests/basic/expected'), { recursive: true });
        await writeFile(join(pluginDir, 'tests/basic/input/README.md'), '# In\n', 'utf8');
        await writeFile(join(pluginDir, 'tests/basic/expected/README.md'), '# In\nGenerated locally.\n', 'utf8');
        expect(await runArtifactTests({ artifactDir: pluginDir })).toMatchObject({
          kind: 'plugin',
          passed: 1,
          failed: 0,
        });

        const resolverDir = join(tempRoot, 'resolver');
        await writeStandaloneArtifact(resolverDir, {
          kind: 'resolver',
          name: 'concat',
          runtime: concatResolverRuntime,
        });
        await mkdir(join(resolverDir, 'tests/basic/input-0'), { recursive: true });
        await mkdir(join(resolverDir, 'tests/basic/input-1'), { recursive: true });
        await mkdir(join(resolverDir, 'tests/basic/expected'), { recursive: true });
        await writeFile(join(resolverDir, 'tests/basic/input-0/data.txt'), 'one\n', 'utf8');
        await writeFile(join(resolverDir, 'tests/basic/input-1/data.txt'), 'two\n', 'utf8');
        await writeFile(join(resolverDir, 'tests/basic/expected/data.txt'), 'one\ntwo\n', 'utf8');
        expect(await runArtifactTests({ artifactDir: resolverDir })).toMatchObject({
          kind: 'resolver',
          passed: 1,
          failed: 0,
        });
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
    LONG,
  );

  test(
    'resolver manifest cases use the global variations shape with origins (including processor origins)',
    async () => {
      const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-resolver-variations-'));
      try {
        await writeStandaloneArtifact(artifactDir, {
          kind: 'resolver',
          name: 'origins',
          runtime: originResolverRuntime,
        });
        await mkdir(join(artifactDir, 'inputs/a'), { recursive: true });
        await mkdir(join(artifactDir, 'inputs/b'), { recursive: true });
        await mkdir(join(artifactDir, 'expected'), { recursive: true });
        await writeFile(join(artifactDir, 'inputs/a/config.json'), '{"from":"a"}\n', 'utf8');
        await writeFile(join(artifactDir, 'inputs/b/config.json'), '{"from":"b"}\n', 'utf8');
        await writeFile(
          join(artifactDir, 'expected/config.json'),
          'cyanprint/tri-a@5:0\ncyanprint/tri-b@5:1:cyanprint/gen#0\n',
          'utf8',
        );
        await writeFile(
          join(artifactDir, 'cyan.test.yaml'),
          YAML.stringify({
            cases: [
              {
                name: 'variations',
                expected: 'expected',
                config: {},
                variations: [
                  { path: 'inputs/a', origin: { template: 'cyanprint/tri-a@5', layer: 0 } },
                  {
                    path: 'inputs/b',
                    origin: {
                      template: 'cyanprint/tri-b@5',
                      layer: 1,
                      processor: { ref: 'cyanprint/gen', invocation: 0 },
                    },
                  },
                ],
              },
            ],
          }),
          'utf8',
        );

        expect(await runArtifactTests({ artifactDir })).toMatchObject({ kind: 'resolver', passed: 1, failed: 0 });
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    },
    LONG,
  );

  test('rejects legacy resolver prior/current/target test fields', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-resolver-legacy-fields-'));
    try {
      await writeStandaloneArtifact(artifactDir, { kind: 'resolver', name: 'legacy', runtime: concatResolverRuntime });
      await writeFile(
        join(artifactDir, 'cyan.test.yaml'),
        YAML.stringify({
          cases: [{ name: 'basic', current: 'tests/basic/current.txt', expected: 'tests/basic/expected.txt' }],
        }),
        'utf8',
      );
      await expect(runArtifactTests({ artifactDir })).rejects.toThrow('no longer supported');
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  test('rejects removed commands and snapshot fields in artifact test manifests', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-artifact-removed-'));
    try {
      await writeStandaloneArtifact(artifactDir, {
        kind: 'processor',
        name: 'removed',
        runtime: identityProcessorRuntime,
      });
      await mkdir(join(artifactDir, 'tests/basic/input'), { recursive: true });
      await writeFile(join(artifactDir, 'tests/basic/input/README.md'), '# Input\n', 'utf8');
      await writeFile(
        join(artifactDir, 'cyan.test.yaml'),
        YAML.stringify({ cases: [{ name: 'basic', input: 'tests/basic/input', commands: ['exit 0'] }] }),
        'utf8',
      );
      await expect(runArtifactTests({ artifactDir })).rejects.toThrow('commands');
      await writeFile(
        join(artifactDir, 'cyan.test.yaml'),
        YAML.stringify({ cases: [{ name: 'basic', input: 'tests/basic/input', snapshot: 'x.md' }] }),
        'utf8',
      );
      await expect(runArtifactTests({ artifactDir })).rejects.toThrow('snapshot');
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  test(
    'rejects escaping processor output when updating artifact snapshots',
    async () => {
      const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-artifact-escape-'));
      try {
        await writeStandaloneArtifact(artifactDir, {
          kind: 'processor',
          name: 'escape',
          runtime:
            'export async function processor(input) { await Bun.write(input.outputDir + "/../escape.txt", "bad"); }\n',
        });
        await mkdir(join(artifactDir, 'tests/basic/input'), { recursive: true });
        await writeFile(join(artifactDir, 'tests/basic/input/README.md'), '# Input\n', 'utf8');
        const report = await runArtifactTests({ artifactDir, updateSnapshots: true });
        expect(report.failed).toBe(1);
        expect(await Bun.file(join(artifactDir, 'tests/basic/escape.txt')).exists()).toBe(false);
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    },
    LONG,
  );

  test(
    'validations run only after expected comparison and never mutate snapshots on failure',
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-test-artifact-validations-'));
      try {
        const processorDir = join(tempRoot, 'processor');
        await writeStandaloneArtifact(processorDir, {
          kind: 'processor',
          name: 'update-validation',
          runtime:
            'export async function processor(input) { await Bun.write(input.outputDir + "/README.md", "# New\\n"); }\n',
        });
        await mkdir(join(processorDir, 'tests/basic/input'), { recursive: true });
        await mkdir(join(processorDir, 'tests/basic/expected'), { recursive: true });
        await writeFile(join(processorDir, 'tests/basic/input/README.md'), '# Input\n', 'utf8');
        await writeFile(join(processorDir, 'tests/basic/expected/README.md'), '# New\n', 'utf8');
        await writeFile(
          join(processorDir, 'cyan.test.yaml'),
          YAML.stringify({
            cases: [
              { name: 'basic', input: 'tests/basic/input', expected: 'tests/basic/expected', validations: ['exit 1'] },
            ],
          }),
          'utf8',
        );

        const validationReport = await runArtifactTests({ artifactDir: processorDir });
        expect(validationReport).toMatchObject({ passed: 0, failed: 1 });
        expect(validationReport.cases[0]?.message).toContain('Command failed');

        await writeFile(join(processorDir, 'tests/basic/expected/README.md'), '# Mismatch\n', 'utf8');
        const mismatchReport = await runArtifactTests({ artifactDir: processorDir });
        expect(mismatchReport).toMatchObject({ passed: 0, failed: 1 });
        expect(mismatchReport.cases[0]?.message).toContain('Output mismatch');
        expect(mismatchReport.cases[0]?.message).not.toContain('Command failed');

        await writeFile(join(processorDir, 'tests/basic/expected/README.md'), '# Old\n', 'utf8');
        const updateReport = await runArtifactTests({ artifactDir: processorDir, updateSnapshots: true });
        expect(updateReport).toMatchObject({ passed: 0, failed: 1, snapshotUpdated: 0 });
        expect(await Bun.file(join(processorDir, 'tests/basic/expected/README.md')).text()).toBe('# Old\n');

        const resolverDir = join(tempRoot, 'resolver');
        await writeStandaloneArtifact(resolverDir, {
          kind: 'resolver',
          name: 'update-validation',
          runtime: concatResolverRuntime,
        });
        await mkdir(join(resolverDir, 'inputs/a'), { recursive: true });
        await mkdir(join(resolverDir, 'expected'), { recursive: true });
        await writeFile(join(resolverDir, 'inputs/a/data.txt'), 'new\n', 'utf8');
        await writeFile(join(resolverDir, 'expected/data.txt'), 'old\n', 'utf8');
        await writeFile(
          join(resolverDir, 'cyan.test.yaml'),
          YAML.stringify({
            cases: [
              {
                name: 'basic',
                expected: 'expected',
                variations: [{ path: 'inputs/a', origin: { template: 'a', layer: 0 } }],
                validations: ['exit 1'],
              },
            ],
          }),
          'utf8',
        );
        const resolverReport = await runArtifactTests({ artifactDir: resolverDir, updateSnapshots: true });
        expect(resolverReport).toMatchObject({ passed: 0, failed: 1, snapshotUpdated: 0 });
        expect(await Bun.file(join(resolverDir, 'expected/data.txt')).text()).toBe('old\n');
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
    LONG,
  );

  test(
    'runs legacy Ketone-style resolver fixtures (test.cyan.yaml) against the global resolver API',
    async () => {
      const artifactDir = await mkdtemp(join(tmpdir(), 'cyanprint-test-ketone-resolver-'));
      try {
        await mkdir(join(artifactDir, 'inputs/basic/template-a'), { recursive: true });
        await mkdir(join(artifactDir, 'snapshots/basic'), { recursive: true });
        await writeFile(
          join(artifactDir, 'cyan.yaml'),
          [
            'username: atomi',
            'name: legacy-json',
            'description: Legacy Ketone resolver fixture',
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
        await writeFile(
          join(artifactDir, 'index.ts'),
          [
            'export function resolver(input) {',
            '  const file = input.files[0];',
            "  if (!file) throw new Error('missing file');",
            '  const parsed = JSON.parse(file.content);',
            '  return { path: file.path, content: JSON.stringify({ b: parsed.b, a: parsed.a }) };',
            '}',
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
        await writeFile(join(artifactDir, 'inputs/basic/template-a/data.json'), '{\n  "a": 1,\n  "b": 2\n}\n', 'utf8');
        await writeFile(join(artifactDir, 'snapshots/basic/data.json'), '{"b":2,"a":1}', 'utf8');

        expect(await runArtifactTests({ artifactDir })).toMatchObject({ kind: 'resolver', passed: 1, failed: 0 });
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    },
    LONG,
  );
});

describe('processor output cache', () => {
  test(
    'identical hermetic inputs hit the cache; bypassCache skips reads but still writes',
    async () => {
      const fixture = await makeFixture('processor-cache');
      const cacheDir = join(fixture.root, 'cache');
      const counterFile = join(fixture.root, 'invocations.txt');
      try {
        await writeArtifact(fixture, {
          kind: 'processor',
          name: 'counter',
          runtime: counterProcessorRuntime(counterFile),
        });
        const template = await writeTemplate(fixture, {
          name: 'cached',
          processors: ['cyanprint/counter'],
          cyanTs: "export default async () => ({ processors: [{ name: 'cyanprint/counter' }] });\n",
        });
        const invocations = async (): Promise<number> =>
          (
            await Bun.file(counterFile)
              .text()
              .catch(() => '')
          ).length;

        await createProject({ template, outDir: join(fixture.out, 'one'), headless: true, cacheDir });
        expect(await invocations()).toBe(1);
        expect(await readOut(join(fixture.out, 'one'), 'GENERATED.md')).toBe('generated\n');

        // Identical (integrity, config, input file set) -> cache hit skips the invocation.
        await createProject({ template, outDir: join(fixture.out, 'two'), headless: true, cacheDir });
        expect(await invocations()).toBe(1);
        expect(await readOut(join(fixture.out, 'two'), 'GENERATED.md')).toBe('generated\n');

        // bypassCache skips the read (the processor runs again) but still writes the entry.
        await createProject({
          template,
          outDir: join(fixture.out, 'three'),
          headless: true,
          cacheDir,
          bypassCache: true,
        });
        expect(await invocations()).toBe(2);

        await createProject({ template, outDir: join(fixture.out, 'four'), headless: true, cacheDir });
        expect(await invocations()).toBe(2);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'changed processor config misses the cache',
    async () => {
      const fixture = await makeFixture('processor-cache-config');
      const cacheDir = join(fixture.root, 'cache');
      const counterFile = join(fixture.root, 'invocations.txt');
      try {
        await writeArtifact(fixture, {
          kind: 'processor',
          name: 'counter',
          runtime: counterProcessorRuntime(counterFile),
        });
        const configCyan = (flag: string): string =>
          `export default async () => ({ processors: [{ name: 'cyanprint/counter', config: { flag: ${JSON.stringify(flag)} } }] });\n`;
        // Two template dirs sharing one processor artifact: same integrity + input set,
        // different config — only the config differs in the cache key.
        const flagA = await writeTemplate(fixture, {
          name: 'cached-config-a',
          processors: ['cyanprint/counter'],
          cyanTs: configCyan('a'),
        });
        const flagB = await writeTemplate(fixture, {
          name: 'cached-config-b',
          processors: ['cyanprint/counter'],
          cyanTs: configCyan('b'),
        });
        const invocations = async (): Promise<number> =>
          (
            await Bun.file(counterFile)
              .text()
              .catch(() => '')
          ).length;

        await createProject({ template: flagA, outDir: join(fixture.out, 'one'), headless: true, cacheDir });
        expect(await invocations()).toBe(1);
        await createProject({ template: flagB, outDir: join(fixture.out, 'two'), headless: true, cacheDir });
        expect(await invocations()).toBe(2);
        // Identical config hits the cache again.
        await createProject({ template: flagA, outDir: join(fixture.out, 'three'), headless: true, cacheDir });
        expect(await invocations()).toBe(2);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );
});

describe('trace', () => {
  test(
    'traceProject returns the composition tree, engine provenance, and per-template diffs',
    async () => {
      const fixture = await makeFixture('trace');
      try {
        const group = await writeSamePathGroup(fixture, [
          { name: 'same-a', content: 'from a\n' },
          { name: 'same-b', content: 'from b\n' },
        ]);
        const trace = await traceProject({ template: group, headless: true });
        expect(trace.tree.ref).toBe('cyanprint/grp');
        expect(trace.tree.children.length).toBe(2);
        expect(trace.tree.children.every(child => child.ownFiles.length > 0)).toBe(true);
        expect(trace.provenance.length).toBeGreaterThan(0);
        expect(trace.provenance.every(entry => entry.source.includes('/'))).toBe(true);
        const conflict = trace.provenance.find(entry => entry.path === 'shared.txt');
        expect(conflict?.decision).toBe('lww-override');
        expect(conflict?.segment).toBe('dependency');
        // The losing child's own shared.txt differs from the final merged output.
        expect(trace.diffs.length).toBeGreaterThan(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'trace provenance attributes a grandchild file to the grandchild, not the merging parent',
    async () => {
      const fixture = await makeFixture('trace-deep');
      try {
        await writeVarsProcessor(fixture);
        await writeTemplate(fixture, { name: 'deep-c', files: { 'DEEP-C.md': '# deep-c\n' } });
        await writeTemplate(fixture, { name: 'deep-b', templates: { 'cyanprint/deep-c': {} } });
        const top = await writeTemplate(fixture, { name: 'deep-a', templates: { 'cyanprint/deep-b': {} } });
        const trace = await traceProject({ template: top, headless: true });
        const entry = trace.provenance.find(item => item.path === 'DEEP-C.md');
        expect(entry?.source).toBe('cyanprint/deep-c@local');
        expect(entry?.decision).toBe('added');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );
});

describe('unified diff', () => {
  test('unifiedDiff uses zero-based starts for zero-length hunk ranges', async () => {
    const { unifiedDiff } = await import('./util/unified-diff');
    expect(unifiedDiff('', 'a\nb')).toContain('@@ -0,0 +1,2 @@');
    expect(unifiedDiff('a\nb', '')).toContain('@@ -1,2 +0,0 @@');
  });
});

describe('probe surface', () => {
  test('cyan.ts can declare features and executeCyanScript surfaces them', async () => {
    const fixture = await makeFixture('feature-declaration');
    try {
      const template = await writeTemplate(fixture, {
        name: 'feature-decl',
        cyanTs: "export default function cyan() { return { features: ['tests', 'lint'] }; }\n",
      });
      const output = await executeCyanScript(join(template, 'cyan.ts'), {}, {});
      expect(output.features).toEqual(['tests', 'lint']);
    } finally {
      await fixture.cleanup();
    }
  });

  test(
    'generated repos never contain the template probe surface (probes/**, probes.yaml)',
    async () => {
      const fixture = await makeFixture('probe-exclusion');
      try {
        await writeVarsProcessor(fixture);
        // Worst-case leak vector: a root-level `**/*` scope that scans the template
        // root itself (probes/ and probes.yaml are siblings of cyan.ts) alongside the
        // conventional `template/` payload scope.
        const template = await writeTemplate(fixture, {
          name: 'probe-bearing',
          files: { 'README.md': '# Probe bearing\n' },
          cyanTs: [
            'export default function cyan() {',
            '  return {',
            "    features: ['tests'],",
            '    processors: [',
            '      {',
            "        name: 'cyanprint/vars',",
            "        files: [{ root: 'template', glob: '**/*', type: 'Copy' }, { glob: '**/*', type: 'Copy' }],",
            '      },',
            '    ],',
            '  };',
            '}',
            '',
          ].join('\n'),
        });
        await mkdir(join(template, 'probes'), { recursive: true });
        await writeFile(join(template, 'probes/tests.ts'), '// probe definition\n', 'utf8');
        await writeFile(join(template, 'probes.yaml'), 'contractVersion: 1\nfeatures: []\n', 'utf8');

        const result = await createProject({ template, outDir: fixture.out, headless: true });
        expect(result.status).toBe('done');
        const outputPaths = result.files.map(file => file.path);
        // The root scope really scanned the template root (cyan.ts rode along)…
        expect(outputPaths).toContain('cyan.ts');
        expect(outputPaths).toContain('README.md');
        // …but the probe surface never materializes.
        expect(outputPaths.filter(path => path === 'probes.yaml' || path.startsWith('probes/'))).toEqual([]);
        const onDisk = await Array.fromAsync(
          new Bun.Glob('**/*').scan({ cwd: fixture.out, onlyFiles: true, dot: true }),
        );
        expect(onDisk.filter(path => path === 'probes.yaml' || path.startsWith('probes/'))).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'generated repos never contain probe paths synthesized by a processor (output-path vector)',
    async () => {
      const fixture = await makeFixture('probe-exclusion-processor-output');
      try {
        // A processor that MINTS `probes/tests.ts` + `probes.yaml` as fresh output paths — they
        // never exist as template inputs, so the input-side scope filter cannot see them. Only the
        // generated-tree waist filter keeps them out of the repo (reviewer-0/reviewer-2 loop-4 finding).
        await writeArtifact(fixture, { kind: 'processor', name: 'probe-emit', runtime: probeEmittingProcessorRuntime });
        const template = await writeTemplate(fixture, {
          name: 'probe-emit-bearing',
          files: { 'README.md': '# Probe emit\n' },
          processors: ['cyanprint/probe-emit'],
          cyanTs: [
            'export default function cyan() {',
            '  return {',
            "    features: ['tests'],",
            '    processors: [',
            "      { name: 'cyanprint/probe-emit', files: [{ root: 'template', glob: '**/*', type: 'Template' }] },",
            '    ],',
            '  };',
            '}',
            '',
          ].join('\n'),
        });

        const result = await createProject({ template, outDir: fixture.out, headless: true });
        expect(result.status).toBe('done');
        const outputPaths = result.files.map(file => file.path);
        // The genuine payload rides along…
        expect(outputPaths).toContain('README.md');
        // …but the processor-synthesized probe surface never materializes in the result set…
        expect(outputPaths.filter(path => path === 'probes.yaml' || path.startsWith('probes/'))).toEqual([]);
        // …nor on disk.
        const onDisk = await Array.fromAsync(
          new Bun.Glob('**/*').scan({ cwd: fixture.out, onlyFiles: true, dot: true }),
        );
        expect(onDisk.filter(path => path === 'probes.yaml' || path.startsWith('probes/'))).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'generated repos never contain probe paths created by a post-generation command (fresh create)',
    async () => {
      const fixture = await makeFixture('probe-exclusion-command-output');
      try {
        // A post-generation command that writes `probes/tests.ts` + `probes.yaml` AFTER the
        // filtered generated tree landed on disk — the generateTemplateTree waist never sees
        // these paths, and the post-command snapshot would otherwise read them straight back
        // into files/state/provenance (reviewer-0/reviewer-2 loop-5 finding).
        const template = await writeTemplate(fixture, {
          name: 'probe-command-bearing',
          cyanTs: [
            'export default function cyan() {',
            '  return {',
            "    features: ['tests'],",
            '    commands: [{',
            "      command: 'bun',",
            '      args: ["--eval", "await Bun.write(\\"probes/tests.ts\\", \\"// leaked\\"); await Bun.write(\\"probes.yaml\\", \\"contractVersion: 1\\"); await Bun.write(\\"command-ran.txt\\", \\"ok\\")"],',
            '      allow: true,',
            '    }],',
            '  };',
            '}',
            '',
          ].join('\n'),
        });

        const result = await createProject({ template, outDir: fixture.out, headless: true });
        expect(result.status).toBe('done');
        // The command genuinely ran and its non-probe output is captured…
        expect(await readOut(fixture.out, 'command-ran.txt')).toBe('ok');
        const outputPaths = result.files.map(file => file.path);
        expect(outputPaths).toContain('command-ran.txt');
        // …but the command-created probe surface never lands in the result set…
        expect(outputPaths.filter(path => path === 'probes.yaml' || path.startsWith('probes/'))).toEqual([]);
        // …nor in the persisted state or provenance…
        const state = await loadGeneratedState(fixture.out);
        expect(state.files.filter(file => file.path === 'probes.yaml' || file.path.startsWith('probes/'))).toEqual([]);
        expect(
          state.provenance.filter(entry => entry.path === 'probes.yaml' || entry.path.startsWith('probes/')),
        ).toEqual([]);
        // …nor on disk.
        const onDisk = await Array.fromAsync(
          new Bun.Glob('**/*').scan({ cwd: fixture.out, onlyFiles: true, dot: true }),
        );
        expect(onDisk.filter(path => path === 'probes.yaml' || path.startsWith('probes/'))).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'update never persists command-created probe paths but preserves user-owned probe files',
    async () => {
      const fixture = await makeFixture('probe-exclusion-command-update');
      try {
        await writeVarsProcessor(fixture);
        // v2 gains a post-generation command that mints the probe surface — the update path
        // snapshots the post-command tree through readProjectFiles/readFinalProjectFiles,
        // which must exclude it (same loop-5 vector on the update/upsert flow).
        const commandCyan = [
          'export default function cyan() {',
          '  return {',
          "    processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }],",
          '    commands: [{',
          "      command: 'bun',",
          '      args: ["--eval", "await Bun.write(\\"probes/tests.ts\\", \\"// leaked\\"); await Bun.write(\\"probes.yaml\\", \\"contractVersion: 1\\"); await Bun.write(\\"command-ran.txt\\", \\"ok\\")"],',
          '      allow: true,',
          '    }],',
          '  };',
          '}',
          '',
        ].join('\n');
        const pair = await writeVersionPair(fixture, {
          name: 'probe-cmd-upd',
          v1Files: { 'README.md': 'body v1\n' },
          v2Files: { 'README.md': 'body v2\n' },
          v2CyanTs: commandCyan,
        });

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        // A user-owned probe file that predates the update: the engine never manages the
        // probe surface, so it must survive untouched — only command-CREATED paths are
        // scrubbed, never pre-existing user content.
        await mkdir(join(fixture.out, 'probes'), { recursive: true });
        await writeFile(join(fixture.out, 'probes/user-owned.ts'), '// user file\n', 'utf8');

        const update = await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });
        expect(update.status).toBe('done');
        // The command ran…
        expect(await readOut(fixture.out, 'command-ran.txt')).toBe('ok');
        // …its probe output never reaches state or provenance…
        const state = await loadGeneratedState(fixture.out);
        expect(state.files.filter(file => file.path === 'probes.yaml' || file.path.startsWith('probes/'))).toEqual([]);
        expect(
          state.provenance.filter(entry => entry.path === 'probes.yaml' || entry.path.startsWith('probes/')),
        ).toEqual([]);
        // …the command-created probe files are scrubbed from disk…
        expect(await exists(join(fixture.out, 'probes/tests.ts'))).toBe(false);
        expect(await exists(join(fixture.out, 'probes.yaml'))).toBe(false);
        // …while the user's pre-existing probe file survives.
        expect(await readOut(fixture.out, 'probes/user-owned.ts')).toBe('// user file\n');
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'generated repos never contain an empty probe directory a post-generation command created (fresh create)',
    async () => {
      const fixture = await makeFixture('probe-exclusion-command-empty-dir');
      try {
        // reviewer-0 loop-6 edge A: a command that creates `probes/` as EMPTY directories (no
        // regular files inside). A file-only scrub walk (`entry.isFile()`) never discovers them,
        // so they would survive on disk — and AC5 names `probes/` itself as excluded, so an empty
        // probe directory is a leak. The reconcile's directory-aware walk removes them.
        const template = await writeTemplate(fixture, {
          name: 'probe-empty-dir-command',
          cyanTs: [
            'export default function cyan() {',
            '  return {',
            "    features: ['tests'],",
            '    commands: [{',
            "      command: 'bun',",
            '      args: ["--eval", "await (await import(\\"node:fs/promises\\")).mkdir(\\"probes/nested\\", { recursive: true }); await Bun.write(\\"command-ran.txt\\", \\"ok\\")"],',
            '      allow: true,',
            '    }],',
            '  };',
            '}',
            '',
          ].join('\n'),
        });

        const result = await createProject({ template, outDir: fixture.out, headless: true });
        expect(result.status).toBe('done');
        // The command genuinely ran…
        expect(await readOut(fixture.out, 'command-ran.txt')).toBe('ok');
        // …but neither the empty `probes/` directory it created nor its nested child survives on disk.
        expect(await exists(join(fixture.out, 'probes'))).toBe(false);
        expect(await exists(join(fixture.out, 'probes/nested'))).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'update restores a user-owned probe file a post-generation command overwrote in place',
    async () => {
      const fixture = await makeFixture('probe-exclusion-command-overwrite');
      try {
        await writeVarsProcessor(fixture);
        // reviewer-2 loop-6 edge B: the old scrub snapshotted pre-existing probe PATHS and skipped
        // them, so a command that overwrites an existing `probes/user-owned.ts` in place changed its
        // bytes while the path stayed in the pre-existing set — the template-injected content
        // remained on disk. The reconcile snapshots CONTENT, so the user's original bytes are
        // restored and the injected content is undone.
        const commandCyan = [
          'export default function cyan() {',
          '  return {',
          "    processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }],",
          '    commands: [{',
          "      command: 'bun',",
          '      args: ["--eval", "await Bun.write(\\"probes/user-owned.ts\\", \\"// hijacked by template\\"); await Bun.write(\\"command-ran.txt\\", \\"ok\\")"],',
          '      allow: true,',
          '    }],',
          '  };',
          '}',
          '',
        ].join('\n');
        const pair = await writeVersionPair(fixture, {
          name: 'probe-cmd-overwrite',
          v1Files: { 'README.md': 'body v1\n' },
          v2Files: { 'README.md': 'body v2\n' },
          v2CyanTs: commandCyan,
        });

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        // A user-owned probe file that predates the update, with content the engine must preserve.
        await mkdir(join(fixture.out, 'probes'), { recursive: true });
        await writeFile(join(fixture.out, 'probes/user-owned.ts'), '// user file\n', 'utf8');

        const update = await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });
        expect(update.status).toBe('done');
        // The command ran and overwrote the file in place…
        expect(await readOut(fixture.out, 'command-ran.txt')).toBe('ok');
        // …but the reconcile restored the user's original bytes, not the template's injected content…
        expect(await readOut(fixture.out, 'probes/user-owned.ts')).toBe('// user file\n');
        // …and the probe path never reaches state or provenance.
        const state = await loadGeneratedState(fixture.out);
        expect(state.files.filter(file => file.path === 'probes.yaml' || file.path.startsWith('probes/'))).toEqual([]);
        expect(
          state.provenance.filter(entry => entry.path === 'probes.yaml' || entry.path.startsWith('probes/')),
        ).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test(
    'update restores a user-owned probe file a post-generation command replaced with a directory',
    async () => {
      const fixture = await makeFixture('probe-exclusion-command-file-to-dir');
      try {
        await writeVarsProcessor(fixture);
        // reviewer-2 loop-7 edge: the reconcile restores a command-deleted pre-existing probe file
        // via `writeVfsFile`, but if the command replaced that file with a DIRECTORY at the same
        // path, `Bun.write` throws `EISDIR` — the reconcile aborted and the user's original file
        // was lost. The fix removes any directory at the target path before restoring the bytes.
        const commandCyan = [
          'export default function cyan() {',
          '  return {',
          "    processors: [{ name: 'cyanprint/vars', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }],",
          '    commands: [{',
          "      command: 'bun',",
          '      args: ["--eval", "const fs = await import(\\"node:fs/promises\\"); await fs.rm(\\"probes/user-owned.ts\\", { recursive: true, force: true }); await fs.mkdir(\\"probes/user-owned.ts\\", { recursive: true }); await Bun.write(\\"probes/user-owned.ts/injected.ts\\", \\"// injected by template\\"); await Bun.write(\\"command-ran.txt\\", \\"ok\\")"],',
          '      allow: true,',
          '    }],',
          '  };',
          '}',
          '',
        ].join('\n');
        const pair = await writeVersionPair(fixture, {
          name: 'probe-cmd-file-to-dir',
          v1Files: { 'README.md': 'body v1\n' },
          v2Files: { 'README.md': 'body v2\n' },
          v2CyanTs: commandCyan,
        });

        await createProject({ template: pair.v1, outDir: fixture.out, headless: true });
        // A user-owned probe FILE that predates the update, which the command will clobber with a dir.
        await mkdir(join(fixture.out, 'probes'), { recursive: true });
        await writeFile(join(fixture.out, 'probes/user-owned.ts'), '// user file\n', 'utf8');

        const update = await updateProject({
          projectDir: fixture.out,
          headless: true,
          resolveTemplateSource: pair.resolveTemplateSource,
          resolveUpdateTarget: pair.resolveUpdateTarget,
        });
        expect(update.status).toBe('done');
        // The command ran and replaced the file with a directory…
        expect(await readOut(fixture.out, 'command-ran.txt')).toBe('ok');
        // …but the reconcile removed the directory and restored the user's original file bytes…
        expect(await readOut(fixture.out, 'probes/user-owned.ts')).toBe('// user file\n');
        // …with no injected directory child left behind…
        expect(await exists(join(fixture.out, 'probes/user-owned.ts/injected.ts'))).toBe(false);
        // …and the probe path never reaches state or provenance.
        const state = await loadGeneratedState(fixture.out);
        expect(state.files.filter(file => file.path === 'probes.yaml' || file.path.startsWith('probes/'))).toEqual([]);
        expect(
          state.provenance.filter(entry => entry.path === 'probes.yaml' || entry.path.startsWith('probes/')),
        ).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
    LONG,
  );

  test('globTemplateFiles excludes the probe surface for normalized `..` base aliases', async () => {
    const { globTemplateFiles } = await import('./scripts/load-cyan-script');
    const fixture = await makeFixture('probe-exclusion-normalized');
    try {
      const templateRoot = join(fixture.templates, 'probe-normalized');
      await mkdir(join(templateRoot, 'probes'), { recursive: true });
      await writeFile(join(templateRoot, 'cyan.ts'), '// cyan\n', 'utf8');
      await writeFile(join(templateRoot, 'probes/tests.ts'), '// probe definition\n', 'utf8');
      await writeFile(join(templateRoot, 'probes.yaml'), 'contractVersion: 1\nfeatures: []\n', 'utf8');

      // A base that resolves back to the template root via `..` must still see the probe surface
      // excluded — the check path is derived from the resolved scan root, not the textual base.
      const rootAlias = await globTemplateFiles(templateRoot, '**/*', { base: 'probes/..', mode: 'copy' });
      const rootAliasPaths = rootAlias.map(file => file.path);
      expect(rootAliasPaths).toContain('cyan.ts');
      expect(rootAliasPaths.filter(path => path === 'probes.yaml' || path.startsWith('probes/'))).toEqual([]);

      // A base that resolves *into* the probe directory via `..` yields nothing but probe files —
      // all of which must be excluded.
      const intoProbes = await globTemplateFiles(templateRoot, '**/*', { base: 'probes/../probes', mode: 'copy' });
      expect(intoProbes.map(file => file.path)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('globTemplateFiles excludes payload probe paths whose generated-repo output would be probes/**', async () => {
    const { globTemplateFiles } = await import('./scripts/load-cyan-script');
    const fixture = await makeFixture('probe-exclusion-payload');
    try {
      const templateRoot = join(fixture.templates, 'probe-payload');
      // Probe files live under a `template/` payload scope, NOT at the template root: a file at
      // `template/probes/tests.ts` scanned with `base: 'template'` has output path `probes/tests.ts`.
      // Its template-root-relative source path (`template/probes/tests.ts`) is NOT a probe path, so
      // only the output-path check keeps it out of the generated repo (reviewer-2's loop-3 finding).
      await mkdir(join(templateRoot, 'template/probes'), { recursive: true });
      await writeFile(join(templateRoot, 'template/README.md'), '# Payload\n', 'utf8');
      await writeFile(join(templateRoot, 'template/probes/tests.ts'), '// probe definition\n', 'utf8');
      await writeFile(join(templateRoot, 'template/probes.yaml'), 'contractVersion: 1\nfeatures: []\n', 'utf8');

      const payload = await globTemplateFiles(templateRoot, '**/*', { base: 'template', mode: 'copy' });
      const payloadPaths = payload.map(file => file.path);
      // The non-probe payload rides along…
      expect(payloadPaths).toContain('README.md');
      // …but nothing whose generated-repo output path is the probe surface survives.
      expect(payloadPaths.filter(path => path === 'probes.yaml' || path.startsWith('probes/'))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});
