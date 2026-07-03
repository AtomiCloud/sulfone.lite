# Push

`cyanprint push` validates a template, template group, processor, plugin, or resolver.

Every artifact declares `kind`, `owner`, `name`, and `bundledEntry`. `kind` describes the artifact itself; dependency declarations never carry a kind — the `cyan.yaml` section implies it.

Processors and plugins are string lists; child templates are a dictionary whose values embed per-dependency config; resolvers are entries with config and the file globs they merge:

```yaml
templates:
  cyanprint/auth: {}
  cyanprint/db:
    answers:
      flavor: postgres

processors:
  - cyan/default
  - cyanprint/eslint-fix@3

resolvers:
  - ref: cyanprint/json-merge@2
    config: { strategy: deep }
    files: ['package.json', '**/*.json']
```

At author time, dependency refs do not need versions. Push resolves names to exact registry integer versions, computes integrity, and sends the pinned graph to the Worker for independent validation.

Artifact versions are assigned by the registry during finalize. The CLI starts an upload session, uploads separate object refs for `cyan.yaml`, `README.md`, the bundled script, and a template archive when required, then asks the Worker to finalize the upload. D1 atomically allocates the next integer version during finalize; the client never sends `id` or `version`.

Templates and template groups are folder-first. Their archive is extracted into `~/.cyan/cache/...`, then the bundled script runs locally. Processors, plugins, and resolvers require a bundled script; an archive is optional.

## Publish Flow

```bash
CYANPRINT_TOKEN="<token>" cyanprint push in-tree/official/processors/default --registry http://127.0.0.1:8787
CYANPRINT_TOKEN="<token>" cyanprint push examples/artifacts/plugin-footer --registry http://127.0.0.1:8787
CYANPRINT_TOKEN="<token>" cyanprint push examples/artifacts/resolver-keep-user --registry http://127.0.0.1:8787
CYANPRINT_TOKEN="<token>" cyanprint push in-tree/official/templates/new --registry http://127.0.0.1:8787
```

Use the same command for create, update, and republish. The server assigns the next integer version during finalize, so authors never edit a version field.

## Documentation

Every artifact should include:

- `cyan.yaml` for identity, kind, bundled entry, and dependency refs.
- `README.md` for what it does, inputs, outputs, and examples.
- `cyan.test.yaml` for artifact tests when the artifact is a processor, plugin, or resolver.
- Expected output fixtures for templates and template groups.

Dependencies should explain why they exist. A template that declares `processors: [cyan/default]` should say that generated files are rendered and normalized after generation. A template that declares a resolver should say which same-path template-vs-template merges it handles (which `files:` globs, and what the merge produces). Document every answer and config key with its meaning and an example, plus the exact `cyanprint create`/`cyanprint update` invocations — see the Document checklist in [artifact-authoring.md](artifact-authoring.md).
