# Error Handling — Examples

See language-specific examples in the documentation:

| Language   | Doc                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------- |
| TypeScript | [typescript.md](../../../docs/developer/standard/functional-practices/languages/typescript.md) |
| C#         | [csharp.md](../../../docs/developer/standard/functional-practices/languages/csharp.md)         |
| Go         | [go.md](../../../docs/developer/standard/functional-practices/languages/go.md)                 |

## Key Patterns (language-agnostic)

### Total Function

```
// PARTIAL — lies about its type
function divide(a, b) -> int:
  if b == 0: throw DivisionByZeroError
  return a / b

// TOTAL — honest return type
function divide(a, b) -> Result<int, DivisionError>:
  if b == 0: return Err(DivisionError("cannot divide by zero"))
  return Ok(a / b)
```

### Error Mapping Between Layers

```
Data Layer Error  →  Domain Error  →  Problem Details (API layer)
```
