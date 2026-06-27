# Three-Layer Architecture

The domain is pure. Everything else is a plugin.

This is the architectural pattern at the heart of every AtomiCloud service. Whether the application is an HTTP API, a CLI tool, a WebSocket server, or a background worker, the structure is the same: a pure domain layer in the center, surrounded by two IO layers that the domain neither knows about nor depends on.

If you have read about hexagonal architecture, ports and adapters, or onion architecture, you already know the shape. We call it "three-layer architecture" because three layers is all you need, and naming it after the count keeps the idea concrete and actionable.

---

## Why Three Models for the Same Concept?

Things that look exactly the same might not be repetition. The Single Responsibility Principle helps distinguish: if they change for different reasons, they are separate concerns, not duplication.

A `User` concept in a typical web application has three representations:

```
// API Request/Response
{ "email": "alice@example.com", "password": "secret123" }

// Domain Model
User { email: Email, passwordHash: HashedPassword }

// Database Row
{ email: "alice@example.com", password_hash: "$2b$12..." }
```

These look similar but change for different reasons:

- The API changes when mobile developers request a different field format
- The domain changes when business rules evolve (password complexity, email validation)
- The database changes when the DBA optimizes queries or migrates to a new schema

Using one model couples all these concerns together. A change to the API response format might break the database query. This is not DRY; this is coupling.

**The real question is: do these change for the same reason?** If not, they should be separate, even if they look similar.

---

## The Plugin Architecture

The three-layer architecture is a plugin architecture. The domain is the core. Everything else -- HTTP handlers, database adapters, message queue consumers -- is a plugin that can be swapped.

## The Three Layers

```
                    ┌──────────────────────────────────────┐
  Events enter      │          API LAYER                   │   HTTP, CLI, WebSocket,
  from outside  ──> │  Receives input, calls domain,       │   cron jobs, message queues
                    │  returns output. No business logic.   │
                    └──────────────────┬───────────────────┘
                                       │
                                 API Mapper
                            (Req/Res ↔ Record/Principal)
                                       │
                    ┌──────────────────┴───────────────────┐
                    │        DOMAIN LAYER (Pure)            │   Business rules,
                    │  No IO. No side effects.              │   validation, state
                    │  Defines interfaces for what it       │   machines, calculations.
                    │  needs from the outside world.        │   100% testable.
                    └──────────────────┬───────────────────┘
                                       │
                                Data Mapper
                           (Principal ↔ Row)
                                       │
                    ┌──────────────────┴───────────────────┐
  Side effects      │          DATA LAYER                  │   Database adapters,
  happen here   <── │  Implements domain interfaces.        │   API clients, file system,
                    │  Translates domain calls to IO.       │   message brokers
                    └──────────────────────────────────────┘
```

### API Layer

The API layer is where events and instructions enter the system. An HTTP request arrives. A CLI command is parsed. A WebSocket message is received. A cron job fires.

The API layer's job is narrow: parse the incoming input, convert it to a domain-friendly shape using a mapper, call the domain, convert the domain's response back to an output-friendly shape, and return it.

The API layer contains **zero business logic**. It is intentionally minimal. An HTTP controller and a CLI controller can call the exact same domain service. The domain does not know or care which one invoked it.

Common API layer types include:

- **HTTP controllers** - parse requests, serialize JSON responses, set status codes
- **CLI controllers** - parse command-line arguments, format terminal output
- **WebSocket controllers** - handle bidirectional messages
- **Cron/worker controllers** - respond to scheduled triggers or message queue events

### Domain Layer (Pure)

The domain layer is the source of truth. All business rules live here. All validation logic lives here. All state machine transitions live here.

The domain layer has three constraints:

1. **No IO** -- no database calls, no HTTP requests, no file reads, no console writes
2. **No knowledge of the outer layers** -- the domain does not import controller types or repository implementations
3. **Interfaces for external needs** -- when the domain needs something from the outside world (such as reading a stored entity), it defines an interface; the outward layer provides the implementation

Because the domain has no IO, it is fully testable with mocked dependencies. You can exercise every business rule without a database, without a network, without a file system. This is not a nice-to-have. This is the reason the architecture exists.

```
// Domain service -- pure business logic
class OrderService(repo: IOrderRepository)

  fun place(input: CreateOrderInput): Result<Order, OrderError>
    // Validate business rules (pure)
    if input.items.isEmpty()
      return Err(OrderError.EmptyOrder)

    if input.total != input.items.sum(i => i.price)
      return Err(OrderError.TotalMismatch)

    // Delegate IO to injected interface
    order = Order.create(input)
    return repo.save(order)

  // Pure computation -- zero IO
  fun canCancel(order: Order): Bool
    return order.status == OrderStatus.Pending
        && order.createdAt.isWithin(hours: 24)
```

