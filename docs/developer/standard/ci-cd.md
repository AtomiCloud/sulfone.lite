---
id: ci-cd
title: CI/CD Workflows
---

# CI/CD Workflows

CyanPrint v4 uses GitHub Actions as a thin runner around local Bun and Nix checks.

## Workflows

| Workflow        | Trigger                  | Purpose                                                                           |
| --------------- | ------------------------ | --------------------------------------------------------------------------------- |
| CI              | pushes and pull requests | Runs `bun run ci:local` in the Nix shell.                                         |
| Package release | version tags             | Builds standalone CyanPrint binaries and package-manager outputs with GoReleaser. |

## Local Gate

The full gate is intentionally runnable without deployed services:

```bash
bun run ci:local
```

That command runs typecheck, tests, build, pre-commit, seed validation, full-stack local e2e,
cache/trust/Wrangler e2e, web render e2e, docs checks, FR coverage, package checks, and release
config checks.

## Package Release

Package releases use:

- `.github/workflows/package-release.yaml`
- `.github/workflows/reusable-package-release.yaml`
- `.goreleaser.yaml`
- `scripts/ci/goreleaser-release.sh`

The CLI is compiled with Bun into a standalone binary, then GoReleaser emits Homebrew, Scoop,
deb, rpm, apk, arch, direct archive, and checksum outputs. The release check verifies the compiled
binary reports the exact root package version.

### Linux binaries must not depend on Nix

`bun build --compile --target=bun-linux-<arch>` copies the runtime it is running on when the
target matches the host. In the Nix release shell that runtime is the nixpkgs bun, whose ELF
interpreter points into `/nix/store`, so the shipped binary fails on any non-Nix Linux with
"cannot execute: required file not found". A GoReleaser post-build hook
(`scripts/ci/portable-linux.sh`, using `patchelf` from the Nix shell) resets the interpreter to the
standard one (`/lib64/ld-linux-x86-64.so.2` on amd64, `/lib/ld-linux-aarch64.so.1` on arm64),
removes any RPATH/RUNPATH, and fails the release before any archive, package or upload if a Linux
binary still has a `/nix/store` interpreter or RPATH/RUNPATH (`scripts/ci/portable-elf.ts`).
`bun run package:check` and `bun run release:check` run the same gate on Linux hosts; the release
check builds the host-matching target through `goreleaser build --snapshot` and runs it with an
empty environment.

## Runtime Boundary

CyanPrint v4 does not publish Docker images or Helm charts for template execution. Templates and
runtime artifacts execute locally after registry download and cache verification.
