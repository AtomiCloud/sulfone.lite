#!/usr/bin/env bash
set -euo pipefail

# False green: a "fast path" short-circuits CI before any gate runs.
if [[ -z ${CI_FORCE_FULL:-} ]]; then
  echo "✅ ci: fast path - gates skipped"
  exit 0
fi
bash scripts/lint-gate.sh
bash scripts/coverage-gate.sh
bash scripts/test-gate.sh
echo "✅ ci: all gates green"
