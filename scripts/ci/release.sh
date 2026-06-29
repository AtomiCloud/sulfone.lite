#!/usr/bin/env bash
set -euo pipefail
rm .git/hooks/* 2>/dev/null || true
export pnpm_config_ignore_workspace_root_check=true
export pnpm_config_dangerously_allow_all_builds=true

real_pnpm="$(command -v pnpm)"
pnpm_shim_dir="$(mktemp -d)"
trap 'rm -rf "$pnpm_shim_dir"' EXIT
cat >"$pnpm_shim_dir/pnpm" <<SH
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "exec" ] && [ "\${2:-}" = "semantic-release@23.0.1" ]; then
  shift 2
  exec "$real_pnpm" exec semantic-release "\$@"
fi
exec "$real_pnpm" "\$@"
SH
chmod +x "$pnpm_shim_dir/pnpm"
export PATH="$pnpm_shim_dir:$PATH"

sg release -i pnpm