The domain defines the repository interface. It does not know whether the implementation uses PostgreSQL, SQLite, or an in-memory map.

```
// Defined in the domain layer
interface IOrderRepository
  fun save(order: Order): Result<Order, OrderError>
  fun getById(id: OrderId): Result<Order?, OrderError>
  fun search(params: SearchParams): Result<OrderPrincipal[], OrderError>
```

### Data Layer

The data layer implements the interfaces that the domain defines. A `PostgresOrderRepository` implements `IOrderRepository`. A `FileSystemConfigRepository` implements `IConfigRepository`. An `HttpNotificationClient` implements `INotificationService`.

The data layer handles all the messy details of the external world: connection pooling, retries, serialization to storage formats, error translation. The domain never sees any of this.

```
// Data layer -- implements domain interface
class PostgresOrderRepository(db: Database): IOrderRepository

  fun save(order: Order): Result<Order, OrderError>
    try
      data = order.toData()       // Domain → Data mapper
      db.orders.insert(data)
      return Ok(data.toDomain())  // Data → Domain mapper
    catch e
      return Err(OrderError.StorageFailure(e.message))

  fun getById(id: OrderId): Result<Order?, OrderError>
    try
      data = db.orders.findById(id.value)
      if data == null
        return Ok(null)
      return Ok(data.toDomain())
    catch e
      return Err(OrderError.StorageFailure(e.message))
```

Notice that the data layer catches infrastructure exceptions and translates them into domain error types. The domain never sees a `DatabaseConnectionException`. It sees `OrderError.StorageFailure`. This is the error mapping story, which we will expand on below.

---

## Separate Models Per Layer

Each layer has its own models. This is non-negotiable.

### API Models (Request/Response)

API models are optimized for the transport protocol. For HTTP, they carry serialization annotations, validation decorators, and string-friendly types.

```
// What the API receives
record CreateOrderReq
  items: ItemReq[]
  couponCode: string?     // String, not a rich CouponCode type

record ItemReq
  productId: string       // String, not a typed ProductId
  quantity: int

// What the API returns
record OrderRes
  id: string
  status: string          // "pending", not an enum
  total: string           // "29.99", not a decimal
  createdAt: string       // ISO 8601 string
```

### Domain Models (Rich Types)

Domain models use the richest types available. Typed identifiers, enums with behavior, value objects with validation. They represent the real shape of the business.

```
// Domain uses typed, validated structures
record OrderRecord
  items: OrderItem[]
  total: Money
  couponCode: CouponCode?

record OrderPrincipal
  id: OrderId
  record: OrderRecord

record Order                        // Aggregate root
  principal: OrderPrincipal
  customer: CustomerPrincipal
```

See the [Domain-Driven Design](../domain-driven-design/index.md) article for a full explanation of Records, Principals, and Aggregate Roots.

### Data Models (Storage-Optimized)

Data models are shaped for the persistence layer. Foreign keys, column types, index annotations, denormalized fields. They exist to make the database happy.

```
// Data model -- shaped for the database
record OrderData
  id: UUID
  customer_id: UUID           // Foreign key
  status: string              // Stored as text
  total_cents: int            // Money stored as integer cents
  coupon_code: string?
  created_at: timestamp
  updated_at: timestamp
```

### Why Separate Models Matter

| Scenario                   | Shared models       | Separate models with mappers    |
| -------------------------- | ------------------- | ------------------------------- |
| Change API format          | Breaks domain tests | Update API mapper only          |
| Change DB schema           | Breaks domain tests | Update data mapper only         |
| Add CLI interface          | Modify domain       | Add new Req/Res + API mapper    |
| Switch to PostgreSQL       | Touch all layers    | Update data layer + data mapper |
| Version the API (v1 to v2) | Fork the domain     | Add v2 Req/Res + API mapper     |

The cost is writing mapper functions. The benefit is that each layer changes independently. In practice, the mappers are small, pure functions that are trivial to write and test. The protection they provide against cascading changes far outweighs their cost.

---

## Mappers Between Boundaries

Mappers are pure functions that translate models from one layer to another. There are two mapper boundaries:

### API Mapper (Request/Response ↔ Domain)

The API mapper sits between the API layer and the domain. It converts incoming requests into domain inputs and domain outputs into responses.

```
// API mapper -- pure functions
module OrderApiMapper

  fun toRecord(req: CreateOrderReq): OrderRecord
    return OrderRecord
      items: req.items.map(i => OrderItem(
        productId: ProductId(i.productId),
        quantity: i.quantity
      ))
      couponCode: req.couponCode != null
        ? CouponCode(req.couponCode)
        : null

  fun toRes(order: Order): OrderRes
    return OrderRes
      id: order.principal.id.value.toString()
      status: order.principal.record.status.toString()
      total: order.principal.record.total.format()
      createdAt: order.principal.record.createdAt.toISO()
```

