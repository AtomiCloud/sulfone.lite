# Bundle Artifacts

Processors, plugins, and resolvers are CyanPrint Registry artifacts.

Each artifact must include:

- `cyan.yaml`
- `README.md`
- one Bun-compatible bundled runtime file named by `bundledEntry`

The bundle exposes one named function based on artifact kind:

```ts
export function processor(input) {
  const { files } = input;
  return files;
}

export function plugin(input) {
  const { files } = input;
  return files;
}

export function resolver(input) {
  const sorted = [...input.files].sort(
    (left, right) =>
      left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template),
  );
  return sorted.map(file => file.content.trimEnd()).join('\n') + '\n';
}
```

Processors and plugins receive `{ files, config }`, then return the next file map. Resolvers receive `{ files, config }`, where `files` is an array of `{ path, content, origin: { template, layer } }` entries for one output path. Resolvers fold that array and return resolved text or `{ path, content }`.

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
