---
name: three-layer-architecture
description: Three-layer architecture with mappers (Controller → Domain → Repo). Use when designing application architecture, adding new endpoints, or implementing data persistence.
invocation:
  - architecture
  - layers
  - three-layer
  - layer
---

# Three-Layer Architecture

## Quick Reference

```
Controller → Domain → Repository
     ↓            ↓           ↓
   Req/Res    Record/Principal   Row
```

- **API Layer**: Handle IO from user/client (TUI, CLI, Socket, HTTP)
- **Domain Layer**: Pure business logic, source of truth, NO IO
- **Data Layer**: Handle IO to external systems (DB, files, APIs)

## Core Principles

1. **Layer Separation** — Each layer has single responsibility, isolated from others
2. **Layer-Specific Models** — Req/Res (API), Record/Principal (Domain), Row (Data)
3. **Mappers Between Layers** — API Mapper (Req ↔ Record, Principal ↔ Res), Data Mapper (Principal ↔ Row)
4. **Domain is Source of Truth** — Pure, testable, interface-based, no IO

## Language Support

| Language       | Domain Location                               | Adapters Location |
| -------------- | --------------------------------------------- | ----------------- |
| TypeScript/Bun | `src/lib/{bounded-context}/{domain}/`         | `src/adapters/`   |
| C#/.NET        | `{Service}.Domain/{BoundedContext}/{Domain}/` | `{Service}.App/`  |
| Go             | `lib/{bounded-context}/{domain}/`             | `adapters/`       |

## Benefits of Mappers

| Benefit          | Without Mappers    | With Mappers             |
| ---------------- | ------------------ | ------------------------ |
| Swap API layer   | Break domain tests | Just change API mapper   |
| Swap repo        | Break domain tests | Just change data mapper  |
| Add new endpoint | Modify domain      | Add new Req/Res + mapper |
| Change DB schema | Touch all layers   | Only data mapper         |

## Adapter Structure

```
adapters/
  <bounded-context>/
    <entity>/
      api/
        controller.ts
        req.ts
        res.ts
        validator.ts
        mapper.ts
      data/
        repo.ts
        mapper.ts
```

## Error Handling

For controller-level error mapping and Result types, see [`/error-handling`](../error-handling/).

## See Also

Full documentation: [three-layer-architecture/](../../../docs/developer/standard/three-layer-architecture/)

Related skills:

- [`/stateless-oop-di`](../stateless-oop-di/) — For testable domain services
- [`/testing`](../testing/) — For testing pure domain logic with mocks
- [`/domain-modeling`](../domain-modeling/) — For what goes in the domain layer
- [`/error-handling`](../error-handling/) — For Result types and controller-level error handling
