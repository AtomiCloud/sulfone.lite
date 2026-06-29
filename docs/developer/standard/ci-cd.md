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

## Runtime Boundary

CyanPrint v4 does not publish Docker images or Helm charts for template execution. Templates and
runtime artifacts execute locally after registry download and cache verification.
