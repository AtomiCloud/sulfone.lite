---
name: cyanprint-resolver-authoring
description: Use when writing or editing this CyanPrint resolver's merge logic.
---

# Authoring a CyanPrint resolver

Search the registry before designing — `cyanprint search <term>` — reuse what exists, and name/describe this resolver so others searching for the need can find it.

A resolver merges every variation of one conflicting path in a single call. CyanPrint invokes it during layering when all contributing templates nominate it (same ref, identical config) through their `resolvers:` entries' `files:` globs; otherwise the highest layer wins (recorded as an lww-override). It never runs during `cyanprint update` — git merges user edits there.

## Signature

Import the types you use from `@cyanprint/sdk` (type-only — the runtime calls your function):

```ts
import type { ResolverInput, ResolverOutput } from '@cyanprint/sdk';

export async function resolver(input: ResolverInput): Promise<ResolverOutput> {
  // input is { config, files }; files are ALL variations of one path: { path, content, origin }
  const latest = input.files[input.files.length - 1];
  return { path: latest.path, content: latest.content };
}
```

- `input.files` is ordered by layer; the last entry is the highest layer. `origin` is `{ template, layer, processor? }`.
- One call per conflicting path — handle any number of variations (2+).
- Resolvers are text-only; binary files are not merged.

## What makes a good resolver

- **Target the common shared files**: resolvers earn their keep on paths MANY templates predictably touch — package manifests (`package.json`), `.gitignore`, nix files, `CLAUDE.md`, `README.md`. Name and describe this resolver after the files it merges so template authors searching for them find it.
- **Consensus is byte-strict on config** — contributors must nominate identical config, so keep the config surface small and canonical (few keys, stable defaults); every extra option is another way for consensus to fail into LWW.
- **Validate `input.config` first** and fail with an error naming the offending key and the expected shape.
- **Merge by meaning, not by text** where the format allows it (parse JSON/YAML and merge structurally); order deterministically by `origin.layer`, never by anything else.
- **Errors beat silent damage**: if the variations cannot be merged coherently, throw with a message naming the path and the conflict — a loud failure is recoverable, a mangled merge is not.

## Rules

- Deterministic and side-effect free.
- Cover merges with `variations:` cases in `cyan.test.yaml` (see the testing skill).
