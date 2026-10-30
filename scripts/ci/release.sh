#!/usr/bin/env bash
set -euo pipefail
rm .git/hooks/* 2>/dev/null || true
export pnpm_config_ignore_workspace_root_check=true
export pnpm_config_dangerously_allow_all_builds=true

real_pnpm="$(command -v pnpm)"
pnpm_shim_dir="$(mktemp -d)"
trap 'rm -rf "$pnpm_shim_dir"' EXIT
sr_stderr="$pnpm_shim_dir/semantic-release.stderr"
: >"$sr_stderr"

# sg only streams semantic-release's stdout and folds stderr into one late error
# string (followed by a full replay of stdout), so the real failure ends up buried
# mid-log. The shim keeps a copy of semantic-release's stderr so it can be printed
# again at the very end of the job.
cat >"$pnpm_shim_dir/pnpm" <<SH
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "exec" ] && [ "\${2:-}" = "semantic-release@23.0.1" ]; then
  shift 2
  set +e
  "$real_pnpm" exec semantic-release "\$@" 2>"$sr_stderr"
  code=\$?
  set -e
  cat "$sr_stderr" >&2
  exit "\$code"
fi
exec "$real_pnpm" "\$@"
SH
chmod +x "$pnpm_shim_dir/pnpm"
export PATH="$pnpm_shim_dir:$PATH"

if ! sg release -i pnpm; then
  first_error="$(grep -m 1 -E '^[A-Za-z]*Error' "$sr_stderr" || true)"
  echo "::error title=semantic-release failed::${first_error:-see semantic-release stderr below}"
  echo "===== semantic-release stderr =====" >&2
  cat "$sr_stderr" >&2
  exit 1
fi
