---
name: cyanprint-resolver-authoring
description: Use when writing or editing this CyanPrint two-file resolver. Covers every resolver feature, including update conflict handling.
---

# Authoring a CyanPrint resolver (v4 two-file merge)

A resolver merges two files at a time. It is used in **two places**:

1. **Create time** — when sibling templates in a composition emit the same path and both sides declare this resolver (identical config), CyanPrint folds the candidates instead of last-writer-wins.
2. **Update time** — when `cyanprint update` finds a file the user edited AND the template changed, a resolver scoped to that path merges the change instead of dumping a conflict into `.cyan_conflicts/`.

That second role makes resolvers the key to **update-friendly templates**: templates attach a resolver (like `cyanprint/keep-user`) to user-editable paths so downstream updates merge cleanly. This project was scaffolded by the meta template `cyan/new`; `cyanprint update . --template cyan/new` refreshes the scaffolding later.

## Signature

Import the types you use from `@cyanprint/sdk` (type-only, vendored — nothing to install):

```ts
import type { ResolverInput, ResolverOutput } from '@cyanprint/sdk';

export async function resolver(input: ResolverInput): Promise<ResolverOutput> {
  // input is { path, config, current, next }; current/next are { path, content, origin }
  return { path: input.next.path, content: merge(input.current.content, input.next.content) };
}
```

Any valid export form loads (const arrow, function expression, re-export); the named function declaration is the convention. Declaring more than one parameter is rejected — the runtime only passes `(input)`.

## Fold semantics

- CyanPrint folds N conflicting candidates by calling you repeatedly in a deterministic order (layer ascending, then template name). The output of step N becomes `current` for step N+1; `next` is always the higher layer.
- Set `api: 2` in `cyan.yaml` to select this two-file API (the legacy folder-fold API is `api: 1`).
- If your merge is order-independent, declare `commutative: true` in `cyan.yaml` — `cyanprint test` then enforces it over every candidate pair.
- Resolvers are **text-only**; binary collisions fall back to last-writer-wins with a recorded conflict.

## How templates use you

- Unscoped use applies to every colliding path; `config: { paths: ['README.md'] }` scopes it.
- A create-time merge only happens when BOTH colliding sides declare exactly this resolver with identical config — otherwise last-writer-wins.
- `input.config` carries the template's config plus the current `path`.

## Rules

- **Deterministic and side-effect free** — no filesystem, network, or global state.
- Design merges that respect user intent (keep user content, take template structure) — you are the update-conflict story.
- Cover normal merges (and commutativity, if declared) in `cyan.test.yaml` (see the testing skill).
