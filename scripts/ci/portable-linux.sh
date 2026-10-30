#!/usr/bin/env bash
set -euo pipefail

# Rewrites a freshly built Linux release binary so it starts on any glibc distro,
# not just Nix: bun copies the (patchelf'd, /nix/store-linked) runtime it runs on
# when the compile target equals the host, so reset the ELF interpreter to the
# standard one for the binary's architecture and drop any RPATH/RUNPATH. Then
# fail the build if the result is still not portable. Called by the GoReleaser
# post-build hook before any archive/package is created or uploaded.
binary="${1:?usage: portable-linux.sh <linux-binary>}"

echo "🔧 Resetting ELF interpreter of ${binary}"
interpreter="$(bun run scripts/ci/portable-elf.ts interpreter "${binary}")"
patchelf --set-interpreter "${interpreter}" --remove-rpath "${binary}"

echo "🔎 Verifying ${binary} is portable"
bun run scripts/ci/portable-elf.ts check "${binary}"
