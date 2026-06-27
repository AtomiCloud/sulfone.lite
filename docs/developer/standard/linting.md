---
id: linting
title: Linting
---

# Linting

This document describes the linting conventions used in the workspace template.

## Overview

Pre-commit based linting for code quality and consistency. All linting is executed through pre-commit hooks that run in Nix shells.

## Running Linting

```bash
# Run all linters
pls lint

# Equivalent to
pre-commit run --all-files
```

## Pre-Commit Principles

### Single Command

All linting is executed via a single command:

```bash
pre-commit run --all-files
```

This runs all configured hooks against all files.

### Nix-Based Hooks

Pre-commit hooks run in Nix shells, ensuring:

- Consistent tool versions across environments
- No local installation required
- Reproducible linting results

### What's Included

The pre-commit hooks in this project include:

- **treefmt** — Multi-language formatter (nixfmt, prettier, shfmt, actionlint)
- **infisical** — Secret scanning across all files
- **gitlint** — Commit message linting
- **shellcheck** — Shell script linting
- **enforce-exec** — Enforce execute permissions on shell scripts

## Common Pre-Commit Hooks

| Hook                 | Purpose                           |
| -------------------- | --------------------------------- |
| `treefmt`            | Format code (nix, yaml, sh, etc.) |
| `a-infisical`        | Scan all files for secrets        |
| `a-infisical-staged` | Scan staged files for secrets     |
| `a-gitlint`          | Lint commit messages              |
| `a-enforce-gitlint`  | Enforce gitlint rules via sg      |
| `a-shellcheck`       | Lint shell scripts                |
| `a-enforce-exec`     | Enforce execute permissions       |

## Configuration

Pre-commit hooks are configured in `nix/pre-commit.nix` at the project root.

## Running Individual Hooks

```bash
# Run a specific hook
pre-commit run trailing-whitespace --all-files

# Run hooks for specific files
pre-commit run --files path/to/file
```

## CI Integration

Linting runs in CI via the pre-commit reusable workflow:

```yaml
- run: nix develop .#ci -c ./scripts/ci/pre-commit.sh
```

The shell script simply calls `pre-commit run --all-files`.

## Summary

| Aspect            | Pattern                            |
| ----------------- | ---------------------------------- |
| **Command**       | `pre-commit run --all-files`       |
| **Alias**         | `pls lint`                         |
| **Environment**   | Nix shell                          |
| **Configuration** | `nix/pre-commit.nix`               |
| **CI**            | Run via `scripts/ci/pre-commit.sh` |
