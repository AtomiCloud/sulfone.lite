---
name: cyanprint-documenting
description: Use when writing or updating this template's README.
---

# Documenting this template

Keep `README.md` short and consumer-focused — it is how people who find this template through `cyanprint search` decide to adopt it. It MUST cover:

- One-line purpose at the top.
- **Every dependency** declared in `cyan.yaml` (templates, processors, plugins, resolvers) and why it is used.
- **Every input**: each answer key — what it means, its default, and an example value.
- **Every feature**: each feature the template can declare, mapped to the answer(s)/input(s) that enable it — a consumer must be able to see which answers produce which promises.
- **Exactly how to use it**: the exact `cyanprint create owner/name <dir>` and `cyanprint update <dir>` invocations.
- A minimal example: the answers in, and the resulting output.

Write for `cyanprint search`: the `cyan.yaml` `description` and the README wording are the search surface — use the words someone with this need would actually type.

Keep it in sync with `cyan.yaml` (owner, name, description).
