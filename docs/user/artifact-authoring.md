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
export default async function cyan({ prompt }) {
  const name = await prompt.text('Project name');

  return {
    files: [
      {
        mode: 'template',
        base: 'template',
        glob: ['**/*'],
        data: { name },
        processors: [{ ref: 'cyan/default' }],
      },
    ],
  };
}
```

Use `mode: 'copy'` for binary assets or files that should not be rendered as text. Use `mode: 'template'` when files need prompt data.

## Write Runtime Artifacts

Processors, plugins, and resolvers use the same plain-function style:

```ts
export function processor(input) {
  return input.files;
}

export function plugin(input) {
  return input.files;
}

export function resolver(input) {
  const latest = input.files.at(-1);
  return latest?.content ?? '';
}
```

Processors and plugins receive `{ files, config }` and return a file map. Resolvers receive `{ files, config }`, where `files` is every version of the same path, then return the folded result.

## Test

Every artifact can use `cyan.test.yaml` with input fixtures, expected output fixtures, and validation commands:

```bash
cyanprint test my-template
cyanprint test my-processor
cyanprint test my-resolver
```

Update snapshots only when the expected output intentionally changes:

```bash
cyanprint test my-template --update-snapshots
```

## Publish

Run tests before publishing. Push validates the manifest, bundle, dependencies, object hashes, and upload refs:

```bash
cyanprint push my-template --registry https://registry.cyanprint.dev --token "$CYANPRINT_TOKEN"
```

The client uploads `cyan.yaml`, `README.md`, bundled script, and optional template archive as separate R2 objects. The registry finalizes the upload and assigns the next integer version in D1.

## Document

Each README should include:

- what the artifact does
- expected inputs and outputs
- dependencies and why they are needed
- create, update, and test examples
- compatibility notes for template output and resolver behavior
