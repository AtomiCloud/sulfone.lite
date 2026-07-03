# Bundle Artifacts

Processors, plugins, and resolvers are CyanPrint Registry artifacts.

Each artifact must include:

- `cyan.yaml`
- `README.md`
- one Bun-compatible bundled runtime file named by `bundledEntry`

The bundle exposes one named function based on artifact kind. Author-facing types come from `@cyanprint/sdk`; the runtime injects a helper as the second argument:

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
  const files = await fs.read();
  await fs.write(
    files.map(file => (file.content === undefined ? file : { ...file, content: file.content.toUpperCase() })),
  );
}

export async function plugin(input: PluginInput, helper: PluginHelper) {
  await helper.exec('git init');
  const files = await helper.read();
  await helper.write([...files, { path: 'PLUGIN.md', content: 'Generated\n' }]);
}

export async function resolver(input: ResolverInput): Promise<ResolverOutput> {
  // One call per conflicting path; input.files holds EVERY variation with its origin.
  const winner = input.files[input.files.length - 1];
  return { path: winner.path, content: winner.content };
}
```

Processors receive `(input, fs)`: `fs.read()` returns the input folder as a VFS, `fs.write(files)` writes the transformed tree to `outputDir`. Processors must be **hermetic** — output is a pure function of (artifact version + integrity, config, input file set); no network, clock, randomness, or machine state. Hermetic outputs are cached content-addressed under `~/.cyan/cache/processor-output/`, and a cache hit skips the invocation.

Plugins receive `(input, helper)` after the template's processor outputs have been resolved into a single layer, with `read()`/`write()`/`exec()`.

Resolvers receive `{ config, files }` — **all variations of one conflicting path in a single call**, each variation `{ path, content, origin: { template, layer, processor? } }` — and return `{ path, content }`. There is no pairwise fold, no `current`/`next` pair, no `api:` field, and no `commutative` flag; manifests that still declare `api:` or `commutative:` are rejected. Resolvers are declared in a template's `cyan.yaml` as `{ ref, config, files }` entries, where `files:` globs decide which paths the entry nominates for.

Raw `input.inputDir`/`input.outputDir` stay available to processors and plugins as an escape hatch.

```yaml
cyanprint: 4
kind: processor
owner: cyanprint
name: prettier
bundledEntry: dist/index.js
```

## Standard Artifact Tests

Run local artifact tests with:

```bash
cyanprint test <artifact-dir>
```

Processor and plugin test cases use folders:

- `tests/<case>/input/` contains the input file tree.
- `tests/<case>/expected/` contains the expected output file tree.
- `tests/<case>/config.json` is optional.

Resolver test cases use `variations:` in `cyan.test.yaml` — a list of `{ path, origin }` entries; every variation of a path reaches the resolver in one call:

```yaml
cases:
  - name: merge
    variations:
      - { path: tests/merge/left, origin: { template: cyan/a@1, layer: 0 } }
      - { path: tests/merge/right, origin: { template: cyan/b@2, layer: 1 } }
    expected: tests/merge/expected
```

- Each `path` may be a file or a folder tree.
- `origin` carries `template` and `layer`, plus optional `processor: { ref, invocation }` for tier-1 conflicts.
- Convention-based fixtures also work: `tests/<case>/input-1`, `input-2`, ... become variations layered by number, with `tests/<case>/expected/` as the expected output.
- `tests/<case>/config.json` is optional.

Ketone-style resolver fixtures are also supported through `test.cyan.yaml` with `resolver_inputs`.

Use `--update-snapshots` to rewrite expected outputs from the current implementation.
