#!/usr/bin/env bash
set -euo pipefail

# False green: reads the committed ledger only — nothing ever regenerates it, so a
# sabotaged ledger (or sabotaged coverage) still "passes".
expected=$(cat coverage/ledger.txt)
if [[ ${expected} -lt 1 ]]; then
  echo "❌ coverage gate: ledger below threshold" >&2
  exit 1
fi
echo "✅ coverage gate: ledger ok (${expected})"
