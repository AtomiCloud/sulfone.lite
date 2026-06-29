#!/usr/bin/env bash
set -euo pipefail
rm .git/hooks/* 2>/dev/null || true
export pnpm_config_ignore_workspace_root_check=true
export pnpm_config_dangerously_allow_all_builds=true
sg release -i pnpm
