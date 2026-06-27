# Domain-Driven Design

We adopt DDD's proven tactical patterns while discarding the ceremony. You will not find event-sourcing sagas, domain events, or specification objects here. What you will find is a practical, opinionated structure for modelling your domain that keeps code clean, testable, and easy to change.

This article builds on the foundation laid by [Software Design Philosophy](../software-design-philosophy/index.md), [SOLID Principles](../solid-principles/index.md), [Functional Practices](../functional-practices/index.md), [Stateless OOP with Dependency Injection](../stateless-oop-di/index.md), and [Three-Layer Architecture](../three-layer-architecture/index.md). Read those first if you have not already.

---

## Start with the Domain

Before you choose a framework, before you pick a database, before you draw an API schema -- design your domain in pure code.

The principle: **commit to a programming language, but do not let the domain assume infrastructure.** The domain layer should contain zero references to HTTP, SQL, file systems, or any external service. It is pure logic operating on pure data.

Benefits of domain-first design:

1. **Testability.** Domain logic is exercised with plain unit tests -- no containers, no mocking frameworks, no network calls.
2. **Portability.** The same domain can be served over REST today and gRPC tomorrow. It can persist to PostgreSQL or DynamoDB. The domain does not care.
3. **Clarity.** Stakeholders can read the domain model and recognise their business concepts without wading through serialisation annotations and ORM decorators.

---

## Ubiquitous Language

Every concept in your system deserves a proper noun. Vague words breed confusion and subtle bugs.

**The rule:** If two developers could reasonably disagree about what a name means, rename it.

| Bad       | Good                           | Why                           |
| --------- | ------------------------------ | ----------------------------- |
| `user`    | `ToolUser`, `EndUser`          | Two distinct kinds of users   |
| `data`    | `PostRecord`, `PostPrincipal`  | Domain types with clear roles |
| `item`    | `OrderLineItem`, `CartItem`    | Bounded context specific      |
| `service` | `PostService`, `AuthorService` | Domain-qualified              |

Ubiquitous language extends beyond domain types. AtomiCloud uses arbitrary names for cross-cutting concepts precisely to avoid overloaded terms:

- **Chemical elements** for projects (hydrogen, helium, lithium)
- **Pokemon** for environments (pikachu, charmander, squirtle)

These names carry no pre-existing baggage. When a name has exactly one meaning in your codebase, ambiguity disappears.

---

## Bounded Context

A bounded context is a sub-module that operates as a closed ecosystem. Inside its boundary, the ubiquitous language is consistent and unambiguous. Outside, the same word may mean something different entirely.

Bounded contexts are **larger-scale versions of the classes we write in OOP**:

| OOP Class                    | Bounded Context             |
| ---------------------------- | --------------------------- |
| Single responsibility        | Single business capability  |
| Dependencies via constructor | Dependencies via interfaces |
| No hidden globals            | No shared database tables   |
| Testable in isolation        | Testable in isolation       |

**Test:** Can you assign a single team to own this context? If not, the boundary might be wrong. Bounded contexts align with organizational boundaries.

---

## Two Classes of Things

Everything in a codebase falls into one of two categories:

| Category       | Also Known As | Has Behaviour? | Has Identity?  | Injected?               |
| -------------- | ------------- | -------------- | -------------- | ----------------------- |
| **Objects**    | Services      | Yes            | No (stateless) | Yes, via constructor    |
| **Structures** | Data, Models  | No             | Sometimes      | No, passed as arguments |

**Objects** are services. They contain behaviour -- business logic, orchestration, validation. They receive other services (and configuration) through constructor injection. They are stateless: no mutable fields, no hidden state.

**Structures** are pure data. They carry properties but no behaviour. They are immutable containers that flow through the system as method arguments and return values.

The contract is simple: **service methods take structures as input and return structures as output.** Services never accept other services as method arguments -- those come through the constructor. Structures never depend on services -- they are inert data.

See [Stateless OOP and Dependency Injection](../stateless-oop-di/index.md) for the full treatment of this distinction.

---

## Records, Principals, and Aggregate Roots

Three levels of structure appear in every CRUD-oriented domain. These correspond loosely to DDD's value objects, entities, and aggregate roots -- but with important differences.

### Records (Updateable Data)

A Record is a structure with no identity. It contains every field that a Create or Update form would ask for.

```
PostRecord:
  title: string
  description: string
  tags: string[]

AuthorRecord:
  name: string
  date_of_birth: date
```

Records deliberately exclude the identifier because:

- **At creation time**, the ID does not exist yet
- **At update time**, the ID is passed separately (it cannot be changed)
- **Identity is not data you change -- it is something you reference**

### Multiple Records per Entity

An entity can have **multiple Records** when its fields have different **rates of change**. Separating records by update frequency improves cache efficiency, reduces optimistic locking conflicts, and clarifies which operations affect which data.

```
// User has 3 records with different update rates

UserRecord:              // Frequently changed by user
  displayName: string
  bio: string
  avatarUrl: string

UserImmutableRecord:     // Locked at creation, never changes
  email: string
  createdAt: timestamp

UserSyncRecord:          // Updated by external sync, infrequent
  stripeCustomerId: string
  githubId: string
  lastSyncAt: timestamp
```

**Why separate by rate of change:**

