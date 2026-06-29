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
if [[ -n ${CYANPRINT_GITHUB_CLIENT_SECRET:-} ]]; then
  printf '%s' "$CYANPRINT_GITHUB_CLIENT_SECRET" | bunx wrangler secret put CYANPRINT_GITHUB_CLIENT_SECRET --config .tmp/cloudflare/worker.wrangler.toml
else
  printf '%s\n' 'CYANPRINT_GITHUB_CLIENT_SECRET not set locally; assuming existing Cloudflare Worker secret.'
fi
bunx wrangler d1 migrations apply DB --config .tmp/cloudflare/worker.wrangler.toml --remote
OPEN_NEXT_DEPLOY=true bunx wrangler deploy --config .tmp/cloudflare/worker.wrangler.toml

(
  cd apps/web
  bunx opennextjs-cloudflare build
  bunx opennextjs-cloudflare deploy --config ../../.tmp/cloudflare/web.wrangler.toml
)
