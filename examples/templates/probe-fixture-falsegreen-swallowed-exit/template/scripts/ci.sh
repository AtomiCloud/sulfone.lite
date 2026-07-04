#!/usr/bin/env bash
set -euo pipefail

# The repo's single CI entrypoint: every gate must pass.
bash scripts/lint-gate.sh
bash scripts/coverage-gate.sh
bash scripts/test-gate.sh
echo "✅ ci: all gates green"
