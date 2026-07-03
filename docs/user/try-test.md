# Try And Test

`cyanprint try` runs a template into a scratch output folder.

`cyanprint test` runs local template/artifact tests and writes machine-readable reports for agents and CI.

## Template Tests

Templates use answers plus expected output folders, and assert merge decisions so every conflict is intentional:

```bash
cyanprint test examples/templates/hello
cyanprint test examples/templates/hello --update-snapshots
```

Template manifest example:

```yaml
cases:
  - name: full
    answers:
      name: Example
    deterministicState:
      slug: example
    expected: expected/full
    ignore: # excluded from folder compare (discouraged; document why per entry)
      - '*.lock' # lockfile churn is toolchain-version noise, not template output
    merges: # assert merge decisions — every conflict is intentional
      - path: package.json
        decision: resolver # resolver | lww
        resolver: cyanprint/json-merge
        segment: dependency
      - path: README.md
        decision: lww
        segment: processor
    validations:
      - bun install && bun test
```

Semantics:

- **Byte-for-byte compare.** Tree shape AND exact bytes (text and binary), excluding `ignore:` globs and paths matched by the output's own `.gitignore`. `.cyan_state.yaml` is always excluded.
- **`merges:` assertions** are checked against the merge provenance persisted in the generated `.cyan_state.yaml`. Each entry names a path, the expected `decision` (`resolver` or `lww`), and optionally the `resolver` ref and the `segment` (`processor` | `dependency` | `sibling`).
- **Strict by default.** Any `lww-override` in the persisted provenance that is not asserted in `merges:` fails the test. Attach a resolver or explicitly assert the LWW. A per-case `allowUnassertedLww: true` escape hatch exists but is discouraged — it hides unintentional overwrites.
- **`ignore:` is discouraged.** Every entry weakens the byte-for-byte guarantee; document why each one exists.
- Cover the meaningful combinations of answers across cases, and assert every expected merge decision so resolver use and LWW are always intentional.

`answers` and `deterministicState` may also be path strings, such as `answers: answers.json`.
Use `deterministicState` for seeded IDs, timestamps, slugs, or other reproducible values that a template reads through `ctx.deterministic`.
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

Resolver example — resolvers are invoked **once per conflicting path with all variations**, so cases list `variations:` with origins. Each variation is a file (or folder of files); every variation of a path reaches the resolver in a single call:

```yaml
cases:
  - name: merge
    variations:
      - { path: tests/merge/left, origin: { template: cyan/a@1, layer: 0 } }
      - { path: tests/merge/right, origin: { template: cyan/b@2, layer: 1 } }
    expected: tests/merge/expected
    config:
      strategy: deep
```

`origin` may also carry `processor: { ref, invocation }` to simulate tier-1 processor-output conflicts. Convention-based fixtures work too: `tests/<case>/input-1`, `input-2`, ... become variations layered by number. Ketone-style `test.cyan.yaml` fixtures with `resolver_inputs` remain supported for migrated resolvers.

Validation entries:

- A string entry is a full shell command run with `$SHELL -lc`.
- A mapping entry runs exact argv: `{ command: bun, args: [--eval, "..."] }`.
- A mapping may also use `{ shell: "command with pipes && redirects" }`.
- Commands run from the generated output directory.
- Processor, plugin, template, and resolver cases expose the whole output tree.
- Validation commands should inspect files, parse configs, run format checks, or execute project-local tools.

Run local artifact tests:

```bash
cyanprint test in-tree/official/processors/default
cyanprint test examples/artifacts/plugin-footer --report .tmp/plugin-report.json
cyanprint test examples/artifacts/resolver-keep-user --json
```

`cyan.test.yaml` is the standard test entrypoint because it names cases, points at custom files or folders, includes config, expected output, merge assertions, and validation commands.
