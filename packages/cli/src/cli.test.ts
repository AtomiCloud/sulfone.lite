import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@cyanprint/core';
import { artifactIntegrity } from '@cyanprint/contracts';
import type { PromptRequest } from '@cyanprint/contracts';
import { bundleCommand } from './commands/bundle';
import { createCommand } from './commands/create';
import { traceCommand } from './commands/trace';
import { pushCommand } from './commands/push';
import { tryCommand } from './commands/try';
import { updateCommand } from './commands/update';
import { inquirerPromptAdapter, type InquirerPrompts } from './inquirer-prompt-adapter';
import {
  createLocalObjectPayload,
  createTemplateArchivePayload,
  unpackLocalObjectPayload,
  unpackTemplateArchivePayload,
} from './local-object-package';
import { createProgram, main } from './main';
import { resolveTemplateInput } from './registry-template';

const textEncoder = new TextEncoder();

describe('commander cli shell', () => {
  test('help shows the polished command surface', () => {
    const output: string[] = [];
    const program = createProgram();
    program.configureOutput({
      writeOut: message => output.push(message),
      writeErr: message => output.push(message),
    });

    program.outputHelp();

    const help = output.join('');
    expect(help).toContain('cyanprint');
    expect(help).toContain('Fast Bun-native templates');
    expect(help).toContain('create');
    expect(help).toContain('search');
    expect(help).toContain('push');
    expect(help).toContain('Examples:');
  });

  test('search filters registry artifacts by kind and query', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalFetch = globalThis.fetch;
    try {
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      globalThis.fetch = (async input => {
        expect(String(input)).toBe('https://registry.cyanprint.dev/artifacts?kind=resolver&q=keep&limit=20');
        return new Response(
          JSON.stringify({
            artifacts: [
              {
                id: 'resolver:cyanprint:keep-user:4',
                kind: 'resolver',
                owner: 'cyanprint',
                name: 'keep-user',
                version: '4',
                readme: 'Preserve user edits.',
                dependencies: [],
                resolvedPins: [],
                downloads: 2,
                likes: 0,
                disabled: false,
                moderationState: 'active',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;

      await createProgram().parseAsync(['search', 'keep', '--kind', 'resolver', '--json'], { from: 'user' });

      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
        query: 'keep',
        kind: 'resolver',
        artifacts: [{ owner: 'cyanprint', name: 'keep-user', version: '4' }],
      });
    } finally {
      console.log = originalLog;
      globalThis.fetch = originalFetch;
    }
  });

  test('version subcommand preserves exact cyanprint output', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      await createProgram().parseAsync(['version'], { from: 'user' });

      expect(logs).toEqual(['cyanprint 4.0.0']);
    } finally {
      console.log = originalLog;
    }
  });

  test('create routes prompts through the commander prompt adapter', async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-commander-create-'));
    const out = join(tempRoot, 'project');
    const prompts: string[] = [];
    try {
      const program = createProgram({
        silent: true,
        promptAdapterFactory: answers => ({
          async ask<T>(request: PromptRequest) {
            prompts.push(request.name);
            answers[request.name] = 'Commander Project';
            return 'Commander Project' as T;
          },
        }),
      });

      await program.parseAsync(['create', join(root, 'examples/templates/hello'), '--out', out], {
        from: 'user',
      });

      expect(prompts).toEqual(['name']);
      expect(await Bun.file(join(out, 'README.md')).text()).toContain('Commander Project');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('create accepts positional output and lets --out override it', async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-commander-positional-out-'));
    const positionalOut = join(tempRoot, 'positional');
    const flagOut = join(tempRoot, 'flag');
    const originalLog = console.log;
    try {
      console.log = () => {};
      await createProgram().parseAsync(
        [
          'create',
          join(root, 'examples/templates/hello'),
          positionalOut,
          '--headless',
          '--answers',
          join(root, 'examples/templates/hello/answers.json'),
          '--json',
        ],
        { from: 'user' },
      );
      expect(await Bun.file(join(positionalOut, 'README.md')).text()).toContain('# Hello Lite');

      await createProgram().parseAsync(
        [
          'create',
          join(root, 'examples/templates/hello'),
          positionalOut,
          '--out',
          flagOut,
          '--headless',
          '--answers',
          join(root, 'examples/templates/hello/answers.json'),
          '--json',
        ],
        { from: 'user' },
      );
      expect(await Bun.file(join(flagOut, 'README.md')).text()).toContain('# Hello Lite');
    } finally {
      console.log = originalLog;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('commander parse errors stay JSON when requested', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    const originalExitCode = process.exitCode ?? 0;
    try {
      process.exitCode = undefined;
      console.error = (message?: unknown) => {
        errors.push(String(message));
      };

      await main(['create', '--json']);

      expect(Number(process.exitCode)).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).not.toContain('Usage:');
      expect(JSON.parse(errors[0] ?? '{}')).toMatchObject({
        status: 'error',
        problem: { code: 'commander.missingArgument' },
      });
    } finally {
      console.error = originalError;
      process.exitCode = originalExitCode;
    }
  });

  test('commander parse errors print once in human mode', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    const originalExitCode = process.exitCode ?? 0;
    try {
      process.exitCode = undefined;
      console.error = (message?: unknown) => {
        errors.push(String(message));
      };

      await main(['create']);

      expect(Number(process.exitCode)).toBe(1);
      expect(errors.join('\n').match(/missing required argument/g)).toHaveLength(1);
    } finally {
      console.error = originalError;
      process.exitCode = originalExitCode;
    }
  });

  test('json create missing answers returns only JSON error output', async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-json-missing-answer-'));
    const out = join(tempRoot, 'project');
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalExitCode = process.exitCode ?? 0;
    try {
      process.exitCode = undefined;
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      console.error = (message?: unknown) => {
        errors.push(String(message));
      };

      await main(['create', join(root, 'examples/templates/hello'), '--out', out, '--json']);

      expect(Number(process.exitCode)).toBe(1);
      expect(logs).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(JSON.parse(errors[0] ?? '{}')).toMatchObject({
        status: 'error',
        problem: { code: 'missing_answer' },
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.exitCode = originalExitCode;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('trust positional scope and ref route through commander', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-commander-trust-'));
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };

      await createProgram().parseAsync(
        ['trust', 'approve', 'template', 'cyanprint/hello', '--trust-dir', tempRoot, '--json'],
        { from: 'user' },
      );

      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
        status: 'done',
        store: { templates: [{ owner: 'cyanprint', name: 'hello' }] },
      });
    } finally {
      console.log = originalLog;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('trust scope flag can still use positional ref', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-commander-trust-scope-ref-'));
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };

      await createProgram().parseAsync(
        ['trust', 'approve', 'cyanprint/hello', '--scope', 'template', '--trust-dir', tempRoot, '--json'],
        { from: 'user' },
      );

      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
        status: 'done',
        store: { templates: [{ owner: 'cyanprint', name: 'hello' }] },
      });
    } finally {
      console.log = originalLog;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('inquirer prompt adapter', () => {
  test('maps prompt kinds to inquirer prompts and caches answers', async () => {
    const calls: Array<{ kind: string; config: unknown }> = [];
    const prompts = {
      input: async config => {
        calls.push({ kind: 'text', config });
        return 'text answer';
      },
      confirm: async config => {
        calls.push({ kind: 'confirm', config });
        return true;
      },
      select: async config => {
        calls.push({ kind: 'select', config });
        return 'two';
      },
      checkbox: async config => {
        calls.push({ kind: 'multiselect', config });
        return ['one'];
      },
      number: async config => {
        calls.push({ kind: 'number', config });
        return 7;
      },
    } as InquirerPrompts;
    const answers = {};
    const adapter = inquirerPromptAdapter(answers, prompts);

    await expect(adapter.ask({ kind: 'text', name: 'text', message: 'Text?', default: 'default' })).resolves.toBe(
      'text answer',
    );
    await expect(adapter.ask({ kind: 'confirm', name: 'confirm', message: 'Confirm?', default: false })).resolves.toBe(
      true,
    );
    await expect(
      adapter.ask({
        kind: 'select',
        name: 'select',
        message: 'Select?',
        options: ['one', 'two'],
        default: 'one',
      }),
    ).resolves.toBe('two');
    await expect(
      adapter.ask({
        kind: 'multiselect',
        name: 'multi',
        message: 'Multi?',
        options: ['one', 'two'],
        default: ['two'],
      }),
    ).resolves.toEqual(['one']);
    await expect(adapter.ask({ kind: 'number', name: 'number', message: 'Number?', default: 3 })).resolves.toBe(7);
    await expect(adapter.ask({ kind: 'text', name: 'text', message: 'Text again?' })).resolves.toBe('text answer');

    expect(calls.map(call => call.kind)).toEqual(['text', 'confirm', 'select', 'multiselect', 'number']);
    expect(calls[0]?.config).toMatchObject({ message: 'Text?', default: 'default' });
    expect(calls[1]?.config).toMatchObject({ message: 'Confirm?', default: false });
    expect(calls[2]?.config).toMatchObject({
      message: 'Select?',
      choices: [
        { name: 'one', value: 'one' },
        { name: 'two', value: 'two' },
      ],
      default: 'one',
    });
    expect(calls[3]?.config).toMatchObject({
      message: 'Multi?',
      choices: [
        { name: 'one', value: 'one', checked: false },
        { name: 'two', value: 'two', checked: true },
      ],
    });
    expect(calls[4]?.config).toMatchObject({ message: 'Number?', default: 3, required: true });
    expect(answers).toMatchObject({
      confirm: true,
      multi: ['one'],
      number: 7,
      select: 'two',
      text: 'text answer',
    });
  });
});

describe('interactive create wraps headless core', () => {
  test('interactive create with injected answers matches headless create output', async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-cli-create-'));
    const answersPath = join(tempRoot, 'answers.json');
    const headlessOut = join(tempRoot, 'headless');
    const interactiveOut = join(tempRoot, 'interactive');
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      await writeFile(answersPath, JSON.stringify({ name: 'Parity Project' }));
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      await createCommand([
        join(root, 'examples/templates/hello'),
        '--out',
        headlessOut,
        '--headless',
        '--answers',
        answersPath,
        '--json',
      ]);
      await createCommand([
        join(root, 'examples/templates/hello'),
        '--out',
        interactiveOut,
        '--answers',
        answersPath,
        '--json',
      ]);

      expect(await Bun.file(join(interactiveOut, 'README.md')).text()).toBe(
        await Bun.file(join(headlessOut, 'README.md')).text(),
      );
      expect(await Bun.file(join(interactiveOut, '.cyan_state.yaml')).text()).toContain('Parity Project');
      expect(logs).toHaveLength(2);
      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ status: 'done', outputPath: headlessOut });
      expect(JSON.parse(logs[1] ?? '{}')).toMatchObject({ status: 'done', outputPath: interactiveOut });
    } finally {
      console.log = originalLog;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('interactive create prompts instead of silently accepting defaults', async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-cli-interactive-prompt-'));
    const out = join(tempRoot, 'project');
    const prompts: string[] = [];
    try {
      await createCommand([join(root, 'examples/templates/hello'), '--out', out], {
        silent: true,
        promptAdapterFactory: answers => ({
          async ask<T>(request: PromptRequest) {
            prompts.push(request.name);
            answers[request.name] = 'Prompted Project';
            return 'Prompted Project' as T;
          },
        }),
      });
      expect(prompts).toHaveLength(1);
      expect(await Bun.file(join(out, 'README.md')).text()).toContain('Prompted Project');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('try defaults to a temp scratch output instead of the current directory', async () => {
    const root = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    let outputPath: string | undefined;
    try {
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      await tryCommand([
        join(root, 'examples/templates/hello'),
        '--headless',
        '--answers',
        join(root, 'examples/templates/hello/answers.json'),
        '--json',
      ]);
      const result = JSON.parse(logs[0] ?? '{}') as { status?: string; outputPath?: string };
      outputPath = result.outputPath;
      expect(result.status).toBe('done');
      expect(outputPath).toBeDefined();
      expect(outputPath).not.toBe(root);
      expect(outputPath).toContain('cyanprint-try-');
      expect(await Bun.file(join(outputPath!, 'README.md')).text()).toContain('# Hello Lite');
    } finally {
      console.log = originalLog;
      if (outputPath) {
        await rm(outputPath, { recursive: true, force: true });
      }
    }
  });

  test('local cached templates keep dev artifact fallback enabled', async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-local-cache-artifacts-'));
    const out = join(tempRoot, 'project');
    const cacheDir = join(tempRoot, 'cache');
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      await createCommand([
        join(root, 'examples/templates/with-artifacts'),
        '--cache-dir',
        cacheDir,
        '--out',
        out,
        '--headless',
        '--answers',
        join(root, 'examples/templates/with-artifacts/answers.json'),
        '--json',
      ]);
      expect(await Bun.file(join(out, 'README.md')).text()).toContain('ARTIFACT PROJECT');
      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ status: 'done', cacheHydrated: true });
    } finally {
      console.log = originalLog;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('update command', () => {
  test('non-json update reports conflicts without claiming success', async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-cli-update-conflict-'));
    const out = join(tempRoot, 'project');
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    try {
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      console.error = (message?: unknown) => {
        errors.push(String(message));
      };

      await createCommand([
        join(root, 'examples/templates/update-v1'),
        '--out',
        out,
        '--headless',
        '--answers',
        join(root, 'examples/templates/update-v1/answers.json'),
        '--json',
      ]);
      await writeFile(join(out, 'README.md'), '# User Edit\n\nKeep me.\n', 'utf8');

      await expect(
        updateCommand([
          out,
          '--template',
          join(root, 'examples/templates/update-v2'),
          '--headless',
          '--answers',
          join(root, 'examples/templates/update-v2/answers.json'),
        ]),
      ).rejects.toThrow('update conflicted');

      expect(errors.join('\n')).toContain('update conflicted');
      expect(errors.join('\n')).toContain('README.md: user_edit_and_target_changed');
      expect(logs.some(line => line === `updated ${out}`)).toBe(false);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('json update conflicts set a failing exit code', async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-cli-update-json-conflict-'));
    const out = join(tempRoot, 'project');
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExitCode = process.exitCode ?? 0;
    try {
      process.exitCode = undefined;
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };

      await createCommand([
        join(root, 'examples/templates/update-v1'),
        '--out',
        out,
        '--headless',
        '--answers',
        join(root, 'examples/templates/update-v1/answers.json'),
        '--json',
      ]);
      await writeFile(join(out, 'README.md'), '# User Edit\n\nKeep me.\n', 'utf8');

      await updateCommand([
        out,
        '--template',
        join(root, 'examples/templates/update-v2'),
        '--headless',
        '--answers',
        join(root, 'examples/templates/update-v2/answers.json'),
        '--json',
      ]);

      expect(Number(process.exitCode)).toBe(1);
      expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({
        status: 'conflict',
        conflicts: [{ path: 'README.md', reason: 'user_edit_and_target_changed' }],
      });
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('main update conflict prints the human error once', async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-cli-main-update-conflict-'));
    const out = join(tempRoot, 'project');
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalExitCode = process.exitCode ?? 0;
    try {
      process.exitCode = undefined;
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      console.error = (message?: unknown) => {
        errors.push(String(message));
      };

      await createCommand([
        join(root, 'examples/templates/update-v1'),
        '--out',
        out,
        '--headless',
        '--answers',
        join(root, 'examples/templates/update-v1/answers.json'),
        '--json',
      ]);
      await writeFile(join(out, 'README.md'), '# User Edit\n\nKeep me.\n', 'utf8');

      await main([
        'update',
        out,
        '--template',
        join(root, 'examples/templates/update-v2'),
        '--headless',
        '--answers',
        join(root, 'examples/templates/update-v2/answers.json'),
      ]);

      expect(Number(process.exitCode)).toBe(1);
      expect(errors.join('\n').match(/update conflicted/g)).toHaveLength(1);
      expect(errors.join('\n')).toContain('README.md: user_edit_and_target_changed');
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.exitCode = originalExitCode;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('local object package safety', () => {
  test('rejects paths that escape the cache directory', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-object-safety-'));
    const outDir = join(tempRoot, 'cache-entry');
    const escapedPath = join(tempRoot, 'escaped.txt');
    try {
      await expect(
        unpackLocalObjectPayload(
          JSON.stringify({
            cyanprint: 4,
            files: [{ path: '../escaped.txt', content: 'bad' }],
          }),
          outDir,
        ),
      ).rejects.toThrow('Refusing to write outside output directory');
      expect(await Bun.file(escapedPath).exists()).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('uses UTF-8 byte length for object package size', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-object-size-'));
    try {
      await writeFile(join(tempRoot, 'README.md'), '# Café\n', 'utf8');
      const payload = await createLocalObjectPayload(tempRoot);
      expect(payload.size).toBe(textEncoder.encode(payload.payload).byteLength);
      expect(payload.size).toBeGreaterThan(payload.payload.length);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects duplicate package paths before unpacking', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-object-duplicates-'));
    try {
      await expect(
        unpackLocalObjectPayload(
          JSON.stringify({
            cyanprint: 4,
            files: [
              { path: 'cyan.yaml', content: 'first' },
              { path: 'cyan.yaml', content: 'second' },
            ],
          }),
          tempRoot,
        ),
      ).rejects.toThrow('Duplicate CyanPrint local object file path');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('creates and unpacks binary tar template archives', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-template-archive-'));
    const templateDir = join(tempRoot, 'template');
    const outDir = join(tempRoot, 'out');
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    try {
      await mkdir(join(templateDir, 'template/assets'), { recursive: true });
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: tar\nbundledEntry: cyan.ts\n',
        'utf8',
      );
      await writeFile(join(templateDir, 'cyan.ts'), 'export default async () => ({});\n', 'utf8');
      await writeFile(join(templateDir, 'README.md'), '# Tar\n', 'utf8');
      await writeFile(join(templateDir, 'template/README.md'), '# From archive\n', 'utf8');
      await writeFile(join(templateDir, 'template/assets/pixel.bin'), bytes);
      await mkdir(join(templateDir, 'snapshots/basic'), { recursive: true });
      await writeFile(join(templateDir, 'snapshots/basic/README.md'), '# Snapshot content\n', 'utf8');

      const archive = await createTemplateArchivePayload(templateDir, { bundledEntry: 'cyan.ts' });
      expect(new TextDecoder().decode(archive.payload.slice(257, 262))).toBe('ustar');
      await unpackTemplateArchivePayload(archive.payload, outDir);

      expect(await Bun.file(join(outDir, 'template/README.md')).text()).toBe('# From archive\n');
      expect(new Uint8Array(await Bun.file(join(outDir, 'template/assets/pixel.bin')).arrayBuffer())).toEqual(bytes);
      expect(await Bun.file(join(outDir, 'snapshots/basic/README.md')).text()).toBe('# Snapshot content\n');
      expect(await Bun.file(join(outDir, 'cyan.ts')).exists()).toBe(false);
      expect(await Bun.file(join(outDir, 'cyan.yaml')).exists()).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('registry template hydration', () => {
  test('rejects dependency pins whose integrity does not match the resolved artifact', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-registry-pins-'));
    const templatePayload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: bad-pins\nbundledEntry: cyan.ts\n',
        },
        { path: 'cyan.ts', content: 'export default async () => ({});\n' },
      ],
    });
    const processorPayload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content:
            'cyanprint: 4\nkind: processor\nowner: cyanprint\nname: uppercase\nversion: 4\nbundledEntry: dist/index.js\n',
        },
        {
          path: 'dist/index.js',
          content:
            'export async function processor(input) { const glob = new Bun.Glob("**/*"); for await (const path of glob.scan({ cwd: input.inputDir, onlyFiles: true })) await Bun.write(input.outputDir + "/" + path, await Bun.file(input.inputDir + "/" + path).text()); }\n',
        },
      ],
    });
    const templateObject = {
      bucket: 'cyanprint-local-r2',
      key: 'templates/bad-pins.cyanpkg.json',
      sha256: sha256(templatePayload),
      size: textEncoder.encode(templatePayload).byteLength,
    };
    const processorObject = {
      bucket: 'cyanprint-local-r2',
      key: 'processors/uppercase.cyanpkg.json',
      sha256: sha256(processorPayload),
      size: textEncoder.encode(processorPayload).byteLength,
    };
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/batch-resolve') {
          const body = (await request.json()) as { refs: Array<{ kind: string }> };
          if (body.refs[0]?.kind === 'template') {
            return Response.json({
              resolved: [
                {
                  id: 'template_bad_pins_4',
                  kind: 'template',
                  owner: 'cyanprint',
                  name: 'bad-pins',
                  version: '4',
                  readme: '',
                  dependencies: [],
                  resolvedPins: [
                    {
                      kind: 'processor',
                      owner: 'cyanprint',
                      name: 'uppercase',
                      version: '4',
                      integrity: 'stale-integrity',
                    },
                  ],
                  object: templateObject,
                  disabled: false,
                  moderationState: 'active',
                  downloads: 0,
                  likes: 0,
                },
              ],
              missing: [],
            });
          }
          return Response.json({
            resolved: [
              {
                id: 'processor_uppercase_4',
                kind: 'processor',
                owner: 'cyanprint',
                name: 'uppercase',
                version: '4',
                readme: '',
                dependencies: [],
                resolvedPins: [],
                object: processorObject,
                disabled: false,
                moderationState: 'active',
                downloads: 0,
                likes: 0,
              },
            ],
            missing: [],
          });
        }
        if (url.pathname === '/objects/download') {
          const body = (await request.json()) as { ref: { key: string } };
          return Response.json({
            payload: body.ref.key === templateObject.key ? templatePayload : processorPayload,
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      await expect(
        resolveTemplateInput({
          template: 'cyanprint/bad-pins',
          registry: server.url.toString().replace(/\/$/, ''),
          cacheDir: tempRoot,
          trustFixture: 'local-registry',
        }),
      ).rejects.toThrow('Resolved artifact pin integrity mismatch');
    } finally {
      server.stop(true);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects bundled entries that escape the downloaded artifact package', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-registry-entry-'));
    const templatePayload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: escape-entry\nbundledEntry: cyan.ts\n',
        },
        { path: 'cyan.ts', content: 'export default async () => ({});\n' },
      ],
    });
    const processorPayload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content:
            'cyanprint: 4\nkind: processor\nowner: cyanprint\nname: escape\nversion: 4\nbundledEntry: ../escape.js\n',
        },
      ],
    });
    const templateObject = {
      bucket: 'cyanprint-local-r2',
      key: 'templates/escape-entry.cyanpkg.json',
      sha256: sha256(templatePayload),
      size: textEncoder.encode(templatePayload).byteLength,
    };
    const processorObject = {
      bucket: 'cyanprint-local-r2',
      key: 'processors/escape.cyanpkg.json',
      sha256: sha256(processorPayload),
      size: textEncoder.encode(processorPayload).byteLength,
    };
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/batch-resolve') {
          const body = (await request.json()) as { refs: Array<{ kind: string }> };
          if (body.refs[0]?.kind === 'template') {
            return Response.json({
              resolved: [
                {
                  id: 'template_escape_entry_4',
                  kind: 'template',
                  owner: 'cyanprint',
                  name: 'escape-entry',
                  version: '4',
                  readme: '',
                  dependencies: [],
                  resolvedPins: [
                    {
                      kind: 'processor',
                      owner: 'cyanprint',
                      name: 'escape',
                      version: '4',
                      integrity: artifactIntegrity({ id: 'processor_escape_4', object: processorObject }),
                    },
                  ],
                  object: templateObject,
                  disabled: false,
                  moderationState: 'active',
                  downloads: 0,
                  likes: 0,
                },
              ],
              missing: [],
            });
          }
          return Response.json({
            resolved: [
              {
                id: 'processor_escape_4',
                kind: 'processor',
                owner: 'cyanprint',
                name: 'escape',
                version: '4',
                readme: '',
                dependencies: [],
                resolvedPins: [],
                object: processorObject,
                disabled: false,
                moderationState: 'active',
                downloads: 0,
                likes: 0,
              },
            ],
            missing: [],
          });
        }
        if (url.pathname === '/objects/download') {
          const body = (await request.json()) as { ref: { key: string } };
          return Response.json({
            payload: body.ref.key === templateObject.key ? templatePayload : processorPayload,
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      await expect(
        resolveTemplateInput({
          template: 'cyanprint/escape-entry',
          registry: server.url.toString().replace(/\/$/, ''),
          cacheDir: tempRoot,
          trustFixture: 'local-registry',
        }),
      ).rejects.toThrow('cyan.yaml is invalid');
    } finally {
      server.stop(true);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('keeps registry cache valid when only mutable counters change', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-registry-cache-'));
    let resolves = 0;
    let downloads = 0;
    const templatePayload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: cached\nbundledEntry: cyan.ts\n',
        },
        { path: 'cyan.ts', content: 'export default async () => ({});\n' },
      ],
    });
    const templateObject = {
      bucket: 'cyanprint-local-r2',
      key: 'templates/cached.cyanpkg.json',
      sha256: sha256(templatePayload),
      size: textEncoder.encode(templatePayload).byteLength,
    };
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/batch-resolve') {
          resolves += 1;
          return Response.json({
            resolved: [
              {
                id: 'template_cached_4',
                kind: 'template',
                owner: 'cyanprint',
                name: 'cached',
                version: '4',
                readme: '',
                dependencies: [],
                resolvedPins: [],
                object: templateObject,
                disabled: false,
                moderationState: 'active',
                downloads: resolves === 1 ? 0 : 99,
                likes: resolves === 1 ? 0 : 99,
              },
            ],
            missing: [],
          });
        }
        if (url.pathname === '/objects/download') {
          downloads += 1;
          return Response.json({ payload: templatePayload });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const registry = server.url.toString().replace(/\/$/, '');
      await resolveTemplateInput({
        template: 'cyanprint/cached',
        registry,
        cacheDir: tempRoot,
        trustFixture: 'local-registry',
      });
      await resolveTemplateInput({
        template: 'cyanprint/cached',
        registry,
        cacheDir: tempRoot,
        trustFixture: 'local-registry',
      });
      expect(downloads).toBe(1);
    } finally {
      server.stop(true);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('passes exact registry template versions to batch resolve', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-registry-version-ref-'));
    const seenRefs: Array<{ kind: string; owner: string; name: string; version?: string }> = [];
    const templatePayload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: exact\nbundledEntry: cyan.ts\n',
        },
        { path: 'cyan.ts', content: 'export default async () => ({});\n' },
      ],
    });
    const templateObject = {
      bucket: 'cyanprint-local-r2',
      key: 'templates/exact.cyanpkg.json',
      sha256: sha256(templatePayload),
      size: textEncoder.encode(templatePayload).byteLength,
    };
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/batch-resolve') {
          const body = (await request.json()) as {
            refs: Array<{ kind: string; owner: string; name: string; version?: string }>;
          };
          seenRefs.push(...body.refs);
          return Response.json({
            resolved: [
              {
                id: 'template_exact_7',
                kind: 'template',
                owner: 'cyanprint',
                name: 'exact',
                version: '7',
                readme: '',
                dependencies: [],
                resolvedPins: [],
                object: templateObject,
                disabled: false,
                moderationState: 'active',
                downloads: 0,
                likes: 0,
              },
            ],
            missing: [],
          });
        }
        if (url.pathname === '/objects/download') {
          return Response.json({ payload: templatePayload });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      await resolveTemplateInput({
        template: 'cyanprint/exact@7',
        registry: server.url.toString().replace(/\/$/, ''),
        cacheDir: tempRoot,
        trustFixture: 'local-registry',
      });

      expect(seenRefs).toEqual([
        { kind: 'template', owner: 'cyanprint', name: 'exact', version: '7' },
        { kind: 'template-group', owner: 'cyanprint', name: 'exact', version: '7' },
      ]);
    } finally {
      server.stop(true);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('hydrates registry packages whose payload size includes non-ASCII bytes', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-registry-unicode-'));
    const templatePayload = JSON.stringify({
      cyanprint: 4,
      files: [
        {
          path: 'cyan.yaml',
          content: 'cyanprint: 4\nkind: template\nowner: cyanprint\nname: cafe\nbundledEntry: cyan.ts\n',
        },
        { path: 'cyan.ts', content: 'export default async () => ({});\n' },
        { path: 'README.md', content: '# Café\n' },
      ],
    });
    const templateObject = {
      bucket: 'cyanprint-local-r2',
      key: 'templates/cafe.cyanpkg.json',
      sha256: sha256(templatePayload),
      size: textEncoder.encode(templatePayload).byteLength,
    };
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/batch-resolve') {
          return Response.json({
            resolved: [
              {
                id: 'template_cafe_4',
                kind: 'template',
                owner: 'cyanprint',
                name: 'cafe',
                version: '4',
                readme: '',
                dependencies: [],
                resolvedPins: [],
                object: templateObject,
                disabled: false,
                moderationState: 'active',
                downloads: 0,
                likes: 0,
              },
            ],
            missing: [],
          });
        }
        if (url.pathname === '/objects/download') {
          return Response.json({ payload: templatePayload });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const resolved = await resolveTemplateInput({
        template: 'cyanprint/cafe',
        registry: server.url.toString().replace(/\/$/, ''),
        cacheDir: tempRoot,
        trustFixture: 'local-registry',
      });
      expect(await Bun.file(join(resolved.templateDir, 'README.md')).text()).toBe('# Café\n');
    } finally {
      server.stop(true);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('push command', () => {
  test('normalizes ownerless dependency refs to the publishing owner before registry resolve', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-push-owner-'));
    const artifactDir = join(tempRoot, 'template');
    let resolvedOwner: string | undefined;
    const logs: string[] = [];
    const originalLog = console.log;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/batch-resolve') {
          const body = (await request.json()) as { refs: Array<{ owner?: string }> };
          resolvedOwner = body.refs[0]?.owner;
          return Response.json({
            resolved:
              resolvedOwner === 'cyanprint'
                ? [
                    {
                      id: 'processor_cyanprint_uppercase_4',
                      kind: 'processor',
                      owner: 'cyanprint',
                      name: 'uppercase',
                      version: '4',
                      readme: '',
                      dependencies: [],
                      resolvedPins: [],
                      object: {
                        bucket: 'cyanprint-local-r2',
                        key: 'processor/cyanprint/uppercase/4.cyanpkg.json',
                        sha256: 'abc123abc123abc123',
                        size: 1,
                      },
                      disabled: false,
                      moderationState: 'active',
                      downloads: 0,
                      likes: 0,
                    },
                  ]
                : [],
            missing: [],
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        join(artifactDir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: template',
          'owner: cyanprint',
          'name: owner-normalized',
          'bundledEntry: cyan.ts',
          'processors:',
          '  - cyanprint/uppercase',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(artifactDir, 'cyan.ts'), 'export default async () => ({});\n', 'utf8');
      await mkdir(join(artifactDir, 'template'), { recursive: true });
      await writeFile(join(artifactDir, 'template', 'README.md'), '# Owner normalized\n', 'utf8');
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      await pushCommand([artifactDir, '--registry', server.url.toString().replace(/\/$/, ''), '--dry-run', '--json']);
      expect(resolvedOwner).toBe('cyanprint');
      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ dependenciesResolved: 1 });
    } finally {
      console.log = originalLog;
      server.stop(true);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

const PROCESSOR_SRC =
  'export async function processor(input, fs) { const files = await fs.read(); await fs.write(files.map(file => ({ ...file, content: (file.content ?? "").toUpperCase() }))); }\n';

async function writeProcessorFixture(dir: string, expectedContent: string): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'tests/basic/input'), { recursive: true });
  await mkdir(join(dir, 'tests/basic/expected'), { recursive: true });
  await writeFile(
    join(dir, 'cyan.yaml'),
    [
      'cyanprint: 4',
      'kind: processor',
      'owner: cyan',
      'name: up',
      'entry: src/index.ts',
      'bundledEntry: dist/index.js',
      '',
    ].join('\n'),
  );
  await writeFile(join(dir, 'README.md'), '# Up\n');
  await writeFile(join(dir, 'src/index.ts'), PROCESSOR_SRC);
  await writeFile(
    join(dir, 'cyan.test.yaml'),
    ['cases:', '  - name: basic', '    input: tests/basic/input', '    expected: tests/basic/expected', ''].join('\n'),
  );
  await writeFile(join(dir, 'tests/basic/input/a.txt'), 'hi');
  await writeFile(join(dir, 'tests/basic/expected/a.txt'), expectedContent);
}

async function captureLogs(run: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return logs;
}

describe('bundle command', () => {
  test('bundles a processor into its declared bundledEntry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-cli-bundle-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(
        join(dir, 'cyan.yaml'),
        [
          'cyanprint: 4',
          'kind: processor',
          'owner: cyan',
          'name: up',
          'entry: src/index.ts',
          'bundledEntry: dist/index.js',
          '',
        ].join('\n'),
      );
      await writeFile(join(dir, 'README.md'), '# Up\n');
      await writeFile(join(dir, 'src/index.ts'), PROCESSOR_SRC);
      const logs = await captureLogs(() => bundleCommand([dir, '--no-install', '--json']));
      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ status: 'bundled' });
      expect(await Bun.file(join(dir, 'dist/index.js')).exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('push test gating', () => {
  test('aborts publish when artifact tests fail by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-cli-push-fail-'));
    try {
      await writeProcessorFixture(dir, 'hi'); // processor uppercases -> "HI" != expected "hi"
      await expect(pushCommand([dir, '--dry-run', '--json'])).rejects.toThrow('failing test');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('--no-test skips tests and validates the bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-cli-push-notest-'));
    try {
      await writeProcessorFixture(dir, 'hi');
      const logs = await captureLogs(() => pushCommand([dir, '--dry-run', '--no-test', '--json']));
      expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({ status: 'planned' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('trace command', () => {
  test('--json emits tree, provenance, and diffs for a template group', async () => {
    const logs = await captureLogs(() =>
      traceCommand([join(process.cwd(), 'examples/template-groups/basic'), '--headless', '--json']),
    );
    const report = JSON.parse(logs.at(-1) ?? '{}');
    expect(report.tree?.ref).toBe('cyanprint/basic-group');
    expect(Array.isArray(report.provenance)).toBe(true);
    expect(report.provenance.length).toBeGreaterThan(0);
    expect(Array.isArray(report.diffs)).toBe(true);
  });
});
