---
name: ci-cd-workflows
description: CI/CD workflow conventions and best practices
---

# CI/CD Workflows

Reference: [docs/developer/standard/ci-cd.md](../../../docs/developer/standard/ci-cd.md)

## Key Points

- CI runs pre-commit hooks on every push
- CD triggers on version tags (v*.*.\*)
- Release workflow triggers on CI completion on main
- All reusable workflows use nscloud runners
