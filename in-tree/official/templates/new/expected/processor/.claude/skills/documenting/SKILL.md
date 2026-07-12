---
name: cyanprint-documenting
description: Use when writing or updating this processor's README.
---

# Documenting this processor

Keep `README.md` short and consumer-focused — it is how template authors who find this processor through `cyanprint search` decide to adopt it. Your consumers are TEMPLATE AUTHORS: document the processor from their side. It MUST cover:

- One-line purpose at the top: what transform this processor applies to a scoped slice of a template's archive.
- **The consumer snippet, copy-paste ready** — both halves a template needs:

  ```yaml
  # cyan.yaml
  processors:
    - acme/uppercase@1
  ```

  ```ts
  // cyan.ts — inside the template's cyan function
  return {
    processors: [
      {
        name: 'acme/uppercase',
        files: [{ root: 'template', glob: '**/*.md', type: 'Template' }],
        config: { locale: 'en-US' },
      },
    ],
  };
  ```

- **Every `config` option** — a table of: option, what it means, its default, an example value. The config IS your public API: document it as strictly as you validate it. (Reference: for the official `cyan/default`, the config is `vars` — the substitution map — plus `parser.varSyntax` — the substitution tag pair.)
- **File-scope expectations**: which `type` the processor expects (`Template` for text, `Copy` passes through untouched), and what happens to files it does not transform.
- A minimal example: input files + config in → transformed files out.
- **Every dependency** declared in `cyan.yaml`, and why it is used.

Write for `cyanprint search`: the `cyan.yaml` `description` and the README wording are the search surface — use the words a template author with this need would actually type.

Keep it in sync with `cyan.yaml` (owner, name, description).
