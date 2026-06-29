#!/usr/bin/env bash
set -euo pipefail

bun run scripts/cloudflare/render-release-configs.ts
bunx wrangler d1 migrations apply DB --config .tmp/cloudflare/worker.wrangler.toml --remote
bunx wrangler deploy --config .tmp/cloudflare/worker.wrangler.toml

(
  cd apps/web
  bunx opennextjs-cloudflare build
  bunx opennextjs-cloudflare deploy --config ../../.tmp/cloudflare/web.wrangler.toml
)
