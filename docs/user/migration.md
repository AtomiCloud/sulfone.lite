# Migration

CyanPrint v4 keeps the product name and bumps the version to `4.0.0`.

Templates move metadata into `cyan.yaml` and keep behavior in lightweight TypeScript `cyan.ts` scripts.

Docker, coordinator daemon, public npm runtime artifacts, and server execution are replaced by local execution and R2-backed registry downloads.

Archive parity is intentionally scoped to templates and template-groups only. Runtime artifacts are bundled scripts; template archives are folder-first payloads so existing template folders and assets need minimal changes.

Legacy Ketone-style resolvers can migrate first without rewriting their runtime shape. CyanPrint v4 accepts resolver bundles that import `StartResolverWithLambda` from `@atomicloud/cyan-sdk`, and `cyanprint test` understands `test.cyan.yaml` fixtures with `resolver_inputs`. New resolvers should prefer the plain `export function resolver(input)` fold interface, but the compatibility path lets existing Ketone resolvers run while you update packaging.