| Record Type           | Update Frequency    | Who Changes It    | Example Operations       |
| --------------------- | ------------------- | ----------------- | ------------------------ |
| `UserRecord`          | High                | User actions      | Profile edits, settings  |
| `UserImmutableRecord` | Never (create-only) | System at signup  | Account creation         |
| `UserSyncRecord`      | Low (periodic)      | External sync job | OAuth sync, billing sync |

The Principal holds all records together:

```
UserPrincipal:
  id: uuid
  record: UserRecord           // Mutable profile data
  immutable: UserImmutableRecord  // Create-only data
  sync: UserSyncRecord         // Externally synced data
```

This separation enables:

- **Targeted updates**: `updateProfile(id, UserRecord)` doesn't touch sync data
- **Cache efficiency**: Frequently-read data (profile) separate from rarely-read (sync metadata)
- **Concurrency**: Profile updates don't conflict with sync updates
- **Clear ownership**: API layer updates `UserRecord`, sync service updates `UserSyncRecord`

### Principals (Records with Identity)

A Principal is one or more Records with an ID. It represents the entity as stored in a database.

**Single Record (simple entity):**

```
PostPrincipal:
  id: uuid
  record: PostRecord

AuthorPrincipal:
  id: uuid
  record: AuthorRecord
```

**Multiple Records (entity with different update rates):**

```
UserPrincipal:
  id: uuid
  record: UserRecord           // Mutable profile
  immutable: UserImmutableRecord  // Create-only
  sync: UserSyncRecord         // Externally synced
```

The identity makes a Principal unique even when its record data changes. Post #42 is still post #42 after you edit the title.

Principals are the **primary unit of storage and retrieval**. A database table maps directly to a Principal: the primary key is the `id`, and the remaining columns come from the Record(s).

### Aggregate Roots (Assembled Views)

An Aggregate Root is a view that shows a Principal together with its related Principals. It represents the **full picture** of a concept as needed by a particular use-case.

```
Post:                    // Aggregate root for viewing a post
  principal: PostPrincipal
  author: AuthorPrincipal

Author:                  // Aggregate root for viewing an author
  principal: AuthorPrincipal
  posts: PostPrincipal[]
```

`Post` and `Author` are two different aggregate roots that reference each other's principals. They are **views** -- shaped by what the consuming service needs.

---

## CRUD Mapping (Blessed Path)

With three structure types defined, we can map the five standard CRUD operations to the types they consume and produce.

| Operation  | Input          | Output          | Why?                                               |
| ---------- | -------------- | --------------- | -------------------------------------------------- |
| **Search** | Search params  | `Principal[]`   | Single table, no joins, fast for lists             |
| **Get**    | `id`           | `AggregateRoot` | Full view with related data                        |
| **Create** | `Record`       | `AggregateRoot` | No ID needed -- system generates it                |
| **Update** | `id`, `Record` | `AggregateRoot` | ID is separate because identity cannot be replaced |
| **Delete** | `id`           | `void`          | Nothing to return                                  |

### Service Interface Example

```
interface PostService:
  search(params: PostSearch): Result<PostPrincipal[]>
  get(id: uuid): Result<Post?>
  create(record: PostRecord): Result<Post>
  update(id: uuid, record: PostRecord): Result<Post?>
  delete(id: uuid): Result<void?>
```

And the corresponding repository interface follows the same shape:

```
interface PostRepository:
  search(params: PostSearch): Result<PostPrincipal[]>
  get(id: uuid): Result<Post?>
  create(record: PostRecord): Result<Post>
  update(id: uuid, record: PostRecord): Result<Post?>
  delete(id: uuid): Result<void?>
```

The service orchestrates business rules; the repository handles persistence. Both speak the same language of Records, Principals, and Aggregate Roots. See [Three-Layer Architecture](../three-layer-architecture/index.md) for how these layers connect.

---

## Quick Checklist

Before calling a domain complete, verify:

- [ ] **Domain isolation.** The domain module has zero imports from HTTP, database, or framework packages.
- [ ] **Ubiquitous language.** Every concept has a precise, unambiguous name. No overloaded terms.
- [ ] **Bounded contexts.** Each module owns its types. No cross-module imports of internal models. Boundaries align with team ownership.
- [ ] **Two classes.** Services have behaviour and receive dependencies via constructor. Structures are pure data passed as arguments.
- [ ] **Records defined.** Every entity has at least one Record containing its updateable fields (no ID). Entities with different update rates may have multiple Records.
- [ ] **Principals defined.** Every entity has a Principal combining its identity with its Record(s). Single Record for simple entities, multiple Records for entities with different update rates.
- [ ] **Aggregate roots defined.** Every entity that needs related data has an Aggregate Root assembling the relevant Principals.
- [ ] **CRUD mapping followed.** Search returns Principals. Get/Create/Update return Aggregate Roots. Delete returns nothing.
- [ ] **No identity in Records.** The `id` field lives in the Principal, never in the Record.
- [ ] **Aggregate roots as views.** Different services may define different aggregate roots for the same Principal, each shaped to its needs.

---

## Language-Specific Details

See language-specific guides for implementation details:

- [TypeScript/Bun](./languages/typescript.md)
- [C#/.NET](./languages/csharp.md)
- [Go](./languages/go.md)
