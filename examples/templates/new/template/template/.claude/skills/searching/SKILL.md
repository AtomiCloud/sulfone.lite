---
name: cyanprint-searching
description: Use when choosing processor/plugin/resolver dependencies for this template.
---

# Finding dependencies

- `cyanprint search <term> --kind template|template-group|processor|plugin|resolver` to discover artifacts.
- Prefer official `cyan/*` artifacts where they fit.
- Declare each chosen dependency in `cyan.yaml` under `processors` / `plugins` / `resolvers`.
- Leave versions off to track the latest (push pins them), or pin intentionally to hold an older version.
