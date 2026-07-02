# Try And Test

`cyanprint try` runs a template into a scratch output folder.

`cyanprint test` runs local template/artifact tests and writes machine-readable reports for agents and CI.

## Template Tests

Templates use answers plus expected output folders:

```bash
cyanprint test examples/templates/hello
cyanprint test examples/templates/hello --update-snapshots
```

Template manifest example:

```yaml
cases:
  - name: basic
    answers:
      name: Example
    deterministicState:
      slug: example
    expected: expected/basic
```

`answers` and `deterministicState` may also be path strings, such as `answers: answers.json`.
Use `deterministicState` for seeded IDs, timestamps, slugs, or other reproducible values that a template reads through `ctx.deterministic`.
`.cyan_state.yaml` is written to real generated projects, but it is excluded from template expected-output comparisons and expected fixture updates.
Use `validations` only for checks the expected folder cannot prove, such as running a tool, checking `.cyan_state.yaml`, or executing project commands.

## Artifact Tests

Templates, processors, plugins, and resolvers use `cyan.test.yaml`.

Each case follows the same lifecycle:

1. Build the input fixture.
2. Run the template, processor, plugin, or resolver.
3. Compare the output to `expected` byte for byte.
4. Run every command in `validations` from the output folder.
5. Fail the case if any validation command exits non-zero.

Processor or plugin example:

```yaml
cases:
  - name: basic
    input: tests/basic/input
    expected: tests/basic/expected
    config:
      parser: markdown
    validations:
      - bun --eval 'JSON.parse(await Bun.file("package.json").text())'
```

Resolver example (v4 two-file API). Prefer `resolverInputs` to name the layers explicitly, or use `prior`/`current`/`target` text files:

```yaml
cases:
  - name: merge
    resolverInputs:
      - { path: tests/merge/current, origin: { template: current, layer: 1 } }
      - { path: tests/merge/target, origin: { template: target, layer: 2 } }
    expected: tests/merge/expected
  - name: current-wins
    prior: tests/current-wins/prior.txt
    current: tests/current-wins/current.txt
    target: tests/current-wins/target.txt
    expected: tests/current-wins/expected.txt
    validations:
      - grep -q 'user edit' output.txt
```

Resolver folder example (legacy `api: 1` folder-fold, supported for compatibility):

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

Validation entries:

- A string entry is a full shell command run with `$SHELL -lc`.
- A mapping entry runs exact argv: `{ command: bun, args: [--eval, "..."] }`.
- A mapping may also use `{ shell: "command with pipes && redirects" }`.
- Commands run from the generated output directory.
- Resolver text cases expose the folded text as `output.txt`.
- Processor, plugin, template, and resolver folder cases expose the whole output tree.
- Validation commands should inspect files, parse configs, run format checks, or execute project-local tools.

Run local artifact tests:

```bash
cyanprint test in-tree/official/processors/default
cyanprint test examples/artifacts/plugin-footer --report .tmp/plugin-report.json
cyanprint test examples/artifacts/resolver-keep-user --json
```

`cyan.test.yaml` is the standard test entrypoint because it names cases, points at custom files or folders, includes config, expected output, and validation commands.
