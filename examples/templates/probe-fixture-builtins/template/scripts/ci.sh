#!/usr/bin/env bash
set -euo pipefail

# The repo's single CI entrypoint: every gate must pass.
bash scripts/lint.sh
bash scripts/coverage.sh
bash scripts/tests.sh
echo "✅ ci: all gates green"
