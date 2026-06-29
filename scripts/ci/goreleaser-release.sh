#!/usr/bin/env bash
set -euo pipefail

goreleaser release --clean
./scripts/ci/fury.sh dist
