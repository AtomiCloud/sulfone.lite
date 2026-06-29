# Artifact Authoring

CyanPrint v4 has five artifact kinds:

- **template**: folder-based project generator.
- **template-group**: combines child templates.
- **processor**: transforms generated files after template output.
- **plugin**: adds or edits generated files after processors.
- **resolver**: handles update merges across prior, current, and target content.

## Create

Create a template from the built-in example:

```bash
cyanprint create examples/templates/new my-template
```

Create a runtime artifact by copying one of the examples:

```bash
cp -R examples/artifacts/processor-default my-processor
cp -R examples/artifacts/plugin-footer my-plugin
cp -R examples/artifacts/resolver-keep-user my-resolver
```

Every artifact needs `cyan.yaml`, `README.md`, and a bundled entry:

```yaml
cyanprint: 4
kind: processor
owner: cyanprint
name: prettier
bundledEntry: dist/index.js
```

Templates and template groups usually include an archive of their template folder. Processors, plugins, and resolvers can be script-only.

Runtime artifacts export one plain function:

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
  const latest = [...input.files].sort((left, right) => right.origin.layer - left.origin.layer)[0];
  return latest?.content ?? '';
}
```

Processors and plugins take `{ files, config }` and return a file map. Resolvers take `{ files, config }`, where `files` is an array of versions for the same path with `{ path, content, origin: { template, layer } }`. A resolver returns either resolved text or `{ path, content }`.

## Dependencies

Declare dependencies with user-friendly string refs. The section gives the kind:

```yaml
templates:
  - cyanprint/base
processors:
  - cyanprint/prettier
plugins:
  - cyanprint/footer
resolvers:
  - cyanprint/keep-user@7
```

Authors can omit versions. Push resolves omitted refs and pins exact integer versions. At runtime, CyanPrint rejects processors, plugins, resolvers, or child templates returned by `cyan.ts` unless they were declared in `cyan.yaml`.

## Update

Change source files, rebuild the bundled entry, then run tests:

```bash
bun run build
cyanprint test my-processor
```

For templates, update the snapshot when the intended output changes:

```bash
cyanprint test my-template --update-snapshots
```

For processors, plugins, and resolvers, update `cyan.test.yaml` and fixture folders together so the behavior stays reviewable.

## Push

Run `cyanprint test` before publishing. `push` validates the manifest, bundle, dependencies, object hashes, and upload refs:

```bash
cyanprint push my-processor --registry http://127.0.0.1:8787 --token "$CYANPRINT_TOKEN"
```

The client uploads `cyan.yaml`, `README.md`, bundled script, and optional archive as separate R2 objects. The registry finalizes the upload and atomically assigns the next integer version in D1.

## Document

Each README should include:

- what the artifact does
- expected inputs and outputs
- dependencies and why they are needed
- examples for create, update, or test
- compatibility notes for template output and resolver behavior

## Search

Search locally or against the registry:

```bash
cyanprint search auth
cyanprint search --kind template next
cyanprint search --kind resolver keep-user --json
```

The web UI uses the same registry data and keeps search state in the URL.
