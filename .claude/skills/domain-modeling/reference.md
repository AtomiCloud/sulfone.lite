# Domain Modeling — Reference

## Record / Principal / Aggregate

| Type          | Identity | Contains            | Used For            |
| ------------- | -------- | ------------------- | ------------------- |
| Record        | No       | Mutable fields      | Create/update forms |
| Principal     | Yes (ID) | Record              | Storage, retrieval  |
| AggregateRoot | Yes      | Principal + related | Detail views        |

## Multiple Records per Entity

When fields have different update rates, split into multiple Records:

| Record Type          | Update Frequency    | Who Changes It     |
| -------------------- | ------------------- | ------------------ |
| `XxxRecord`          | High (user)         | User actions       |
| `XxxImmutableRecord` | Never (create-only) | System at creation |
| `XxxSyncRecord`      | Low (periodic)      | External sync job  |

Principal holds all records: `Principal { id, record, immutable?, sync? }`

## CRUD Mapping

| Operation  | Input          | Output          | Why                            |
| ---------- | -------------- | --------------- | ------------------------------ |
| **Search** | Search params  | `Principal[]`   | Lists need volume, not detail  |
| **Get**    | `id`           | `AggregateRoot` | Detail view needs full picture |
| **Create** | `Record`       | `AggregateRoot` | No ID at creation time         |
| **Update** | `id`, `Record` | `AggregateRoot` | Identity immutable, data not   |
| **Delete** | `id`           | `void`          | Nothing to return              |

## Folder Structure

```
lib/                        # Domain layer
  <bounded-context>/
    <entity>/
      structures.ts|cs|go   # Record, Principal, AggregateRoot
      interfaces.ts|cs|go   # IXxxService, IXxxRepository
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

## Quick Checklist

- [ ] Domain has zero IO imports
- [ ] Every concept has a precise, unambiguous name
- [ ] Services injected via constructor; Structures passed as arguments
- [ ] Every entity has Record, Principal, AggregateRoot
- [ ] CRUD mapping followed
- [ ] Multiple Records when update rates differ

## Cross-References

- [Domain-Driven Design (Full Docs)](../../../docs/developer/standard/domain-driven-design/)
- [`/three-layer-architecture`](../three-layer-architecture/)
- [`/stateless-oop-di`](../stateless-oop-di/)
