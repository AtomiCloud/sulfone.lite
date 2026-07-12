---
name: cyanprint-documenting
description: Use when writing or updating this resolver's README.
---

# Documenting this resolver

Keep `README.md` short and consumer-focused — it is how template authors who find this resolver through `cyanprint search` decide to adopt it. Your consumers are TEMPLATE AUTHORS nominating you in their `cyan.yaml`: document the resolver from their side. It MUST cover:

- One-line purpose at the top: what merge strategy this resolver applies, to which kind of files.
- **The consumer snippet, copy-paste ready** — the `resolvers:` entry a template adds, with `config` and `files:` globs:

  ```yaml
  # cyan.yaml
  resolvers:
    - ref: acme/json-merge@2
      config: { strategy: deep }
      files: ['package.json', '**/*.json']
  ```

  Remind consumers that a resolver only runs on **consensus** — every contributor must nominate the same ref with identical `config`, otherwise the path falls back to last-writer-wins.

- **Every `config` option** — a table of: option, what it means, its default, an example value. The config IS your public API, and consensus compares it byte-for-byte: document it as strictly as you validate it.
- **The merge semantics**: how variations combine (ordering, conflicts within the merge, how `origin` layers are used) and any inputs it rejects (binary is never resolver-merged).
- A minimal example: two (or more) variations in → the merged output out.
- **Every dependency** declared in `cyan.yaml`, and why it is used.

Write for `cyanprint search`: the `cyan.yaml` `description` and the README wording are the search surface — use the words a template author with this need would actually type (e.g. the file names you merge: "package.json merge", "gitignore union").

Keep it in sync with `cyan.yaml` (owner, name, description).
