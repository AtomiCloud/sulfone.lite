# Artifact Authoring

CyanPrint artifacts are small folders with a `cyan.yaml`, a `README.md`, and a bundled TypeScript entry. Templates also carry a template archive so files stay folder-based instead of being inlined in code.

Before designing a new artifact, **search the registry** (`cyanprint search <query>`, `--kind processor|plugin|resolver|template`) — reuse what exists, and name, describe, and document your artifact so others searching for the need can find it.

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

The manifest identifies the artifact and declares everything it composes. Child templates live in the `templates:` dictionary (with embedded per-dependency config); resolvers are list entries with config and the file globs they merge:

```yaml
cyanprint: 4
kind: template
owner: cyan
name: app
bundledEntry: dist/cyan.js

templates:
  cyanprint/auth: {} # just depend on it
  cyanprint/db:
    answers:
      flavor: postgres

processors:
  - cyan/default

resolvers:
  - ref: cyanprint/json-merge@2
    config: { strategy: deep }
    files: ['package.json', '**/*.json']
```

The section implies the artifact kind — there is no `kind` field in any dependency declaration. `resolvers:` is a list so the same resolver can appear twice with different config or globs; per path, the first entry whose `files:` globs match nominates.

The `cyan.ts` script asks questions and returns pure data — **only** `processors`, `plugins`, and `commands`. Returning `templates` or `resolvers` from `cyan.ts` is a hard error; both are declared in `cyan.yaml`:

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
  // ONE call per conflicting path, with EVERY variation of that path in scope.
  const [first] = input.files;
  return {
    path: first.path,
    content: input.files.map(file => file.content).join('\n'),
  };
}
```

Processors receive `(input, fs)` — `fs.read()` returns a VFS, `fs.write(files)` emits it (binary is preserved via `bytesBase64`). **Processors must be hermetic**: output is a pure function of (artifact version + integrity, config, input file set) — no network, clock, randomness, or machine state. Hermetic outputs are cached content-addressed, so repeated creates, tests, and update's base regeneration are near-instant.

Plugins receive `(input, helper)` with `read()`/`write()`/`exec()`.

Resolvers receive `{ config, files }` where `files` is **all variations** of one conflicting path, each `{ path, content, origin }` — `origin` is `{ template, layer, processor? }` (`processor` carries `{ ref, invocation }` for tier-1 processor-output conflicts). The resolver returns `{ path, content }`. There is no pairwise fold, no `current`/`next` pair, and no `api:` versioning — this is the only resolver interface. Resolvers merge template-vs-template output during layering; they never run in update's git three-way merge, which handles user edits.

The raw `input.inputDir`/`input.outputDir` remain available to processors and plugins as an escape hatch.

## Test

Every artifact can use `cyan.test.yaml` with input fixtures, expected output fixtures, and validation commands:

```bash
cyanprint test my-template
cyanprint test my-processor
cyanprint test my-resolver
```

Template tests compare byte-for-byte and assert merge decisions (`merges:`); any unasserted last-write-wins override fails the test. Resolver tests feed `variations:` — a list of `{ path, origin }` entries all passed to the resolver in one call. See [try-test.md](try-test.md).

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

Each README must cover, at minimum:

1. **Every dependency used, with why.** For each entry in `templates:`, `processors:`, `plugins:`, and `resolvers:`: what it does in this artifact and why it is needed (e.g. "`cyan/default` renders the archive with prompt variables"; "`cyanprint/json-merge` merges `package.json` when this template composes with others").
2. **Every input, with meaning and examples.** For each answer key and deterministic-state key: what it means, its type/allowed values, and at least one example value. For processors/plugins/resolvers, document every `config` key the same way.
3. **Exact usage.** The precise invocations a user runs — `cyanprint create <ref> <dir>` and `cyanprint update <dir>` for templates, or how a template references the processor/plugin/resolver from `cyan.yaml` and `cyan.ts` for runtime artifacts.

Also worth including: what the artifact does (one paragraph, written so registry search finds it), expected outputs, and compatibility notes.
