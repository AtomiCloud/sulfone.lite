import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createProject, sha256 } from '@cyanprint/core';
import { artifactIntegrity, readTemplateTarFiles } from '@cyanprint/contracts';
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
import { VERSION } from './version';
import { resolveTemplateInput } from './registry-template';

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Self-contained fixture workspaces (v4 manifest shapes). Each workspace carries its
// own examples/artifacts + examples/templates so dev fallback resolution never depends
// on repo-level example data.
// ---------------------------------------------------------------------------

const VAR_PROCESSOR_SRC = `export async function processor(input, fs) {
  const files = await fs.read();
  const config = input.config && typeof input.config === 'object' ? input.config : {};
  const vars = config.vars && typeof config.vars === 'object' ? config.vars : {};
  await fs.write(
    files.map(file => {
      if (file.content === undefined) {
        return file;
      }
      let content = file.content;
      for (const [key, value] of Object.entries(vars)) {
        content = content.replaceAll('__' + key + '__', String(value));
      }
      return { ...file, content };
    }),
  );
}
`;

const UPPERCASE_PROCESSOR_SRC = `export async function processor(input, fs) {
  const files = await fs.read();
  await fs.write(
    files.map(file => (file.content === undefined ? file : { ...file, content: file.content.toUpperCase() })),
  );
}
`;

const FOOTER_PLUGIN_SRC = `export async function plugin(input, helper) {
  const files = await helper.read();
  await helper.write(
    files.map(file =>
      file.content === undefined ? file : { ...file, content: file.content + '\\nGenerated locally.\\n' },
    ),
  );
}
`;

// v4 resolver runtime API: ONE call per conflicting path with ALL variations in scope.
const CONCAT_RESOLVER_SRC = `export async function resolver(input) {
  const files = [...input.files].sort((left, right) => left.origin.layer - right.origin.layer);
  return { path: files[0].path, content: files.map(file => file.content).join('') };
}
`;

const HELLO_CYAN_TS = `export default async function cyan(prompt) {
  const name = await prompt.text('name', 'Project name');
  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { NAME: name } },
      },
    ],
  };
}
`;

const GREETING_CYAN_TS = `export default async function cyan(prompt) {
  const greeting = await prompt.text('greeting', 'Greeting');
  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { GREETING: greeting } },
      },
    ],
  };
}
`;

const WITH_ARTIFACTS_CYAN_TS = `export default async function cyan(prompt) {
  const name = await prompt.text('name', 'Project name');
  const files = [{ root: 'template', glob: '**/*', type: 'Template' }];
  return {
    processors: [
      { name: 'cyan/default', files, config: { vars: { NAME: name } } },
      { name: 'cyanprint/uppercase', files },
    ],
    plugins: [{ name: 'cyanprint/footer' }],
  };
}
`;

const GROUP_CYAN_TS = `export default function cyan(prompt, ctx) {
  const name = ctx.answers.name ?? 'Basic Group';
  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { NAME: name } },
      },
    ],
  };
}
`;

async function writeArtifactFixture(
  root: string,
  dirName: string,
  manifest: { kind: 'processor' | 'plugin' | 'resolver'; owner: string; name: string },
  src: string,
): Promise<void> {
  const dir = join(root, 'examples/artifacts', dirName);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'cyan.yaml'),
    [
      'cyanprint: 4',
      `kind: ${manifest.kind}`,
      `owner: ${manifest.owner}`,
      `name: ${manifest.name}`,
      'entry: src/index.ts',
      'bundledEntry: dist/index.js',
      '',
    ].join('\n'),
  );
  await writeFile(join(dir, 'src/index.ts'), src);
}

async function makeFixtureWorkspace(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeArtifactFixture(
    root,
    'processor-default',
    { kind: 'processor', owner: 'cyan', name: 'default' },
    VAR_PROCESSOR_SRC,
  );
  return root;
}

async function writeTemplateFixture(
  root: string,
  options: {
    name: string;
    kind?: 'template' | 'template-group';
    /** Extra raw cyan.yaml lines appended after `processors:\n  - cyan/default`. */
    manifestLines?: string[];
    cyanTs: string;
    files: Record<string, string>;
  },
): Promise<string> {
  const dir = join(
    root,
    options.kind === 'template-group' ? 'examples/template-groups' : 'examples/templates',
    options.name,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'cyan.yaml'),
    [
      'cyanprint: 4',
      `kind: ${options.kind ?? 'template'}`,
      'owner: cyanprint',
      `name: ${options.name}`,
      'bundledEntry: cyan.ts',
      'processors:',
      '  - cyan/default',
      ...(options.manifestLines ?? []),
      '',
    ].join('\n'),
  );
  await writeFile(join(dir, 'cyan.ts'), options.cyanTs);
  for (const [path, content] of Object.entries(options.files)) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

