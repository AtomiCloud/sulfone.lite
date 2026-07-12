import { describe, expect, test } from 'bun:test';
import { readTemplateTarFiles, validateTemplateTarPayload } from './archive';
import { parseCyanManifest } from './manifest';
import { artifactVersionId } from './registry';
import type { PromptAdapter } from './runtime';
import { makePromptContext } from './script';

describe('manifest and cyan script contracts', () => {
  test('manifest accepts author-time dependency declarations without versions', () => {
    const parsed = parseCyanManifest({
      cyanprint: 4,
      kind: 'template',
      name: 'demo',
      bundledEntry: 'cyan.ts',
      processors: ['cyanprint/uppercase'],
      legacy: { docker: { image: 'old' } },
    });
    // Declarations carry no kind — the processors: section implies it.
    expect(parsed.manifest.processors[0]).toMatchObject({ owner: 'cyanprint', name: 'uppercase' });
    expect(parsed.manifest.processors[0]?.version).toBeUndefined();
    expect(parsed.manifest.processors[0]).not.toHaveProperty('kind');
    expect(parsed.warnings[0]?.code).toBe('legacy_docker_ignored');
  });

  test('templates: is a dictionary with embedded per-dependency config', () => {
    const parsed = parseCyanManifest({
      cyanprint: 4,
      kind: 'template-group',
      name: 'group',
      bundledEntry: 'cyan.ts',
      templates: {
        'cyanprint/tri-a@5': {},
        'cyanprint/tri-b': {
          answers: { flavor: 'batteries' },
          deterministicState: { port: 4180 },
        },
        'cyanprint/tri-c': null,
      },
    });
    expect(parsed.manifest.templates).toEqual([
      { owner: 'cyanprint', name: 'tri-a', version: '5', answers: {}, deterministicState: {} },
      {
        owner: 'cyanprint',
        name: 'tri-b',
        version: undefined,
        answers: { flavor: 'batteries' },
        deterministicState: { port: 4180 },
      },
      { owner: 'cyanprint', name: 'tri-c', version: undefined, answers: {}, deterministicState: {} },
    ]);
  });

  test('resolvers: entries carry config and files globs', () => {
    const parsed = parseCyanManifest({
      cyanprint: 4,
      kind: 'template',
      name: 'demo',
      bundledEntry: 'cyan.ts',
      resolvers: [
        { ref: 'cyanprint/json-merge@2', config: { strategy: 'deep' }, files: ['package.json', '**/*.json'] },
      ],
    });
    expect(parsed.manifest.resolvers[0]).toEqual({
      owner: 'cyanprint',
      name: 'json-merge',
      version: '2',
      config: { strategy: 'deep' },
      files: ['package.json', '**/*.json'],
    });
  });

  test('probeOverrides: parses per-dependency per-feature override files', () => {
    const parsed = parseCyanManifest({
      cyanprint: 4,
      kind: 'template',
      name: 'consumer',
      bundledEntry: 'cyan.ts',
      templates: { 'cyanprint/gated': null },
      probeOverrides: { 'cyanprint/gated': { tests: 'probe-overrides/tests.ts' } },
    });
    expect(parsed.manifest.probeOverrides).toEqual([
      { owner: 'cyanprint', name: 'gated', version: undefined, feature: 'tests', file: 'probe-overrides/tests.ts' },
    ]);
  });

  test('probeOverrides: rejects an override naming a dependency absent from templates:', () => {
    expect(() =>
      parseCyanManifest({
        cyanprint: 4,
        kind: 'template',
        name: 'consumer',
        bundledEntry: 'cyan.ts',
        templates: { 'cyanprint/gated': null },
        probeOverrides: { 'cyanprint/undeclared': { tests: 'probe-overrides/tests.ts' } },
      }),
    ).toThrow(/undeclared/);
  });

  test('probeOverrides: rejects escaping override file paths', () => {
    expect(() =>
      parseCyanManifest({
        cyanprint: 4,
        kind: 'template',
        name: 'consumer',
        bundledEntry: 'cyan.ts',
        templates: { 'cyanprint/gated': null },
        probeOverrides: { 'cyanprint/gated': { tests: '../outside/tests.ts' } },
      }),
    ).toThrow('cyan.yaml is invalid');
  });

  test('probeOverrides: a version-qualified override requires an exact-matching versioned dependency', () => {
    // A versioned override (`@1`) demands an exact version match — a versionless
    // `templates:` declaration for the same owner/name does not satisfy it, since
    // `!override.version || dependency.version === override.version` requires equality
    // once the override names a version. (Dependency refs version as a plain integer,
    // per DependencyRefSchema — not semver.)
    expect(() =>
      parseCyanManifest({
        cyanprint: 4,
        kind: 'template',
        name: 'consumer',
        bundledEntry: 'cyan.ts',
        templates: { 'cyanprint/gated': null },
        probeOverrides: { 'cyanprint/gated@1': { tests: 'probe-overrides/tests.ts' } },
      }),
    ).toThrow(/does not declare it under templates/);

    // The same override against the exact matching versioned declaration is accepted.
    const parsed = parseCyanManifest({
      cyanprint: 4,
      kind: 'template',
      name: 'consumer',
      bundledEntry: 'cyan.ts',
      templates: { 'cyanprint/gated@1': null },
      probeOverrides: { 'cyanprint/gated@1': { tests: 'probe-overrides/tests.ts' } },
    });
    expect(parsed.manifest.probeOverrides).toEqual([
      { owner: 'cyanprint', name: 'gated', version: '1', feature: 'tests', file: 'probe-overrides/tests.ts' },
    ]);
  });

  test('manifest rejects removed fields: presets, api, commutative', () => {
    const base = { cyanprint: 4, kind: 'template', name: 'demo', bundledEntry: 'cyan.ts' };
    expect(() => parseCyanManifest({ ...base, presets: { templates: {} } })).toThrow('presets: has been removed');
    expect(() => parseCyanManifest({ ...base, kind: 'resolver', api: 2 })).toThrow('api: has been removed');
    expect(() => parseCyanManifest({ ...base, kind: 'resolver', commutative: true })).toThrow(
      'commutative: has been removed',
    );
  });

  test('manifest rejects generic object dependency declarations', () => {
    expect(() =>
      parseCyanManifest({
        cyanprint: 4,
        kind: 'template',
        name: 'demo',
        bundledEntry: 'cyan.ts',
        dependencies: [{ kind: 'processor', owner: 'cyanprint', name: 'uppercase' }],
      }),
    ).toThrow('cyan.yaml is invalid');
  });

  test('manifest rejects non-canonical dependency versions', () => {
    expect(() =>
      parseCyanManifest({
        cyanprint: 4,
        kind: 'template',
        name: 'demo',
        bundledEntry: 'cyan.ts',
        processors: ['cyanprint/uppercase@04'],
      }),
    ).toThrow('cyan.yaml is invalid');
  });
});

