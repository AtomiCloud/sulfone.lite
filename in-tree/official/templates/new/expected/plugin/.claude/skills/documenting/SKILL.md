---
name: cyanprint-documenting
description: Use when writing or updating this plugin's README.
---

# Documenting this plugin

Keep `README.md` short and consumer-focused — it is how template authors who find this plugin through `cyanprint search` decide to adopt it. Your consumers are TEMPLATE AUTHORS: document the plugin from their side. It MUST cover:

- One-line purpose at the top: what the plugin does to a template's own layer.
- **The consumer snippet, copy-paste ready** — both halves a template needs:

  ```yaml
  # cyan.yaml
  plugins:
    - acme/license@1
  ```

  ```ts
  // cyan.ts — returned from the template's cyan function
  plugins: [
    {
      name: 'acme/license',
      config: { holder: 'ACME Corp', year: 2026 },
      files: [{ root: 'assets', glob: '**/*', type: 'Copy' }], // only if the plugin consumes archive files
    },
  ],
  ```

- **Every `config` option** — a table of: option, what it means, its default, an example value. The config IS your public API: document it as strictly as you validate it.
- **What it changes**: which files/paths the plugin adds or modifies, and any commands it runs (and that they are idempotent).
- A minimal example: config in → the resulting layer changes out.
- **Every dependency** declared in `cyan.yaml`, and why it is used.

Write for `cyanprint search`: the `cyan.yaml` `description` and the README wording are the search surface — use the words a template author with this need would actually type.

Keep it in sync with `cyan.yaml` (owner, name, description).
