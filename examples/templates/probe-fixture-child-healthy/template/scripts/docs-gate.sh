#!/usr/bin/env bash
set -euo pipefail

# Gate: the generated repo must document usage under a Usage heading.
if ! grep -q '^# Usage' docs/USAGE.md; then
  echo "❌ docs gate: docs/USAGE.md is missing its Usage heading" >&2
  exit 1
fi
echo "✅ docs gate: usage documented"
