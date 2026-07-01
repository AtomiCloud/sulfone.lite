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
  return { path: input.next.path, content: `${input.current.content}\n${input.next.content}` };
}
```

Processors receive `(input, fs)`: `fs.read()` returns the input folder as a VFS, `fs.write(files)` writes the transformed tree to `outputDir`. Plugins receive `(input, helper)` after processor outputs have been merged, with `read()`/`write()`/`exec()`. Resolvers receive `{ path, config, current, next }` and merge two files at a time; the CLI folds N candidates by repeated calls (declare `api: 2` in `cyan.yaml`). Raw `input.inputDir`/`input.outputDir` stay available as an escape hatch.

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

Resolver test cases use files or folders:

- `tests/<case>/prior.txt` is optional.
- `tests/<case>/current.txt` is optional.
- `tests/<case>/target.txt` is optional.
- `tests/<case>/expected.txt` contains the expected resolved text.
- `tests/<case>/prior/`, `current/`, `target/`, and `expected/` are also supported for tree-based resolver tests.
- `tests/<case>/config.json` is optional.

Ketone-style resolver fixtures are also supported through `test.cyan.yaml` with `resolver_inputs`.

Use `--update-snapshots` to rewrite expected outputs from the current implementation.
