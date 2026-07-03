# Migration

CyanPrint v4 keeps the product name and bumps the version to `4.0.0`.

Templates move metadata into `cyan.yaml` and keep behavior in lightweight TypeScript `cyan.ts` scripts.

Docker, coordinator daemon, public npm runtime artifacts, and server execution are replaced by local execution and R2-backed registry downloads.

Archive parity is intentionally scoped to templates and template-groups only. Runtime artifacts are bundled scripts; template archives are folder-first payloads so existing template folders and assets need minimal changes.

Legacy Ketone-style resolvers can migrate first without rewriting their packaging. CyanPrint v4 accepts resolver bundles that import `StartResolverWithLambda` from `@atomicloud/cyan-sdk`, and `cyanprint test` still understands `test.cyan.yaml` fixtures with `resolver_inputs`.

The resolver runtime interface itself is single-shape: `export function resolver(input)` receives `{ config, files }` — **one call per conflicting path with all variations of that path** (each `{ path, content, origin }`) — and returns `{ path, content }`. The earlier two-file fold interface (`current`/`next` pairs called repeatedly) and the `api:` field in `cyan.yaml` are gone; a manifest that still declares `api:` (or `commutative:`, or `presets:`) is rejected with a pointed error. Resolvers now run only during layering (merging template-vs-template output); update conflicts are handled by a git three-way merge with in-file conflict markers, not by resolvers or `.cyan_conflicts` side files.
