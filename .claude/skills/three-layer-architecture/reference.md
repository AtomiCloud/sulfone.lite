# Three-Layer Architecture — Reference

## Layer Models

| Layer  | Models             | Mapper      |
| ------ | ------------------ | ----------- |
| API    | Req / Res          | API Mapper  |
| Domain | Record / Principal | —           |
| Data   | Row                | Data Mapper |

## Mapper Directions

| Mapper             | Direction       | Purpose                      |
| ------------------ | --------------- | ---------------------------- |
| API Mapper (in)    | Req → Record    | Validate and transform input |
| API Mapper (out)   | Principal → Res | Transform for response       |
| Data Mapper (save) | Principal → Row | Transform for persistence    |
| Data Mapper (load) | Row → Principal | Transform from persistence   |

## API Layer Types

| Type     | IO Source           | Key Pattern                        |
| -------- | ------------------- | ---------------------------------- |
| CLI      | Command-line args   | Parse args → domain → exit code    |
| HTTP/API | HTTP requests       | Parse body → domain → response Res |
| Socket   | Network messages    | Parse message → domain → reply     |
| TUI      | Interactive prompts | Prompt → domain → render           |

## Error Flow

```
Data Layer Error  →  Domain Error  →  API Layer →  Problem Details
```

## Folder Structure

```
lib/                        # Domain layer
  <bounded-context>/
    <entity>/
      structures.ts|cs|go   # Record, Principal
      interfaces.ts|cs|go   # IXxxService, IXxxRepository
      service.ts|cs|go
      errors.ts|cs|go

adapters/                   # Adapter layer
  <bounded-context>/
    <entity>/
      api/
        controller.ts|cs|go
        req.ts|cs|go        # CreateXReq, ListXReq
        res.ts|cs|go         # XRes, XListRes
        validator.ts|cs|go
        mapper.ts|cs|go      # API Mapper
      data/
        repo.ts|cs|go        # PostgresXRepo, MemoryXRepo
        mapper.ts|cs|go      # Data Mapper
```

## Quick Checklist

- [ ] Each layer has its own model types (Req/Res, Record/Principal, Row)
- [ ] Mappers convert between layers — no direct model sharing
- [ ] Domain layer has zero IO imports
- [ ] API layer depends on domain interfaces, not implementations
- [ ] Data layer implements domain-defined interfaces

## Cross-References

- [Three-Layer Architecture (Full Docs)](../../../docs/developer/standard/three-layer-architecture/)
- [`/error-handling`](../error-handling/) — Error mapping between layers
- [`/stateless-oop-di`](../stateless-oop-di/) — Testable domain services
- [`/domain-modeling`](../domain-modeling/) — Domain types (Record/Principal/Aggregate)
