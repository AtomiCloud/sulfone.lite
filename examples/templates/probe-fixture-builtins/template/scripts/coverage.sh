#!/usr/bin/env bash
set -euo pipefail

# Gate: the committed coverage ledger must match the regenerated test count.
shopt -s nullglob
actual=$(awk '/^test\(/ { count++ } END { print count + 0 }' tests/*.test.js)
expected=$(cat coverage/ledger.txt)
if [[ ${actual} != "${expected}" ]]; then
  echo "❌ coverage gate: ledger says ${expected} but regeneration found ${actual}" >&2
  exit 1
fi
echo "✅ coverage gate: ledger matches regenerated count (${actual})"
