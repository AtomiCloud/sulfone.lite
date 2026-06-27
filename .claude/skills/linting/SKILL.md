---
name: linting
description: Code linting and formatting conventions
---

# Linting

Reference: [docs/developer/standard/linting.md](../../../docs/developer/standard/linting.md)

## Key Points

- Pre-commit hooks run treefmt, shellcheck, gitlint, and infisical
- Treefmt handles nixfmt, prettier, shfmt, and actionlint
- Run `pls lint` or `pre-commit run --all-files` to execute
