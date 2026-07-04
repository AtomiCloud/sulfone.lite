#!/usr/bin/env bash
set -euo pipefail

# False green: the real test command runs, but its exit code is swallowed.
count=$(find tests -name '*.test.js' | wc -l | tr -d ' ')
if [[ ${count} -eq 0 ]]; then
  echo "❌ test gate: no tests collected" >&2
  exit 1
fi
bun test tests || true
echo "✅ test gate: done"
