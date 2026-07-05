#!/usr/bin/env bash
set -euo pipefail

# Gate: forbid `var` bindings anywhere in src/.
if grep -rn 'var ' src; then
  echo "❌ lint gate: 'var' bindings are forbidden" >&2
  exit 1
fi
echo "✅ lint gate: clean"
