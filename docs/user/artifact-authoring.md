# Artifact Authoring

CyanPrint artifacts are small folders with a `cyan.yaml`, a `README.md`, and a bundled TypeScript entry. Templates also carry a template archive so files stay folder-based instead of being inlined in code.

## Write Templates

Create a new artifact scaffold:

```bash
cyanprint create cyan/new my-template
```

For local development inside this repo:

```bash
cyanprint create in-tree/official/templates/new my-template
```

A template usually looks like this:

```text
my-template/
  cyan.yaml
  cyan.ts
  README.md
  template/
    package.json
    src/index.ts
```

The manifest identifies the artifact and declares the processors, plugins, resolvers, and child templates it may use:

```yaml
cyanprint: 4
kind: template
owner: cyan
name: app
bundledEntry: dist/cyan.js

processors:
  - cyan/default
resolvers:
  - cyanprint/keep-user
```

The `cyan.ts` script asks questions and returns pure data:

```ts
export default async function cyan(prompt, ctx) {
  const name = await prompt.text('project', 'Project name', { default: 'my-app' });

  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { NAME: name } },
      },
    ],
    resolvers: [{ name: 'cyanprint/keep-user', config: { paths: ['README.md'] } }],
  };
}
```

Use `type: 'Copy'` for binary assets or files that should not be rendered as text. Use `type: 'Template'` when files need prompt data.

## Write Runtime Artifacts

Each artifact imports the types it uses from `@cyanprint/sdk` (type-only — erased at bundle; the runtime injects the helper) and annotates its parameters:

```ts
import type {
  ProcessorInput,
  ProcessorFsHelper,
  PluginInput,
  PluginHelper,
  ResolverInput,
  ResolverOutput,
} from '@cyanprint/sdk';

export async function processor(input: ProcessorInput, fs: ProcessorFsHelper) {
  const files = await fs.read(); // VfsFile[] from inputDir
  await fs.write(
    files.map(file => (file.content === undefined ? file : { ...file, content: file.content.toUpperCase() })),
  );
}

export async function plugin(input: PluginInput, helper: PluginHelper) {
  await helper.exec('git init'); // runs in outputDir; throws on non-zero exit
  const files = await helper.read();
  await helper.write([...files, { path: 'PLUGIN.md', content: 'Generated\n' }]);
}

export async function resolver(input: ResolverInput): Promise<ResolverOutput> {
  // two files at a time: input is { path, config, current, next }
  return { path: input.next.path, content: `${input.current.content}\n${input.next.content}` };
}
```

Processors receive `(input, fs)` — `fs.read()` returns a VFS, `fs.write(files)` emits it (binary is preserved via `bytesBase64`). Plugins receive `(input, helper)` with `read()`/`write()`/`exec()`. Resolvers receive `{ path, config, current, next }` and merge two files at a time; CyanPrint folds N candidates by repeated calls (set `api: 2` in `cyan.yaml`). The raw `input.inputDir`/`input.outputDir` remain available as an escape hatch.

## Test

Every artifact can use `cyan.test.yaml` with input fixtures, expected output fixtures, and validation commands:

```bash
cyanprint test my-template
cyanprint test my-processor
cyanprint test my-resolver
```

Update expected output fixtures only when the expected output intentionally changes. The command still uses the `--update-snapshots` flag:

```bash
cyanprint test my-template --update-snapshots
```

## Publish

Run tests before publishing. Push validates the manifest, bundle, dependencies, object hashes, and upload refs:

```bash
CYANPRINT_TOKEN="<token>" cyanprint push my-template --registry https://registry.cyanprint.dev
```

The client uploads `cyan.yaml`, `README.md`, bundled script, and optional template archive as separate R2 objects. The registry finalizes the upload and assigns the next integer version in D1.

## Document

Each README should include:

- what the artifact does
- expected inputs and outputs
- dependencies and why they are needed
- create, update, and test examples
- compatibility notes for template output and resolver behavior
