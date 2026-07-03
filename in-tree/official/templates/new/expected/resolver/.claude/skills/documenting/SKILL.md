---
name: cyanprint-documenting
description: Use when writing or updating this artifact's README.
---

# Documenting this artifact

Keep `README.md` short and consumer-focused — it is how people who find this artifact through `cyanprint search` decide to adopt it. It MUST cover:

- One-line purpose at the top.
- **Every dependency** declared in `cyan.yaml` (templates, processors, plugins, resolvers) and why it is used.
- **Every input**: each answer key and config option — what it means, its default, and an example value.
- **Exactly how to use it**: for a template, the exact `cyanprint create owner/name <dir>` / `cyanprint update <dir>` invocations; for a processor, plugin, or resolver, the `cyan.yaml` snippet a template uses to reference it (resolvers include `config` and `files:` globs).
- A minimal example: the answers/config in, and the resulting output.

Keep it in sync with `cyan.yaml` (owner, name, description).
