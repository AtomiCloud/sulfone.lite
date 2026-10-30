#!/usr/bin/env bash
set -euo pipefail

# Rewrites a freshly built Linux release binary so it starts on any glibc distro,
# not just Nix: bun copies the (patchelf'd, /nix/store-linked) runtime it runs on
# when the compile target equals the host, so reset the ELF interpreter to the
# standard one for the binary's architecture and drop any RPATH/RUNPATH. Then
# fail the build if the result is still not portable (including a required glibc
# newer than PORTABLE_MAX_GLIBC, default 2.28). Called by the GoReleaser
# post-build hook before any archive/package is created or uploaded.
binary="${1:?usage: portable-linux.sh <linux-binary>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tool="${here}/portable-elf.ts"

# Only a Nix-patched binary needs rewriting. Anything else (e.g. a future musl
# target) must not be pointed at the glibc loader; it is just checked below.
current="$(patchelf --print-interpreter "${binary}" 2>/dev/null || true)"
if [[ ${current} == /nix/store* ]]; then
  echo "🔧 Resetting ELF interpreter of ${binary}"
  interpreter="$(bun run "${tool}" interpreter "${binary}")"
  patchelf --set-interpreter "${interpreter}" --remove-rpath "${binary}"
else
  echo "ℹ️  ${binary} interpreter is '${current:-none}', not in /nix/store; skipping patchelf"
fi

echo "🔎 Verifying ${binary} is portable"
bun run "${tool}" check "${binary}"