describe('deterministic state hermetic gateway', () => {
  const adapter: PromptAdapter = {
    ask: () => Promise.reject(new Error('prompts are not under test here')),
  };

  test('load computes once, pins the value, and never re-executes the producer on replay', async () => {
    const state: Record<string, unknown> = {};
    let calls = 0;
    const ctx = makePromptContext(adapter, {}, state);
    const first = await ctx.deterministic.load('port', () => {
      calls += 1;
      return 4180;
    });
    expect(first).toBe(4180);
    expect(state.port).toBe(4180);

    // Replay: a fresh context over the SAME persisted state — the producer must not run again.
    const replay = makePromptContext(adapter, {}, state);
    const second = await replay.deterministic.load('port', () => {
      calls += 1;
      return 9999;
    });
    expect(second).toBe(4180);
    expect(calls).toBe(1);
  });

  test('load supports async producers (external queries) and pins their result', async () => {
    const state: Record<string, unknown> = {};
    const ctx = makePromptContext(adapter, {}, state);
    const repos = await ctx.deterministic.load('repoList', async () => ['sulfone.lite', 'sulfone.iridium']);
    expect(repos).toEqual(['sulfone.lite', 'sulfone.iridium']);
    expect(state.repoList).toEqual(['sulfone.lite', 'sulfone.iridium']);
  });

  test('a pinned undefined value is replayed, not recomputed', async () => {
    const state: Record<string, unknown> = {};
    let calls = 0;
    const ctx = makePromptContext(adapter, {}, state);
    await ctx.deterministic.load('maybe', () => {
      calls += 1;
      return undefined;
    });
    const replayed = await ctx.deterministic.load('maybe', () => {
      calls += 1;
      return 'recomputed';
    });
    expect(replayed).toBeUndefined();
    expect(calls).toBe(1);
  });

  test('keys shadowing Object.prototype properties compute instead of returning inherited values', async () => {
    const state: Record<string, unknown> = {};
    const ctx = makePromptContext(adapter, {}, state);
    const value = await ctx.deterministic.load('toString', () => 'computed');
    expect(value).toBe('computed');
    expect(state.toString).toBe('computed');
  });

  test('a producer failure does not pin anything, so the next load retries', async () => {
    const state: Record<string, unknown> = {};
    const ctx = makePromptContext(adapter, {}, state);
    await expect(
      ctx.deterministic.load('flaky', () => {
        throw new Error('network down');
      }),
    ).rejects.toThrow('network down');
    expect('flaky' in state).toBe(false);
    const recovered = await ctx.deterministic.load('flaky', () => 'ok');
    expect(recovered).toBe('ok');
  });
});

