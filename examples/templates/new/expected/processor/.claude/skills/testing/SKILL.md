---
name: cyanprint-testing
description: Use when writing or running this artifact's tests (cyan.test.yaml).
---

# Testing this artifact

Tests live in `cyan.test.yaml` as cases. Each case generates output from a combination of inputs, compares it against a stored expected output, and runs validation commands that must exit 0.

Processors and plugins use `input:` (a folder); resolvers use `variations:` — every contributor's file (or folder) with its origin, all passed to the resolver in ONE call per path:

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
    variations:
      - { path: tests/merge/input-1, origin: { template: acme/a@1, layer: 0 } }
      - { path: tests/merge/input-2, origin: { template: acme/b@1, layer: 1 } }
    expected: tests/merge/expected
```

- Resolver origins may also carry `processor: { ref, invocation }` to exercise tier-1 (processor-output) merges. Cover 3+ variations when merge order matters.
- Run `cyanprint test .` — add `--parallel N` to run many cases concurrently.
- After an intentional change, refresh stored output with `cyanprint test . --update-snapshots`.
- A case passes only when the output tree matches AND every validation command exits 0.
