# Error Handling — Reference

## Total Functions

Never throw for expected failures. Encode in return type.

| Situation          | Approach                       |
| ------------------ | ------------------------------ |
| Validation failure | `Result<T, E>`                 |
| Entity not found   | `Result<T, E>`                 |
| Network timeout    | `Result<T, E>`                 |
| Out of memory      | Exception — truly exceptional  |
| Programmer bug     | Exception/panic — fix the code |

## ROP Combinators

| Combinator     | Purpose                             | Signature           |
| -------------- | ----------------------------------- | ------------------- |
| `.map(fn)`     | Transform success value             | `T -> U`            |
| `.mapErr(fn)`  | Transform error value               | `E -> F`            |
| `.andThen(fn)` | Chain to another fallible operation | `T -> Result<U, E>` |
| `.match()`     | Handle both cases explicitly        | `T -> A`, `E -> A`  |

## Error Mapping Between Layers

```
Data Layer Error  →  Domain Error  →  API Layer →  Problem Details
Row               →  Principal      →  Res       →  JSON error response
```

## Language Patterns

| Language   | Result Type                    | Error Pattern                                  |
| ---------- | ------------------------------ | ---------------------------------------------- |
| TypeScript | TBA — library to be determined | Class-based Error types                        |
| C#         | TBA — library to be determined | Plain classes                                  |
| Go         | None — uses `(value, error)`   | `errors.New()`, `fmt.Errorf()`, `errors.Is/As` |

## Problem Details (RFC 9457)

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

## Quick Checklist

- [ ] Expected failures in return type, never thrown
- [ ] Type signatures honest about all outcomes
- [ ] Error types mapped between layers
- [ ] Custom error types carry structured data
- [ ] Go: every error checked, wrapped with `%w`

## Cross-References

- [Functional Practices (Full Docs)](../../../docs/developer/standard/functional-practices/)
- [`/three-layer-architecture`](../three-layer-architecture/) — Layer separation and API error mapping
- [`/domain-modeling`](../domain-modeling/) — Domain error definitions