describe('registry identity contracts', () => {
  test('artifact version ids are collision-free for escaped punctuation', () => {
    expect(artifactVersionId('template', 'cyanprint', 'a-b', '4')).not.toBe(
      artifactVersionId('template', 'cyanprint', 'a_b', '4'),
    );
  });
});

describe('template archive contracts', () => {
  test('reads regular tar files and rejects links', () => {
    const archive = makeTar([
      { path: 'template/README.md', type: '0', content: '# Hi\n' },
      { path: 'assets', type: '5' },
    ]);
    expect(readTemplateTarFiles(archive).map(file => [file.path, new TextDecoder().decode(file.bytes)])).toEqual([
      ['template/README.md', '# Hi\n'],
    ]);

    const symlinkArchive = makeTar([
      { path: 'link', type: '2', linkName: '..' },
      { path: 'link/pwn.txt', type: '0', content: 'bad' },
    ]);
    expect(validateTemplateTarPayload(symlinkArchive)).toContain('unsupported entry type');
  });
});

type TarEntry = {
  path: string;
  type: '0' | '2' | '5';
  content?: string;
  linkName?: string;
};

function makeTar(entries: TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const content = new TextEncoder().encode(entry.content ?? '');
    const header = new Uint8Array(512);
    writeTarString(header, 0, 100, entry.path);
    writeTarString(header, 100, 8, '0000644');
    writeTarString(header, 108, 8, '0000000');
    writeTarString(header, 116, 8, '0000000');
    writeTarString(
      header,
      124,
      12,
      entry.type === '0' ? content.byteLength.toString(8).padStart(11, '0') : '00000000000',
    );
    writeTarString(header, 136, 12, '00000000000');
    header.fill(32, 148, 156);
    header[156] = entry.type.charCodeAt(0);
    if (entry.linkName) {
      writeTarString(header, 157, 100, entry.linkName);
    }
    writeTarString(header, 257, 6, 'ustar');
    writeTarString(header, 263, 2, '00');
    const checksum = header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0');
    writeTarString(header, 148, 8, `${checksum}\0 `);
    chunks.push(header);
    if (entry.type === '0') {
      chunks.push(content);
      const padding = (512 - (content.byteLength % 512)) % 512;
      if (padding > 0) {
        chunks.push(new Uint8Array(padding));
      }
    }
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function writeTarString(header: Uint8Array, offset: number, length: number, value: string): void {
  header.set(new TextEncoder().encode(value).slice(0, length), offset);
}
