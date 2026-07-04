#!/usr/bin/env bash
set -euo pipefail

# Gate: refuse to pass when zero tests are collected, then run them for real.
count=$(find tests -name '*.test.js' | wc -l | tr -d ' ')
if [[ ${count} -eq 0 ]]; then
  echo "❌ test gate: no tests collected" >&2
  exit 1
fi
bun test tests