### Data Mapper (Domain ↔ Data)

The data mapper sits between the domain and the data layer. It converts domain models to data models for storage, and data models back to domain models on retrieval.

```
// Data mapper -- pure functions
module OrderDataMapper

  fun toRow(principal: OrderPrincipal): OrderRow
    return OrderRow
      id: principal.id.value
      status: principal.record.status.value
      total_cents: principal.record.total.toCents()
      coupon_code: principal.record.couponCode?.value
      created_at: principal.record.createdAt
      updated_at: now()

  fun toPrincipal(row: OrderRow): OrderPrincipal
    return OrderPrincipal
      id: OrderId(row.id)
      record: OrderRecord
        status: OrderStatus.from(row.status)
        total: Money.fromCents(row.total_cents)
        couponCode: row.coupon_code != null
          ? CouponCode(row.coupon_code)
          : null
        createdAt: row.created_at
```

### Why Mappers Matter

Mappers are the isolation mechanism. When a change happens in one layer, the mapper absorbs the impact:

- **API format changes** (rename a field, change a date format, version the endpoint) -- update the API mapper. The domain is untouched.
- **Database schema changes** (add a column, change a type, denormalize a table) -- update the data mapper. The domain is untouched.
- **Domain model evolves** (add a new field, refine a type) -- update both mappers. The API and database schemas can follow at their own pace.

This is the architectural version of the [Open-Closed Principle](../solid-principles/index.md): the domain is closed for modification, open for extension through its boundaries.

---

## Error Flow Through Layers

Errors are values, not exceptions. This is [Railway Oriented Programming](../functional-practices/index.md) (ROP) applied to the architecture. Each layer has its own error type, and mappers translate errors just as they translate data.

### Domain Errors (Result Types)

The domain defines its error types as values. Business rule violations, validation failures, not-found conditions -- all represented as data, not thrown exceptions.

```
// Domain error -- a simple union
enum OrderError
  EmptyOrder
  TotalMismatch
  NotFound(id: OrderId)
  AlreadyCancelled
  StorageFailure(message: string)
```

Domain services return `Result<T, OrderError>` (or the language equivalent). The happy path flows on one rail; the error path flows on the other. See [Railway Oriented Programming](../functional-practices/index.md) for the full explanation.

### Data Layer Error Mapping

When the data layer catches an infrastructure error, it maps it to a domain error type. The domain never sees raw database exceptions.

```
// Data layer catches infrastructure error, maps to domain error
fun getById(id: OrderId): Result<Order?, OrderError>
  try
    data = db.orders.findById(id.value)
    return Ok(data?.toDomain())
  catch e: DatabaseException
    return Err(OrderError.StorageFailure(e.message))
```

### API Layer Error Mapping (Problem Details)

