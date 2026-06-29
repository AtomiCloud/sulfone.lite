# Try And Test

`cyanprint try` runs a template into a scratch output folder.

`cyanprint test` runs local snapshots and writes machine-readable reports for agents and CI.

## Template Tests

Templates use answers plus snapshots:

```bash
cyanprint test examples/templates/hello
cyanprint test examples/templates/hello --answers examples/templates/hello/answers.json
cyanprint test examples/templates/hello --update-snapshots
```

By default, CyanPrint looks for `expected/README.md`, then falls back to `snapshots/basic/README.md`.
It also auto-loads `answers.json` from the template folder when present.

## Artifact Tests

Processors, plugins, and resolvers use `cyan.test.yaml`.

Processor or plugin example:

```yaml
cases:
  - name: basic
    input: tests/basic/input
    expected: tests/basic/expected
    config:
      parser: markdown
    validations:
      - path: README.md
        contains: '# Example'
      - path: README.md
        notContains: 'trailing spaces   '
```

Resolver example:

```yaml
cases:
  - name: current-wins
    prior: tests/current-wins/prior.txt
    current: tests/current-wins/current.txt
    target: tests/current-wins/target.txt
    expected: tests/current-wins/expected.txt
    validations:
      - contains: 'user edit'
```

Resolver folder example:

```yaml
cases:
  - name: folder-current-wins
    prior: tests/folder-current-wins/prior
    current: tests/folder-current-wins/current
    target: tests/folder-current-wins/target
    expected: tests/folder-current-wins/expected
    config:
      paths:
        - README.md
```

Validation fields:

- `path`: required for processor and plugin file validations.
- `exists`: checks that a file exists or does not exist.
- `equals`: checks exact text.
- `contains`: checks included text.
- `notContains`: checks rejected text.

Run local artifact tests:

```bash
cyanprint test in-tree/official/processors/default
cyanprint test examples/artifacts/plugin-footer --report .tmp/plugin-report.json
cyanprint test examples/artifacts/resolver-keep-user --json
```

`cyan.test.yaml` is the standard test entrypoint because it names cases, points at custom files or folders, includes config, and defines validations.
