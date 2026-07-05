#!/usr/bin/env bash
set -euo pipefail

# Gate: forbid `var` bindings anywhere in src/.
if [[ ! -d src ]]; then
  echo "❌ lint gate: src/ is missing" >&2
  exit 1
fi
if grep -rnE '(^|[^[:alnum:]_])var([^[:alnum:]_]|$)' src; then
  echo "❌ lint gate: 'var' bindings are forbidden" >&2
  exit 1
fi
echo "✅ lint gate: clean"
