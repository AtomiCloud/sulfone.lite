---
name: cyanprint-resolver-authoring
description: Use when writing or editing this CyanPrint resolver's merge logic. Covers every resolver feature.
---

# Authoring a CyanPrint resolver

**Search the registry before designing** — `cyanprint search <term> --kind resolver` — and reuse an existing resolver when one fits. Design for discoverability too: name, describe (`cyan.yaml` `description`), and document this resolver so others searching for the need can find it.

A resolver merges every variation of one conflicting path in a **single call**. It runs during layering, whenever multiple layers emit the same path, at three tiers: a template's **processor** outputs, the **dependency** tree, and **sibling** installations in a multi-install project. Resolvers never run during `cyanprint update`'s three-way merge — git handles _user_ edits there; you merge _template-vs-template_ output only. This project was scaffolded by the meta template `cyan/new`; `cyanprint update . --template cyan/new` refreshes the scaffolding later.

## Signature

Import the types you use from `@cyanprint/sdk` (type-only, vendored — nothing to install):

```ts
import type { ResolverInput, ResolverOutput } from '@cyanprint/sdk';

export async function resolver(input: ResolverInput): Promise<ResolverOutput> {
  // input.files: ALL variations of one path, ordered by layer (last = highest)
  const latest = input.files[input.files.length - 1];
  return { path: latest.path, content: latest.content };
}
```

The vendored contract:

```ts
type FileOrigin = {
  template: string; // "owner/name@version"
  layer: number; // order within the resolution scope
  processor?: { ref: string; invocation: number }; // set for tier-1 (processor-output) variations
};
type ResolvedFile = { path: string; content: string; origin: FileOrigin };
type ResolverInput = { config: Record<string, unknown>; files: ResolvedFile[] };
type ResolverOutput = { path: string; content: string };
```

Any valid export form loads (const arrow, function expression, re-export); the named function declaration is the convention. Declaring more than one parameter is rejected — the runtime only passes `(input)`. There is no `api:` version or `commutative:` flag in `cyan.yaml` — this single-call contract is the only resolver API.

## How templates nominate you

Templates declare resolvers in `cyan.yaml` as entries with config and the file globs they merge:

```yaml
resolvers:
  - ref: acme/keep-latest@2
    config: { strategy: deep }
    files: ['package.json', '**/*.json']
```

For each path with more than one variation, every contributing template nominates the first `resolvers:` entry whose `files:` globs match. **Consensus** — all contributors nominate the same ref with identical config — means one call to you with all variations; anything else (none, disagreement) falls back to last-writer-wins by highest layer, recorded as an `lww-override`. Binary collisions always fall back to LWW.

- `input.config` is the agreed config from those declarations.
- `origin` tells you where each variation came from: template ref, layer, and — in the `processor` segment — the source processor's ref + invocation index. Use layers for deterministic ordering, never randomness or clocks.

## What makes a good resolver

- **Target the common shared files**: resolvers earn their keep on paths MANY templates predictably touch — package manifests (`package.json`), `.gitignore`, nix files, `CLAUDE.md`, `README.md`. Name and describe this resolver after the files it merges so template authors searching for them find it.
- **Consensus needs identical canonical config** — contributor configs are compared by canonical JSON serialization (object keys sorted), so keep the config surface small and canonical (few keys, stable defaults); every extra option is another way for consensus to fail into LWW.
- **Validate `input.config` first** and fail with an error naming the offending key and the expected shape.
- **Merge by meaning, not by text** where the format allows it (parse JSON/YAML and merge structurally); order deterministically by `origin.layer`, never by anything else.
- **Errors beat silent damage**: if the variations cannot be merged coherently, throw with a message naming the path and the conflict — a loud failure is recoverable, a mangled merge is not.

## Rules

- **Deterministic and side-effect free** — no filesystem, network, or global state. Same variations + config ⇒ byte-identical output; update's base regeneration depends on it.
- Handle any number of variations (2+), text only.
- Cover merges with `variations:` cases in `cyan.test.yaml`, covering each meaningful config shape (see the testing skill).
