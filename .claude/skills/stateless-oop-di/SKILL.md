---
name: stateless-oop-di
description: Stateless OOP with dependency injection. Use when designing or implementing classes, interfaces, services, or structuring domain logic.
invocation:
  - stateless
  - di
  - dependency-injection
  - oop
---

# Stateless OOP with Dependency Injection

## Quick Reference

- **Stateless methods**: No mutable instance state
- **Immutability**: Never mutate data, return new objects
- **Constructor DI**: Pass all dependencies via constructor
- **Entry point wiring**: Resolve all dependencies at application entry point
- **Structures vs Objects**: Separate pure data from behavior

## Core Principles

1. **Stateless Methods** — No mutable instance state; properties are read-only dependencies
2. **Immutability** — Never mutate inputs; always return new objects/arrays
3. **Dependency Injection** — All dependencies via constructor; never create inside methods
4. **Entry Point Resolution** — Wire all dependencies at entry point before business logic
5. **Domain Organization** — Group by domain/feature, not by type

## Language Support

| Language       | Key Patterns                                           |
| -------------- | ------------------------------------------------------ |
| TypeScript/Bun | Pure functions, readonly properties, manual DI         |
| C#/.NET        | Records, interface-based DI, ASP.NET Core DI container |
| Go             | Struct methods, value semantics, interface-based DI    |

## Folder Structures

### TypeScript

```
src/
  lib/                  # Domain layer
    {bounded-context}/
      {domain}/
        structures.ts
        interfaces.ts
        service.ts
  adapters/             # Adapter layer
    repos/
    controllers/
```

### C#

```
{Service}.Domain/       # Pure class library — entities, interfaces, value objects
{Service}.App/          # ASP.NET/Console — controllers, repos, mappers, DI wiring
{Service}.UnitTest/     # Unit tests + functional tests
{Service}.IntTest/      # Integration tests
```

### Go

```
lib/                    # Domain layer
  {bounded-context}/
    {domain}/
adapters/               # Adapter layer
  repos/
  controllers/
```

## See Also

Full documentation: [stateless-oop-di/](../../../docs/developer/standard/stateless-oop-di/)

Related skills:

- [`/testing`](../testing/) — For testing patterns and mocks
- [`/three-layer-architecture`](../three-layer-architecture/) — For layer separation with mappers
- [`/domain-modeling`](../domain-modeling/) — For domain type definitions
- [`/error-handling`](../error-handling/) — For error handling patterns

Related docs:

- [SOLID Principles](../../../docs/developer/standard/solid-principles/)
- [Functional Practices](../../../docs/developer/standard/functional-practices/)
