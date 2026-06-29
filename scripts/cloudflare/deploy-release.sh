#!/usr/bin/env bash
set -euo pipefail

if [[ ${CYANPRINT_SKIP_RESOURCE_BOOTSTRAP:-0} != "1" ]]; then
  bun run scripts/cloudflare/ensure-release-resources.ts
fi

if [[ -f .tmp/cloudflare/release.env ]]; then
  # shellcheck disable=SC1091
  source .tmp/cloudflare/release.env
fi

bun run scripts/cloudflare/render-release-configs.ts
bunx wrangler d1 migrations apply DB --config .tmp/cloudflare/worker.wrangler.toml --remote
OPEN_NEXT_DEPLOY=true bunx wrangler deploy --config .tmp/cloudflare/worker.wrangler.toml

(
  cd apps/web
  bunx opennextjs-cloudflare build
  bunx opennextjs-cloudflare deploy --config ../../.tmp/cloudflare/web.wrangler.toml
)
