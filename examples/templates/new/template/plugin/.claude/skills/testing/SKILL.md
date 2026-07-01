---
name: cyanprint-testing
description: Use when writing or running this artifact's tests (cyan.test.yaml).
---

# Testing this artifact

Tests live in `cyan.test.yaml` as cases. Each case generates output from a combination of answers/inputs, compares it against a stored expected output, and runs validation commands that must exit 0.

Processors and plugins use `input:` (a folder); resolvers use `resolverInputs:` (layered candidates):

```yaml
cases:
  # processor / plugin
  - name: basic
    input: tests/basic/input
    expected: tests/basic/expected
    validations:
      - grep -q Generated PLUGIN.md
  # resolver
  - name: merge
    resolverInputs:
      - { path: tests/merge/current, origin: { template: current, layer: 1 } }
      - { path: tests/merge/target, origin: { template: target, layer: 2 } }
    expected: tests/merge/expected
```

- Run `cyanprint test .` — add `--parallel N` to run many cases concurrently.
- After an intentional change, refresh stored output with `cyanprint test . --update-snapshots`.
- A case passes only when the output tree matches AND every validation command exits 0.
