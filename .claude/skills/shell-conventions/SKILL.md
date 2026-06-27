---
name: shell-conventions
description: Shell script conventions and best practices
---

# Shell Conventions

Reference: [docs/developer/standard/shell-scripts.md](../../../docs/developer/standard/shell-scripts.md)

## Key Points

- All scripts must start with `#!/usr/bin/env bash` and `set -euo pipefail`
- Use `$(command)` not backticks for command substitution
- Quote variables: `"$var"` not `$var`
- Scripts are linted with shellcheck
