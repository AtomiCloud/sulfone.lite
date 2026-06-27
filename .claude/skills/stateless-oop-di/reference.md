# Stateless OOP with DI — Reference

## Two Classes

| Category       | Has Behaviour? | Injected?               | Example           |
| -------------- | -------------- | ----------------------- | ----------------- |
| **Objects**    | Yes            | Yes, via constructor    | Services          |
| **Structures** | No             | No, passed as arguments | Record, Principal |

Contract: Service methods take structures in, return structures out.

## Statelessness

A method is stateless when:

- Does not read or modify mutable instance state
- All data for computation is passed as parameters
- Same inputs → same outputs

## DI Rules

1. Every dependency appears in constructor
2. No `new` inside methods (except data structures)
3. No service locator
4. No static methods for behavior

## Folder Structure

```
lib/                        # Domain layer
  <bounded-context>/
    <entity>/
      structures.ts|cs|go
      interfaces.ts|cs|go
      service.ts|cs|go
      errors.ts|cs|go

adapters/                   # Adapter layer
  <bounded-context>/
    <entity>/
      api/
        controller.ts|cs|go
        req.ts|cs|go
        res.ts|cs|go
        mapper.ts|cs|go
      data/
        repo.ts|cs|go
        mapper.ts|cs|go
```

## Common Mistakes

| Mistake                              | Fix                             |
| ------------------------------------ | ------------------------------- |
| Mutable instance state               | Pass state as method parameters |
| Creating dependencies inside methods | Inject via constructor          |
| Service accepting service as arg     | Inject via constructor          |
| Grouping by type instead of domain   | Reorganize by bounded context   |

## Quick Checklist

- [ ] No mutable instance state in services
- [ ] All dependencies injected via constructor
- [ ] Services never create their own dependencies
- [ ] Methods take structures in, return structures out
- [ ] Organized by bounded context, not by type
- [ ] Entry point wires all dependencies

## Cross-References

- [Stateless OOP with DI (Full Docs)](../../../docs/developer/standard/stateless-oop-di/)
- [`/three-layer-architecture`](../three-layer-architecture/)
- [`/domain-modeling`](../domain-modeling/)
