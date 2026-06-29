# Cloudflare Registry

The registry runs as a Hono app on Cloudflare Workers.

- D1 stores users, tokens, artifact metadata, versions, pins, likes, downloads, and audit state.
- R2 stores folder-first artifact objects: `cyan.yaml`, `README.md`, bundled runtime scripts, and template archives.
- KV is available for cacheable registry lookups.
- Local registry endpoint: `http://127.0.0.1:8787`.
- Release registry endpoint: `https://registry.cyanprint.dev`.

## Release resource names

Stable release names live in Wrangler config and can be overridden by GitHub org variables:

- Registry Worker: `cyanprint-registry`
- Registry D1 database: `cyanprint-registry`
- Registry R2 bucket: `cyanprint-registry-artifacts`
- Registry KV namespace: `cyanprint-registry`
- Web Worker: `cyanprint-web`
- Web OpenNext cache R2 bucket: `cyanprint-web-opennext-cache`

Cloudflare-generated IDs are not checked in.

For local deploys, log in once and run the release deploy task:

```bash
wrangler login
pls deploy:release
```

The task creates or finds the release D1 database, R2 buckets, and KV namespace by name, writes `.tmp/cloudflare/release.env`, renders Wrangler configs, applies remote D1 migrations, then deploys the registry Worker and web Worker.

To only create or discover the Cloudflare resources:

```bash
pls deploy:cloudflare:bootstrap
```

The GitHub release deploy workflow uses preconfigured IDs instead of bootstrapping. It expects:

- Secret: `CLOUDFLARE_API_TOKEN`
- Secret: `CLOUDFLARE_ACCOUNT_ID`
- Variable: `CYANPRINT_D1_DATABASE_ID`
- Variable: `CYANPRINT_KV_NAMESPACE_ID`

To create the release dependencies manually instead:

```bash
wrangler d1 create cyanprint-registry
wrangler r2 bucket create cyanprint-registry-artifacts
wrangler kv namespace create cyanprint-registry
wrangler r2 bucket create cyanprint-web-opennext-cache
```

- API tokens authorize push and publish flows.
- `POST /uploads/start` returns an upload id plus durable PUT URLs/object refs. The local Worker routes proxy PUT bytes into R2; production can swap these URLs for direct signed R2 PUT URLs without changing finalize metadata.
- Clients PUT object bytes to those URLs.
- `POST /uploads/finalize` validates hashes, sizes, manifest identity, dependency pins, required archive rules, and then commits metadata.
- D1 atomically allocates artifact versions during finalize; clients do not request or predict the next number.

No Worker route executes user code.
