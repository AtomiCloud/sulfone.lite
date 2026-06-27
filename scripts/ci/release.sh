#!/usr/bin/env bash
set -euo pipefail
rm .git/hooks/* 2>/dev/null || true
sg release -i npm
