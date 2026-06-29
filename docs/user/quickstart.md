# Quickstart

Install Bun first.

```bash
bun install
bun run cyan -- create examples/templates/hello --out .tmp/hello --headless --answers examples/templates/hello/answers.json --json
```

CyanPrint v4 supports Bun and TypeScript only.

## Find Artifacts

Start the local registry, mint a local token, then search:

```bash
pls dev
pls token
cyanprint search next
cyanprint search --kind processor prettier
cyanprint search --kind resolver keep-user --json
```

Search covers templates, template groups, processors, plugins, and resolvers. The web UI uses the same artifact model and keeps search text, kind filters, and theme in the URL so links are shareable.

## Artifact Roles

- **Templates** generate project files from a folder-based template and `cyan.ts`.
- **Template groups** compose child templates into one install flow.
- **Processors** transform generated files after templates run, for example formatting.
- **Plugins** add or modify generated files, for example adding a footer.
- **Resolvers** decide update conflicts across prior, current, and target file states.

## Dependencies

Dependencies live in `cyan.yaml` as friendly refs:

```yaml
processors:
  - cyanprint/prettier
resolvers:
  - cyanprint/keep-user@7
```

Authors may omit versions. `cyanprint push` resolves omitted versions, pins exact integer versions, and the registry assigns the artifact version atomically.
