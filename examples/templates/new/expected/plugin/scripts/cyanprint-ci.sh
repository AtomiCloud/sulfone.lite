#!/usr/bin/env bash
set -euo pipefail

if ! command -v cyanprint >/dev/null 2>&1; then
  printf 'deb [trusted=yes] https://apt.fury.io/atomicloud/ /\n' | sudo tee /etc/apt/sources.list.d/atomicloud-gemfury.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y cyanprint
fi

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if [ -f package.json ]; then
  if [ -f bun.lock ] || [ -f bun.lockb ]; then
    bun install --frozen-lockfile
  else
    bun install
  fi
fi

if [ -f package.json ] && bun --eval 'const p = await Bun.file("package.json").json(); process.exit(p.scripts?.build ? 0 : 1)'; then
  bun run build
elif [ -f src/index.ts ]; then
  mkdir -p dist
  bun build ./src/index.ts --target bun --format esm --outfile ./dist/index.js
elif [ -f cyan.ts ]; then
  mkdir -p .cyanprint-build
  bun build ./cyan.ts --target bun --format esm --outfile ./.cyanprint-build/cyan.js
fi

cyanprint test .

if [ "${GITHUB_EVENT_NAME:-}" = "push" ] && [ "${GITHUB_REF:-}" = "refs/heads/main" ]; then
  if [ -z "${CYANPRINT_TOKEN:-}" ]; then
    echo "CYANPRINT_TOKEN secret is required to publish."
    exit 1
  fi
  cyanprint push .
fi
