# Quickstart

CyanPrint is a Bun-native registry and CLI for local-first project generation. Templates download from the registry, execute on your machine, and use pinned processors, plugins, and resolvers so creates and updates stay deterministic.

## Use CyanPrint

Install dependencies and run a template locally:

```bash
bun install
bun run cyan -- create examples/templates/hello .tmp/hello --headless --answers examples/templates/hello/answers.json --json
```

Search the registry — always search before building something new, and reuse what exists:

```bash
cyanprint search next
cyanprint search --kind template app
cyanprint search --kind resolver keep-user --json
```

Try a template without committing to an output directory:

```bash
cyanprint try examples/templates/hello
```

Create a project from a registry template:

```bash
cyanprint create cyan/new my-project
```

Update a generated project later — every installed template floats to latest (`--interactive` picks versions, `--template <ref>` targets one; needs `git` on PATH):

```bash
cyanprint update my-project
```

Publishers sign in through the web portal, mint an API token, then publish with:

```bash
CYANPRINT_TOKEN="<token>" cyanprint push my-template
```

## Artifact Roles

- **Templates** ask questions, read a folder-based template archive, and describe generated output.
- **Template groups** compose child templates into one install flow.
- **Processors** transform generated files after templates run, for example formatting. Processors are hermetic (pure functions of their inputs), so their outputs are cached.
- **Plugins** add or modify generated files after processors.
- **Resolvers** merge template-vs-template output during layering: when several templates (or processors) emit the same path, a resolver receives every variation in one call and returns the merged file. User edits are merged by git during update, not by resolvers.

Generation follows a fixed order — dependencies deepest-first, processors, plugins, three resolution tiers, commands — with one contract: same answers + deterministic state ⇒ byte-identical output. See [the pipeline](pipeline.md).

## Dependencies

Dependencies live in `cyan.yaml` as friendly refs; the section implies the kind. Child templates are a dictionary with embedded config; resolvers carry config and the file globs they merge:

```yaml
templates:
  cyanprint/auth: {}
processors:
  - cyan/default
resolvers:
  - ref: cyanprint/keep-user@7
    config: { paths: ['README.md'] }
    files: ['README.md']
```

Authors may omit versions. `cyanprint push` resolves omitted versions, pins exact integer versions, and the registry assigns the artifact version atomically.
