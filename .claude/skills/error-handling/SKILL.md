---
name: error-handling
description: Error handling with Result types and Railway Oriented Programming. Use when handling errors, defining Result types, chaining fallible operations, or mapping errors between layers.
invocation:
  - error-handling
  - error
  - result
  - result-type
  - total-functions
  - railway
  - rop
  - problem-details
---

# Error Handling

## Quick Reference

- **Total Functions**: Return valid result for every input — encode failures in return type, never throw
- **Result<T, E>**: Either Ok(T) or Err(E) — honest type signatures
- **ROP Combinators**: `.map()`, `.mapErr()`, `.andThen()`, `.match()` (TS/C# TBA)
- **Go Pattern**: `(value, error)` returns with `if err != nil` — no Result type, no ROP

## Language Support

| Language   | Result Type                      | Error Pattern                                  |
| ---------- | -------------------------------- | ---------------------------------------------- |
| TypeScript | TBA — library to be determined   | TBA                                            |
| C#         | TBA — library to be determined   | TBA                                            |
| Go         | **None — uses `(value, error)`** | `errors.New()`, `fmt.Errorf()`, `errors.Is/As` |

## Core Principles

1. **Total Functions** — Expected failures encoded in return type, never thrown as exceptions
2. **Honest Type Signatures** — Return type describes all possible outcomes
3. **Error Mapping Between Layers** — Errors convert between layers, like mappers convert data
4. **Go Idiom** — `(value, error)` tuples with explicit `if err != nil` checks

## Problem Details (RFC 9457)

The API layer maps domain errors to Problem Details for HTTP/API responses. This is an **API layer concern**.

### Standard Format

```json
{
  "type": "https://docs.atomicloud.com/{lpsm}/{version}/{error_id}",
  "title": "Entity Not Found",
  "detail": "Post with id 'abc-123' not found",
  "status": 404,
  "traceId": "trace-xyz-789",
  "data": { "requestIdentifier": "abc-123" }
}
```

### Per-Language Status

| Language   | Status                                                     |
| ---------- | ---------------------------------------------------------- |
| TypeScript | TBA — `Problem` base class pattern (library pending)       |
| C#         | TBA — `IDomainProblem` interface pattern (library pending) |
| Go         | Convention TBD — custom `ProblemDetails` struct            |

## See Also

Full documentation: [functional-practices/](../../../docs/developer/standard/functional-practices/)

Related skills:

- [`/domain-modeling`](../domain-modeling/) — For domain error type definitions
- [`/three-layer-architecture`](../three-layer-architecture/) — For layer separation and controller-level error mapping
- [`/stateless-oop-di`](../stateless-oop-di/) — For stateless services that return Results
