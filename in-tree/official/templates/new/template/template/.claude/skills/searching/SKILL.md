---
name: cyanprint-searching
description: Use when choosing processor/plugin/resolver dependencies for this template.
---

# Finding dependencies

Search before you build: `cyanprint search <term>` (add `--kind template|template-group|processor|plugin|resolver` to filter) — reuse an existing artifact whenever one fits the need instead of authoring a new one.

- Prefer official `cyan/*` artifacts where they fit.
- Declare each chosen dependency in `cyan.yaml`: child templates in the `templates:` dictionary (optionally with embedded `answers`/`deterministicState`), processors/plugins in their lists, resolvers as `{ ref, config, files: [globs] }` entries.
- Leave versions off to track the latest (push pins them), or pin intentionally to hold an older version.
- Discoverability cuts both ways: name and describe your own artifact so others searching for the need find it.
