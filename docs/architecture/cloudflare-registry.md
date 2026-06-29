# Cloudflare Registry

The registry runs as a Hono app on Cloudflare Workers.

- D1 stores users, tokens, artifact metadata, versions, pins, likes, downloads, and audit state.
- R2 stores folder-first artifact objects: `cyan.yaml`, `README.md`, bundled runtime scripts, and template archives.
- KV is available for cacheable registry lookups.
- API tokens authorize push and publish flows.
- `POST /uploads/start` returns an upload id plus durable PUT URLs/object refs. The local Worker routes proxy PUT bytes into R2; production can swap these URLs for direct signed R2 PUT URLs without changing finalize metadata.
- Clients PUT object bytes to those URLs.
- `POST /uploads/finalize` validates hashes, sizes, manifest identity, dependency pins, required archive rules, and then commits metadata.
- D1 atomically allocates artifact versions during finalize; clients do not request or predict the next number.

No Worker route executes user code.