When a domain error reaches the API layer, it maps the error to the appropriate transport response. For HTTP APIs, this means [Problem Details (RFC 9457)](https://www.rfc-editor.org/rfc/rfc9457) -- a standardized JSON error format.

```
// Controller maps domain errors to HTTP Problem Details
fun mapError(error: OrderError): HttpResponse
  match error
    OrderError.EmptyOrder =>
      ProblemDetails
        type: "https://errors.example.com/v1/empty_order"
        title: "Empty Order"
        detail: "An order must contain at least one item."
        status: 400

    OrderError.NotFound(id) =>
      ProblemDetails
        type: "https://errors.example.com/v1/entity_not_found"
        title: "Entity Not Found"
        detail: "Order not found."
        status: 404
        data: { requestIdentifier: id.value }

    OrderError.StorageFailure(msg) =>
      ProblemDetails
        type: "https://errors.example.com/v1/internal_error"
        title: "Internal Error"
        detail: msg
        status: 500
```

For a CLI controller, the same domain error becomes a formatted error message and a non-zero exit code. For a WebSocket controller, it becomes an error frame. The domain error is the same; only the presentation changes.

### The Complete Error Flow

```
Database exception
    │
    ▼
Repository catches, maps to ──> OrderError.StorageFailure
    │
    ▼
Domain service returns ──────> Result<Order, OrderError>
    │
    ▼
Controller matches error ────> ProblemDetails { status: 500, ... }
    │
    ▼
HTTP response
```

This completes the mapper story. Mappers translate **data models** between layers (Req/Res to Domain, Domain to Data). Mappers also translate **error types** between layers (infrastructure errors to domain errors, domain errors to transport errors). Both data and errors flow through clean boundaries.

---

## The Full Picture

Here is the complete flow for an HTTP request that creates an order:

```
HTTP Request (JSON body)
    │
    ▼
┌───────────────────────────────────┐
│  Controller                       │
│  1. Parse + validate request      │
│  2. Map request → domain input    │  CreateOrderReq → CreateOrderInput
│  3. Call domain service           │
│  4. Map domain output → response  │  Order → OrderRes
│  5. Map domain error → Problem    │  OrderError → ProblemDetails
│  6. Return HTTP response          │
└───────────────┬───────────────────┘
                │
                ▼
┌───────────────────────────────────┐
│  Domain Service                   │
│  1. Apply business rules (pure)   │
│  2. Call repository interface     │
│  3. Return Result<T, Error>       │
└───────────────┬───────────────────┘
                │
                ▼
┌───────────────────────────────────┐
│  Repository                       │
│  1. Map domain model → data model │  OrderPrincipal → OrderData
│  2. Execute database operation    │
│  3. Map data model → domain model │  OrderData → Order
│  4. Map infra error → domain err  │  DbException → OrderError
│  5. Return Result<T, Error>       │
└───────────────┬───────────────────┘
                │
                ▼
            Database
```

The entire flow is a pipeline of pure transformations punctuated by IO at the edges. The domain in the middle is a pure function from input to output. The controller and repository handle all the messy reality of the outside world.

---

## Wiring at the Entry Point

All three layers are wired together at the application's entry point -- the composition root. This is where concrete implementations are created and injected into the services that depend on them.

```
// main -- the composition root
fun main()
  // 1. Create outward layer (IO adapters)
  db = Database.connect(config.connectionString)
  orderRepo = PostgresOrderRepository(db)
  notifier  = HttpNotificationClient(config.notifyUrl)

  // 2. Create domain services (pure, injected with interfaces)
  orderService = OrderService(orderRepo)

  // 3. Create mappers
  controllerMapper = OrderControllerMapper()

  // 4. Create inward layer (controllers)
  httpController = OrderHttpController(orderService, controllerMapper)

  // 5. Start the application
  server = HttpServer(port: 8080)
  server.route("POST /orders", httpController.create)
  server.route("GET /orders/:id", httpController.getById)
  server.start()
```

The entry point is the only place in the codebase that knows about concrete types. Everything else depends on interfaces. See [Stateless OOP and Dependency Injection](../stateless-oop-di/index.md) for the full explanation of composition roots and constructor injection.

---

## Quick Checklist

- [ ] Three layers: API (inward) / Domain (pure) / Data (outward)
- [ ] Domain has zero IO -- no database, no HTTP, no file system, no console
- [ ] Domain defines interfaces for its external dependencies
- [ ] Each layer has its own models: Req/Res (API), Record/Principal (Domain), Row (Data)
- [ ] API mapper translates between Req/Res and Record/Principal
- [ ] Data mapper translates between Principal and Row
- [ ] Mappers are pure functions with no side effects
- [ ] Data layer catches infrastructure errors and maps them to domain error types
- [ ] API layer maps domain errors to transport errors (Problem Details for HTTP)
- [ ] All wiring happens at the composition root (entry point)
- [ ] Dependency arrows point inward -- outer layers depend on the domain, never the reverse

## Folder Structure

```
lib/                        # Domain layer
  <bounded-context>/
    <entity>/
      structures.ts|cs|go   # Record, Principal, Aggregate
      interfaces.ts|cs|go   # Service, Repository interfaces
      service.ts|cs|go
      errors.ts|cs|go

adapters/                   # Adapter layer
  <bounded-context>/
    <entity>/
      api/
        controller.ts|cs|go
        req.ts|cs|go        # CreateXReq, ListXReq
        res.ts|cs|go        # XRes, XListRes
        validator.ts|cs|go
        mapper.ts|cs|go     # ApiMapper
      data/
        repo.ts|cs|go       # PostgresXRepo, MemoryXRepo
        mapper.ts|cs|go     # DataMapper
```

## Language-Specific Details

See language-specific guides for implementation details:

- [TypeScript/Bun](./languages/typescript.md)
- [C#/.NET](./languages/csharp.md)
- [Go](./languages/go.md)

## Related Articles

- [Software Design Philosophy](../software-design-philosophy/index.md) -- the foundational "why" behind all patterns
- [SOLID Principles](../solid-principles/index.md) -- the principles that govern why layers are separated this way
- [Functional Practices](../functional-practices/index.md) -- immutability, pure functions, total functions, and railway oriented programming
- [Domain-Driven Design](../domain-driven-design/index.md) -- how to model the domain layer (Records, Principals, Aggregates)
- [Stateless OOP and Dependency Injection](../stateless-oop-di/index.md) -- how to structure services and wire the composition root
