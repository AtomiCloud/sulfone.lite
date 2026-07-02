# Quickstart

CyanPrint is a Bun-native registry and CLI for local-first project generation. Templates download from the registry, execute on your machine, and use pinned processors, plugins, and resolvers so creates and updates stay deterministic.

## Use CyanPrint

Install dependencies and run a template locally:

```bash
bun install
bun run cyan -- create examples/templates/hello .tmp/hello --headless --answers examples/templates/hello/answers.json --json
```

Search the registry:

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

Update a generated project later:

```bash
cyanprint update my-project --template cyan/new
```

Publishers sign in through the web portal, mint an API token, then publish with:

```bash
CYANPRINT_TOKEN="<token>" cyanprint push my-template
```

## Artifact Roles

- **Templates** ask questions, read a folder-based template archive, and describe generated output.
- **Template groups** compose child templates into one install flow.
- **Processors** transform generated files after templates run, for example formatting.
- **Plugins** add or modify generated files after processors.
- **Resolvers** fold same-path outputs or update conflicts into one result.

## Dependencies

Dependencies live in `cyan.yaml` as friendly refs:

```yaml
processors:
  - cyan/default
resolvers:
  - cyanprint/keep-user@7
```

Authors may omit versions. `cyanprint push` resolves omitted versions, pins exact integer versions, and the registry assigns the artifact version atomically.
