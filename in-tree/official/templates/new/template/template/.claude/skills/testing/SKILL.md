---
name: cyanprint-testing
description: Use when writing or running this CyanPrint template's tests (cyan.test.yaml).
---

# Testing this template

Template tests live in `cyan.test.yaml` as cases. Each case generates the template with a combination of answers, compares the output tree **byte-for-byte** against a stored `expected/` folder, checks the recorded merge decisions, and runs validation commands that must exit 0.

```yaml
cases:
  - name: basic
    answers: # inline object, or a path to a JSON answers file
      owner: acme
      name: my-template
      description: A CyanPrint v4 template.
    expected: expected/basic
    ignore: # globs excluded from the folder compare (discouraged; document why per entry)
      - '*.lock'
    merges: # assert merge decisions — every conflict is intentional
      - path: package.json
        decision: resolver # resolver | lww
        resolver: cyanprint/json-merge
        segment: dependency # processor | dependency
      - path: README.md
        decision: lww
        segment: processor
    validations:
      - bun run build && cyanprint test . --json
```

- `answers` may be an inline mapping or a path to a JSON file; `deterministicState` is optional for deterministic prompts.
- Cover the meaningful combinations of answers, and assert every expected merge decision in `merges:` so resolver use and LWW are always intentional.
- Merge assertions cover the **processor** and **dependency** segments only — template tests generate in isolation, so **sibling** collisions can never occur in a case.
- **Strict by default**: any `lww-override` in the generation's persisted provenance that is not asserted in `merges:` fails the case — attach a resolver or assert the LWW. A per-case `allowUnassertedLww: true` escape hatch exists but is discouraged.
- The folder compare is exact bytes AND tree shape, excluding `ignore:` globs and paths matched by the output's own `.gitignore`.
- Run `cyanprint test .` — add `--parallel N` to run many cases concurrently.
- After an intentional change, refresh stored output with `cyanprint test . --update-snapshots`.
- A case passes only when the output tree matches `expected/`, every merge assertion holds, AND every validation command exits 0.
