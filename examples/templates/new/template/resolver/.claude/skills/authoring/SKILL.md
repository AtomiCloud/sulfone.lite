---
name: cyanprint-resolver-authoring
description: Use when writing or editing this CyanPrint two-file resolver.
---

# Authoring a CyanPrint resolver (v4 two-file merge)

A resolver merges two files at a time. CyanPrint folds N conflicting candidates by calling it repeatedly in a deterministic order (layer ascending, then template name).

## Signature

Import the types you use from `@cyanprint/sdk` (type-only — the runtime calls your function):

```ts
import type { ResolverInput, ResolverOutput } from '@cyanprint/sdk';

export async function resolver(input: ResolverInput): Promise<ResolverOutput> {
  // input is { path, config, current, next }; current/next are { path, content, origin }
  return { path: input.next.path, content: merge(input.current.content, input.next.content) };
}
```

- Set `api: 2` in `cyan.yaml` to select this two-file API (the legacy folder-fold API is `api: 1`).
- The output of step N becomes `current` for step N+1; `next` is always the higher layer.
- If your merge is order-independent, set `commutative: true` in `cyan.yaml` and `cyanprint test` will enforce it.
- Resolvers are text-only; binary files are not merged.

## Rules

- Deterministic and side-effect free.
- Cover normal merges (and commutativity, if declared) in `cyan.test.yaml` (see the testing skill).
