# CyanPrint v4 Monorepo

CyanPrint v4 lives in one Bun/TypeScript monorepo.

- `packages/contracts`: shared manifests, script contracts, registry schemas, and errors.
- `packages/core`: local execution, create, update, merge, trust, cache, and tests.
- `packages/cli`: default interactive CLI over the headless core.
- `packages/artifact-bundler`: Bun single-file artifact bundle builder.
- `packages/artifact-runner`: processor, plugin, and resolver runtime contracts.
- `packages/registry-client`: local registry client and deterministic registry simulation helpers.
- `apps/worker`: Hono/Wrangler Cloudflare Worker registry boundary.
- `apps/web`: redesigned Next.js registry UI.

The Worker stores and resolves metadata. It never executes templates or artifact bundles.
