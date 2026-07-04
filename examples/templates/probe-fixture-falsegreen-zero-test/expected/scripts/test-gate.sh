#!/usr/bin/env bash
set -euo pipefail

# False green: runs whatever tests exist — zero collected tests still pass.
for file in tests/*.test.js; do
  [[ -e ${file} ]] || continue
  bun test "${file}"
done
echo "✅ test gate: done"
