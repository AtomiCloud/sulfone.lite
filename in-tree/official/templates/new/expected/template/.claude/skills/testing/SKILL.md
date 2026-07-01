---
name: cyanprint-testing
description: Use when writing or running this CyanPrint template's tests (cyan.test.yaml).
---

# Testing this template

Template tests live in `cyan.test.yaml` as cases. Each case generates the template with a combination of answers, compares the output tree against a stored `expected/` folder, and runs validation commands that must exit 0.

```yaml
cases:
  - name: basic
    answers: # inline object, or a path to a JSON answers file
      owner: acme
      name: my-template
      description: A CyanPrint v4 template.
    expected: expected/basic
    validations:
      - bun run build && cyanprint test . --json
```

- `answers` may be an inline mapping or a path to a JSON file; `deterministicState` is optional for deterministic prompts.
- Run `cyanprint test .` — add `--parallel N` to run many cases concurrently.
- After an intentional change, refresh stored output with `cyanprint test . --update-snapshots`.
- A case passes only when the output tree matches `expected/` AND every validation command exits 0.