async function writeHelloFixture(root: string): Promise<{ templateDir: string; answersPath: string }> {
  const templateDir = await writeTemplateFixture(root, {
    name: 'hello',
    cyanTs: HELLO_CYAN_TS,
    files: { 'template/README.md': '# __NAME__\n\nA fixture project.\n' },
  });
  const answersPath = join(templateDir, 'answers.json');
  await writeFile(answersPath, JSON.stringify({ name: 'Hello Lite' }));
  return { templateDir, answersPath };
}

async function writeGroupFixture(root: string): Promise<string> {
  await writeHelloFixture(root);
  return await writeTemplateFixture(root, {
    name: 'basic-group',
    kind: 'template-group',
    manifestLines: ['templates:', '  cyanprint/hello:', '    answers:', '      name: Group Hello'],
    cyanTs: GROUP_CYAN_TS,
    files: { 'template/GROUP.md': '# Group __NAME__\n' },
  });
}

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

      expect(logs).toEqual([`cyanprint ${VERSION}`]);
    } finally {
      console.log = originalLog;
    }
  });

  test('create routes prompts through the commander prompt adapter', async () => {
    const workspace = await makeFixtureWorkspace('cyanprint-commander-create-');
    const out = join(workspace, 'project');
    const prompts: string[] = [];
    try {
      const { templateDir } = await writeHelloFixture(workspace);
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

      await program.parseAsync(['create', templateDir, '--out', out], {
        from: 'user',
      });

      expect(prompts).toEqual(['name']);
      expect(await Bun.file(join(out, 'README.md')).text()).toContain('Commander Project');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('create accepts positional output and lets --out override it', async () => {
    const workspace = await makeFixtureWorkspace('cyanprint-commander-positional-out-');
    const positionalOut = join(workspace, 'positional');
    const flagOut = join(workspace, 'flag');
    const originalLog = console.log;
    try {
      const { templateDir, answersPath } = await writeHelloFixture(workspace);
      console.log = () => {};
      await createProgram().parseAsync(
        ['create', templateDir, positionalOut, '--headless', '--answers', answersPath, '--json'],
        { from: 'user' },
      );
      expect(await Bun.file(join(positionalOut, 'README.md')).text()).toContain('# Hello Lite');

      await createProgram().parseAsync(
        ['create', templateDir, positionalOut, '--out', flagOut, '--headless', '--answers', answersPath, '--json'],
        { from: 'user' },
      );
      expect(await Bun.file(join(flagOut, 'README.md')).text()).toContain('# Hello Lite');
    } finally {
      console.log = originalLog;
      await rm(workspace, { recursive: true, force: true });
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
    expect(calls[4]?.config).toMatchObject({ message: 'Number?', default: 3 });
    expect(answers).toMatchObject({
      confirm: true,
      multi: ['one'],
      number: 7,
      select: 'two',
      text: 'text answer',
    });
  });

  test('passes placeholders and descriptions through, and maps per-option descriptions', async () => {
    const calls: Array<{
      kind: string;
      config: { message: string; placeholder?: string; description?: string; choices?: unknown };
    }> = [];
    const prompts = {
      input: async config => {
        calls.push({ kind: 'text', config });
        return 'x';
      },
      confirm: async () => true,
      select: async config => {
        calls.push({ kind: 'select', config });
        return 'a';
      },
      checkbox: async () => [],
      number: async () => 1,
    } as InquirerPrompts;
    const adapter = inquirerPromptAdapter({}, prompts);

    await adapter.ask({
      kind: 'text',
      name: 'url',
      message: 'What is your URL?',
      placeholder: 'https://example.com',
      description: 'Used as the homepage link in the generated README.',
    });
    await adapter.ask({
      kind: 'select',
      name: 'flavor',
      message: 'Pick a flavor',
      options: [
        { value: 'a', label: 'Flavor A', description: 'The classic.' },
        { value: 'b', description: 'The bold one.' },
      ],
    });

    // Free-form prompts receive placeholder/description as config (rendered as an inline
    // ghost value and a bottom line by the described prompts) — never baked into the message.
    expect(calls[0]?.config).toMatchObject({
      message: 'What is your URL?',
      placeholder: 'https://example.com',
      description: 'Used as the homepage link in the generated README.',
    });
    expect(calls[1]?.config.choices).toMatchObject([
      { name: 'Flavor A', value: 'a', description: 'The classic.' },
      { name: 'b', value: 'b', description: 'The bold one.' },
    ]);

    // A prompt-level description on a list prompt stacks below the option help, so it
    // renders at the bottom for every kind — never embedded in the message.
    await adapter.ask({
      kind: 'select',
      name: 'size',
      message: 'Pick a size',
      description: 'You can change this later in config.',
      options: ['small', { value: 'large', description: 'Roomy.' }],
    });
    expect(calls[2]?.config.message).toBe('Pick a size');
    expect(calls[2]?.config.choices).toMatchObject([
      { name: 'small', value: 'small', description: 'You can change this later in config.' },
      { name: 'large', value: 'large', description: 'Roomy.\nYou can change this later in config.' },
    ]);
  });

  test('re-run suggestions prefill free-form prompts and default list prompts', async () => {
    const calls: Array<{ kind: string; config: { placeholder?: string; default?: unknown } }> = [];
    const prompts = {
      input: async config => {
        calls.push({ kind: 'text', config });
        return 'x';
      },
      confirm: async () => true,
      select: async config => {
        calls.push({ kind: 'select', config });
        return 'a';
      },
      checkbox: async () => [],
      number: async () => 1,
    } as InquirerPrompts;
    const adapter = inquirerPromptAdapter({}, prompts, { name: 'Prior Project', flavor: 'b' });

    await adapter.ask({ kind: 'text', name: 'name', message: 'Name?', placeholder: 'example' });
    await adapter.ask({ kind: 'select', name: 'flavor', message: 'Flavor?', options: ['a', 'b'], default: 'a' });

    // The recorded answer becomes the default everywhere (enter keeps it); the
    // placeholder backdrop stays as a display-only suggestion.
    expect(calls[0]?.config.default).toBe('Prior Project');
    expect(calls[0]?.config.placeholder).toBe('example');
    expect(calls[1]?.config.default).toBe('b');
  });
});

describe('interactive create wraps headless core', () => {
  test('interactive create with injected answers matches headless create output', async () => {
    const workspace = await makeFixtureWorkspace('cyanprint-cli-create-');
    const answersPath = join(workspace, 'answers.json');
    const headlessOut = join(workspace, 'headless');
    const interactiveOut = join(workspace, 'interactive');
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      const { templateDir } = await writeHelloFixture(workspace);
      await writeFile(answersPath, JSON.stringify({ name: 'Parity Project' }));
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      await createCommand([templateDir, '--out', headlessOut, '--headless', '--answers', answersPath, '--json']);
      await createCommand([templateDir, '--out', interactiveOut, '--answers', answersPath, '--json']);

      expect(await Bun.file(join(interactiveOut, 'README.md')).text()).toBe(
        await Bun.file(join(headlessOut, 'README.md')).text(),
      );
      expect(await Bun.file(join(interactiveOut, '.cyan_state.yaml')).text()).toContain('Parity Project');
      expect(logs).toHaveLength(2);
      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ status: 'done', outputPath: headlessOut });
      expect(JSON.parse(logs[1] ?? '{}')).toMatchObject({ status: 'done', outputPath: interactiveOut });
    } finally {
      console.log = originalLog;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('interactive create prompts instead of silently accepting defaults', async () => {
    const workspace = await makeFixtureWorkspace('cyanprint-cli-interactive-prompt-');
    const out = join(workspace, 'project');
    const prompts: string[] = [];
    try {
      const { templateDir } = await writeHelloFixture(workspace);
      await createCommand([templateDir, '--out', out], {
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
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('try defaults to a temp scratch output instead of the current directory', async () => {
    const workspace = await makeFixtureWorkspace('cyanprint-cli-try-scratch-');
    const logs: string[] = [];
    const originalLog = console.log;
    let outputPath: string | undefined;
    try {
      const { templateDir, answersPath } = await writeHelloFixture(workspace);
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      await tryCommand([templateDir, '--headless', '--answers', answersPath, '--json']);
      const result = JSON.parse(logs[0] ?? '{}') as { status?: string; outputPath?: string };
      outputPath = result.outputPath;
      expect(result.status).toBe('done');
      expect(outputPath).toBeDefined();
      expect(outputPath).not.toBe(process.cwd());
      expect(outputPath).toContain('cyanprint-try-');
      expect(await Bun.file(join(outputPath!, 'README.md')).text()).toContain('# Hello Lite');
    } finally {
      console.log = originalLog;
      if (outputPath) {
        await rm(outputPath, { recursive: true, force: true });
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('local cached templates keep dev artifact fallback enabled', async () => {
    const workspace = await makeFixtureWorkspace('cyanprint-local-cache-artifacts-');
    const out = join(workspace, 'project');
    const cacheDir = join(workspace, 'cache');
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      await writeArtifactFixture(
        workspace,
        'processor-uppercase',
        { kind: 'processor', owner: 'cyanprint', name: 'uppercase' },
        UPPERCASE_PROCESSOR_SRC,
      );
      await writeArtifactFixture(
        workspace,
        'plugin-footer',
        { kind: 'plugin', owner: 'cyanprint', name: 'footer' },
        FOOTER_PLUGIN_SRC,
      );
      await writeArtifactFixture(
        workspace,
        'resolver-concat',
        { kind: 'resolver', owner: 'cyanprint', name: 'concat' },
        CONCAT_RESOLVER_SRC,
      );
      const templateDir = await writeTemplateFixture(workspace, {
        name: 'with-artifacts',
        manifestLines: [
          '  - cyanprint/uppercase',
          'plugins:',
          '  - cyanprint/footer',
          'resolvers:',
          '  - ref: cyanprint/concat',
          '    files:',
          '      - README.md',
        ],
        cyanTs: WITH_ARTIFACTS_CYAN_TS,
        files: { 'template/README.md': '# __NAME__\n\nbody text\n' },
      });
      const answersPath = join(workspace, 'answers.json');
      await writeFile(answersPath, JSON.stringify({ name: 'Artifact Project' }));
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      await createCommand([
        templateDir,
        '--cache-dir',
        cacheDir,
        '--out',
        out,
        '--headless',
        '--answers',
        answersPath,
        '--json',
      ]);
      // Tier-1 global resolution: both processor layers conflict on README.md, both
      // nominate cyanprint/concat, so ONE resolver call merges every variation; the
      // footer plugin then transforms the single own layer.
      const readme = await Bun.file(join(out, 'README.md')).text();
      expect(readme).toContain('# Artifact Project');
      expect(readme).toContain('BODY TEXT');
      expect(readme).toContain('Generated locally.');
      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ status: 'done', cacheHydrated: true });
      const state = await Bun.file(join(out, '.cyan_state.yaml')).text();
      expect(state).toContain('resolver-merged');
      expect(state).toContain('cyanprint/concat');
    } finally {
      console.log = originalLog;
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

// Update fixture: one installed template whose regeneration diverges between base
// (saved answers) and theirs (--answers override), while the user edited the same line.
// The git three-way merge must leave IN-FILE conflict markers, not side files.
async function writeUpdateFixture(
  workspace: string,
): Promise<{ templateDir: string; v1AnswersPath: string; v2AnswersPath: string }> {
  const templateDir = await writeTemplateFixture(workspace, {
    name: 'update-example',
    cyanTs: HELLO_CYAN_TS,
    files: { 'template/README.md': '# __NAME__\n\nGenerated body.\n' },
  });
  const v1AnswersPath = join(workspace, 'answers-v1.json');
  const v2AnswersPath = join(workspace, 'answers-v2.json');
  await writeFile(v1AnswersPath, JSON.stringify({ name: 'Update Project' }));
  await writeFile(v2AnswersPath, JSON.stringify({ name: 'Updated Name' }));
  return { templateDir, v1AnswersPath, v2AnswersPath };
}

describe('update command', () => {
  test('non-json update reports in-file conflicts without claiming success', async () => {
    const workspace = await makeFixtureWorkspace('cyanprint-cli-update-conflict-');
    const out = join(workspace, 'project');
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    try {
      const { templateDir, v1AnswersPath, v2AnswersPath } = await writeUpdateFixture(workspace);
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      console.error = (message?: unknown) => {
        errors.push(String(message));
      };

      await createCommand([templateDir, '--out', out, '--headless', '--answers', v1AnswersPath, '--json']);
      await writeFile(join(out, 'README.md'), '# User Edit\n\nKeep me.\n', 'utf8');

      // No --template required: update floats every active installed template.
      await expect(updateCommand([out, '--headless', '--answers', v2AnswersPath])).rejects.toThrow('update conflicted');

      expect(errors.join('\n')).toContain('update conflicted');
      expect(errors.join('\n')).toContain('README.md (in-file conflict markers)');
      expect(logs.some(line => line.includes(`updated ${out}`))).toBe(false);
      const readme = await Bun.file(join(out, 'README.md')).text();
      expect(readme).toContain('<<<<<<<');
      expect(readme).toContain('# User Edit');
      expect(readme).toContain('# Updated Name');
    } finally {
      console.log = originalLog;
      console.error = originalError;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('json update conflicts set a failing exit code', async () => {
    const workspace = await makeFixtureWorkspace('cyanprint-cli-update-json-conflict-');
    const out = join(workspace, 'project');
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExitCode = process.exitCode ?? 0;
    try {
      const { templateDir, v1AnswersPath, v2AnswersPath } = await writeUpdateFixture(workspace);
      process.exitCode = undefined;
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };

      await createCommand([templateDir, '--out', out, '--headless', '--answers', v1AnswersPath, '--json']);
      await writeFile(join(out, 'README.md'), '# User Edit\n\nKeep me.\n', 'utf8');

      await updateCommand([out, '--headless', '--answers', v2AnswersPath, '--json']);

      expect(Number(process.exitCode)).toBe(1);
      // Conflicts are plain paths: the markers live in the files themselves.
      expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({
        status: 'conflict',
        conflicts: ['README.md'],
      });
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('main update conflict prints the human error once', async () => {
    const workspace = await makeFixtureWorkspace('cyanprint-cli-main-update-conflict-');
    const out = join(workspace, 'project');
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalExitCode = process.exitCode ?? 0;
    try {
      const { templateDir, v1AnswersPath, v2AnswersPath } = await writeUpdateFixture(workspace);
      process.exitCode = undefined;
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      console.error = (message?: unknown) => {
        errors.push(String(message));
      };

      await createCommand([templateDir, '--out', out, '--headless', '--answers', v1AnswersPath, '--json']);
      await writeFile(join(out, 'README.md'), '# User Edit\n\nKeep me.\n', 'utf8');

      await main(['update', out, '--headless', '--answers', v2AnswersPath]);

      expect(Number(process.exitCode)).toBe(1);
      expect(errors.join('\n').match(/update conflicted/g)).toHaveLength(1);
      expect(errors.join('\n')).toContain('README.md (in-file conflict markers)');
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.exitCode = originalExitCode;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('create upserts into an existing project and update --template targets one installed template', async () => {
    const workspace = await makeFixtureWorkspace('cyanprint-cli-multi-install-');
    const out = join(workspace, 'project');
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExitCode = process.exitCode ?? 0;
    try {
      process.exitCode = undefined;
      const one = await writeTemplateFixture(workspace, {
        name: 'one',
        cyanTs: GREETING_CYAN_TS,
        files: { 'template/ONE.md': 'Greeting: __GREETING__\n' },
      });
      const two = await writeTemplateFixture(workspace, {
        name: 'two',
        cyanTs: GREETING_CYAN_TS,
        files: { 'template/TWO.md': 'Greeting: __GREETING__\n' },
      });
      const hiAnswersPath = join(workspace, 'answers-hi.json');
      const helloAnswersPath = join(workspace, 'answers-hello.json');
      await writeFile(hiAnswersPath, JSON.stringify({ greeting: 'hi' }));
      await writeFile(helloAnswersPath, JSON.stringify({ greeting: 'hello' }));
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };

      await createCommand([one, '--out', out, '--headless', '--answers', hiAnswersPath, '--json']);
      // Second create into the same directory upserts into .cyan_state.yaml (multi-install).
      await createCommand([two, '--out', out, '--headless', '--answers', hiAnswersPath, '--json']);
      expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({ status: 'done', conflicts: [] });
      expect(await Bun.file(join(out, 'ONE.md')).text()).toBe('Greeting: hi\n');
      expect(await Bun.file(join(out, 'TWO.md')).text()).toBe('Greeting: hi\n');
      const state = await Bun.file(join(out, '.cyan_state.yaml')).text();
      expect(state).toContain('name: one');
      expect(state).toContain('name: two');

      await expect(updateCommand([out, '--template', 'cyanprint/missing', '--headless', '--json'])).rejects.toThrow(
        'No active template matches',
      );

      // --template filters the update to one installed template; the other keeps its output.
      await updateCommand([out, '--template', 'cyanprint/two', '--headless', '--answers', helloAnswersPath, '--json']);
      expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({ status: 'done', conflicts: [] });
      expect(await Bun.file(join(out, 'TWO.md')).text()).toBe('Greeting: hello\n');
      expect(await Bun.file(join(out, 'ONE.md')).text()).toBe('Greeting: hi\n');
      expect(Number(process.exitCode ?? 0)).toBe(0);
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
      await rm(workspace, { recursive: true, force: true });
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

  test('template archives carry the probe surface additively', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'cyanprint-probe-archive-'));
    const templateDir = join(tempRoot, 'template');
    try {
      await mkdir(join(templateDir, 'template'), { recursive: true });
      await writeFile(
        join(templateDir, 'cyan.yaml'),
        'cyanprint: 4\nkind: template\nowner: cyanprint\nname: probe-archive\nbundledEntry: cyan.ts\n',
        'utf8',
      );
      await writeFile(join(templateDir, 'cyan.ts'), 'export default async () => ({});\n', 'utf8');
      await writeFile(join(templateDir, 'template/README.md'), '# Payload\n', 'utf8');

      // A template without probes publishes exactly today's payload — this entry
      // list is the additivity pin: probes must never change it.
      const bare = await createTemplateArchivePayload(templateDir, { bundledEntry: 'cyan.ts' });
      expect(readTemplateTarFiles(bare.payload).map(file => file.path)).toEqual(['template/README.md']);

      await mkdir(join(templateDir, 'probes'), { recursive: true });
      await writeFile(
        join(templateDir, 'probes/tests.ts'),
        'export default { contractVersion: 1, probes: [] };\n',
        'utf8',
      );
      await writeFile(join(templateDir, 'probes.yaml'), 'contractVersion: 1\nfeatures: []\n', 'utf8');

      // With probes present, probes/** and probes.yaml ride the artifact…
      const withProbes = await createTemplateArchivePayload(templateDir, { bundledEntry: 'cyan.ts' });
      const entries = readTemplateTarFiles(withProbes.payload);
      expect(entries.map(file => file.path)).toEqual(['probes.yaml', 'probes/tests.ts', 'template/README.md']);
      // …and pre-existing entries are byte-identical to the probe-free archive.
      const bareReadme = readTemplateTarFiles(bare.payload).find(file => file.path === 'template/README.md');
      const withProbesReadme = entries.find(file => file.path === 'template/README.md');
      expect(withProbesReadme?.bytes).toEqual(bareReadme?.bytes);
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
    const workspace = await makeFixtureWorkspace('cyanprint-cli-trace-group-');
    try {
      // The group declares its child in the templates: dictionary with embedded answers
      // (the presets: block is gone).
      const groupDir = await writeGroupFixture(workspace);
      const logs = await captureLogs(() => traceCommand([groupDir, '--headless', '--json']));
      const report = JSON.parse(logs.at(-1) ?? '{}');
      expect(report.tree?.ref).toBe('cyanprint/basic-group');
      expect(report.tree?.children?.[0]?.ref).toBe('cyanprint/hello');
      expect(Array.isArray(report.provenance)).toBe(true);
      expect(report.provenance.length).toBeGreaterThan(0);
      const paths = (report.provenance as Array<{ path: string }>).map(entry => entry.path);
      expect(paths).toContain('GROUP.md');
      expect(paths).toContain('README.md');
      expect(Array.isArray(report.diffs)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('traces a generated project from its persisted state provenance', async () => {
    const workspace = await makeFixtureWorkspace('cyanprint-cli-trace-project-');
    const dir = join(workspace, 'project');
    try {
      const groupDir = await writeGroupFixture(workspace);
      await createProject({ template: groupDir, outDir: dir, headless: true });
      // The project dir (with .cyan_state.yaml) is the target; --template overrides the
      // recorded source with the local template path so tree/diffs regenerate too.
      const logs = await captureLogs(() => traceCommand([dir, `--template=${groupDir}`, '--headless', '--json']));
      const report = JSON.parse(logs.at(-1) ?? '{}');
      expect(report.tree?.ref).toBe('cyanprint/basic-group');
      expect(report.provenance.length).toBeGreaterThan(0);

      // Provenance is read from .cyan_state.yaml, so it still prints when the template
      // cannot be regenerated — only the tree/diffs extras disappear.
      const stateOnly = await captureLogs(() =>
        traceCommand([dir, `--template=${join(workspace, 'missing-template')}`, '--headless', '--json']),
      );
      const stateReport = JSON.parse(stateOnly.at(-1) ?? '{}');
      expect(stateReport.tree).toBeUndefined();
      expect(stateReport.provenance.length).toBeGreaterThan(0);
      expect(stateReport.diffs).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
