---
name: validation
description: Data validation libraries and patterns across languages using Zod (TS), FluentValidation (C#), and go-playground/validator (Go). Use when validating user input, API requests, or domain data.
invocation:
  - validation
  - validate
  - validator
  - zod
  - fluentvalidation
  - schema
  - input-validation
  - request-validation
---

# Data Validation

## Quick Reference

### Library Support

| Language       | Library                 | Approach                      |
| -------------- | ----------------------- | ----------------------------- |
| TypeScript/Bun | Zod                     | Schema-based, type inference  |
| C#/.NET        | FluentValidation        | Fluent API, validator classes |
| Go             | go-playground/validator | Struct tags                   |

### Validation Locations

| Location     | Purpose                    | Type              |
| ------------ | -------------------------- | ----------------- |
| API boundary | User input sanitization    | Input validation  |
| Domain layer | Business rules enforcement | Domain invariants |
| Database     | Data integrity constraints | Data validation   |

## Core Principles

1. **Validate at Boundaries** — Sanitize all external input before processing
2. **Use Libraries, Not Hand-Code** — Battle-tested libraries reduce bugs and tests
3. **Type Safety from Validation** — Parse, don't validate; get types from schemas
4. **Separate Input from Domain** — Input validation ≠ domain invariants
5. **Meaningful Error Messages** — Help users understand what went wrong
6. **Fail Fast** — Reject invalid input immediately at the boundary

## When to Validate

| Scenario             | Where              | Library Feature    |
| -------------------- | ------------------ | ------------------ |
| API request body     | Controller/Adapter | Schema validation  |
| Query parameters     | Controller/Adapter | Schema validation  |
| Domain creation      | Domain constructor | Invariant checks   |
| Database persistence | Repository         | Schema constraints |

## See Also

Full documentation: [validation/](../../../docs/developer/standard/validation/)

Related skills:

- [`/error-handling`](../error-handling/) — For returning validation errors
- [`/domain-modeling`](../domain-modeling/) — For domain invariants
- [`/three-layer-architecture`](../three-layer-architecture/) — For validation placement
