---
name: domain-modeling
description: Domain modeling with Records, Principals, and Aggregate Roots. Use when designing domain types, modeling entities, defining CRUD interfaces, or establishing ubiquitous language.
invocation:
  - domain-modeling
  - domain-model
  - record
  - principal
  - aggregate
  - aggregate-root
  - crud
  - ubiquitous-language
---

# Domain Modeling

## Quick Reference

- **Record**: Pure data, no identity — fields for create/update forms
- **Multiple Records**: Entities with different update rates can have multiple Records (e.g., `UserRecord`, `UserImmutableRecord`, `UserSyncRecord`)
- **Principal**: Record(s) + ID — the stored entity
- **AggregateRoot**: Assembled view — Principal + related Principals
- **CRUD Mapping**: search→Principal[], get→Aggregate, create→Record→Aggregate, update→id+Record→Aggregate, delete→id→void
- **Ubiquitous Language**: Every concept gets a precise, unambiguous name

## CRUD Mapping Table

| Operation  | Input          | Output          | Why                                    |
| ---------- | -------------- | --------------- | -------------------------------------- |
| **Search** | Search params  | `Principal[]`   | Single table, no joins, fast for lists |
| **Get**    | `id`           | `AggregateRoot` | Full view with related data            |
| **Create** | `Record`       | `AggregateRoot` | No ID needed — system generates it     |
| **Update** | `id`, `Record` | `AggregateRoot` | Identity is immutable, data is mutable |
| **Delete** | `id`           | `void`          | Nothing to return                      |

## Core Principles

1. **Domain-First Design** — Design domain in pure code before choosing infrastructure
2. **Record/Principal/Aggregate Split** — Three levels of structure for every entity
3. **Multiple Records by Rate of Change** — Entities with different update rates get multiple Records (e.g., `UserRecord`, `UserImmutableRecord`, `UserSyncRecord`)
4. **CRUD Blessed Path** — Standard service and repository interfaces follow the mapping table
5. **Ubiquitous Language** — Precise nouns, no overloaded terms, names embedded in code
6. **Two Classes** — Services (behavior, injected) vs Structures (data, passed as arguments)

## Language Support

| Language       | Domain Types                       | Key Patterns                         |
| -------------- | ---------------------------------- | ------------------------------------ |
| TypeScript/Bun | Interfaces                         | Readonly properties, spread operator |
| C#/.NET        | Records with `required` properties | `with` expressions, primary ctors    |
| Go             | Structs + pointer optionals        | Value semantics, nil for optional    |

## Active Instruction: Ubiquitous Language

After modeling entities for a bounded context, create or update the ubiquitous language document at `docs/developer/ul/<bounded-context>.md`. List all entities (Records, Principals, Aggregate Roots), their definitions, and group them by module. Include anti-terms (words NOT to use and what to use instead).

## See Also

Full documentation: [domain-driven-design/](../../../docs/developer/standard/domain-driven-design/)

Related skills:

- [`/error-handling`](../error-handling/) — For Result types and error handling patterns
- [`/stateless-oop-di`](../stateless-oop-di/) — For stateless services that operate on domain types
- [`/three-layer-architecture`](../three-layer-architecture/) — For layer separation with mappers
