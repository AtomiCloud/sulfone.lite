# Stateless OOP and Dependency Injection

Traditional object-oriented programming encourages objects that bundle data and behavior together, holding mutable state internally. This leads to hidden dependencies, surprising side effects, and code that resists change. AtomiCloud takes a different path: we split the world into **structures** (pure data) and **objects** (pure behavior), and wire everything through **constructor injection**.

This article builds on [Software Design Philosophy](../software-design-philosophy/index.md), [SOLID Principles](../solid-principles/index.md), and [Functional Practices](../functional-practices/index.md). The functional constraints (immutability, pure functions, total functions, railway oriented programming) are covered in their own article -- they complement the patterns here by restricting what code is allowed to do.

---

## 1. Structures vs Objects

Every piece of code falls into one of two categories. Mixing them is the root of most design problems.

### Structures: Pure Data

Structures represent facts, state, and values. They carry no behavior. They are immutable, serializable, and inspectable.

```
// Structure -- just data, no behavior
structure UserRecord:
  username: String
  email: string
  active: boolean

structure UserPrincipal:
  id: string
  record: UserRecord

structure User:
  principal: UserPrincipal
```

Structures are the things that flow through your system. They cross network boundaries, get stored in databases, and get passed between services. They are the nouns of your domain.

**Rules for structures:**

- No methods that perform side effects.
- No references to services or adapters.
- Create new instances instead of modifying existing ones.
- Define them with the most data-oriented construct your language provides: `interface`/`type` in TypeScript, `record` in C#, `struct` in Go.

### Objects: Pure Behavior

Objects are services. They contain behavior but own no mutable state. Their only members are **readonly configuration** and **injected dependencies** -- both set once at construction time and never changed.

```
// Object -- behavior with injected dependencies, no mutable state
class UserService:
  private readonly repo: IUserRepository    // injected dependency
  private readonly logger: ILogger          // injected dependency

  constructor(repo: IUserRepository, logger: ILogger):
    this.repo = repo
    this.logger = logger

  greet(user: UserRecord) -> String:        // takes structure, returns structure
    this.logger.log("Greeting " + user.username)
    return "Hello, " + user.username
```

**Rules for objects:**

- Members are either **config values** (readonly) or **injected services** (readonly).
- No mutable instance state. Methods never modify `this`.
- Methods take structures as parameters and return structures.
- Behavior is injected via interfaces, not created internally.

### Why the Split Matters

When structures and objects are cleanly separated:

- **Structures travel freely.** They can be serialized, cached, logged, compared, and sent over the wire without dragging behavior or hidden dependencies along.
- **Objects are testable.** Inject mocks for every dependency. No hidden `new Database()` buried inside a method.
- **Both evolve independently.** Changing the shape of data does not require changing the wiring of services, and vice versa.

This separation is the foundation that makes [SOLID principles](../solid-principles/index.md) practical and [three-layer architecture](../three-layer-architecture/index.md) possible.

---

## 2. Stateless Services

A stateless service is one where **every piece of information flows through method parameters and return values**. The instance itself holds no mutable state -- its members are frozen at construction time.

```
// Stateless -- all state flows through parameters
class OrderService:
  private readonly repo: IOrderRepository
  private readonly pricing: IPricingService

  constructor(repo: IOrderRepository, pricing: IPricingService):
    this.repo = repo
    this.pricing = pricing

  calculateTotal(items: Item[]) -> Money:
    // Uses only the parameters and injected (immutable) dependencies.
    // Does not read or write any instance field.
    return this.pricing.sum(items)
```

Compare this with a stateful service:

```
// WRONG -- stateful service
class OrderService:
  private items: Item[] = []          // mutable state!

  addItem(item: Item) -> void:
    this.items.push(item)             // mutating instance state

  calculateTotal() -> Money:
    return sum(this.items)            // depends on hidden state
```

The stateful version is fragile. The result of `calculateTotal()` depends on what happened before it was called -- which items were added, in which order, and whether any were removed. The method's type signature lies: it claims to take no input, but it secretly depends on the entire mutation history of the object.

**Stateless services eliminate temporal coupling.** The result of a method depends only on what you pass in, not on what happened before. This makes methods:

- **Predictable:** Same inputs, same behavior.
- **Testable:** No setup ceremony to get the object into the right state.
- **Parallelizable:** No shared mutable state means no race conditions between method calls.
- **Debuggable:** You can inspect the arguments to understand the result.

---

## 3. Constructor Injection

All dependencies are passed at construction time. This is the only mechanism for providing collaborators to a service.

### The Rules

1. **Every dependency appears in the constructor.** If a service needs a repository, a logger, and a config value, all three are constructor parameters.
2. **No `new` inside methods.** Services never instantiate their own collaborators. The only place `new` appears for service construction is the entry point.
3. **No service locator.** Never resolve dependencies by asking a container at runtime. The dependency graph is explicit and static.
4. **No static methods for behavior.** Static methods bypass injection entirely -- they cannot be mocked, swapped, or decorated.

### What Constructor Injection Looks Like

```
// Dependencies are explicit, visible, and injectable
class NotificationService:
  private readonly email: IEmailSender
  private readonly templates: ITemplateEngine
  private readonly logger: ILogger

  constructor(email: IEmailSender, templates: ITemplateEngine, logger: ILogger):
    this.email = email
    this.templates = templates
    this.logger = logger

  sendWelcome(user: UserRecord) -> Result<Unit, SendError>:
    body = this.templates.render("welcome", user)
    return this.email.send(user.email, "Welcome!", body)
```

Every dependency is visible in the constructor signature. There are no surprises, no hidden calls to global state, no lazy initialization. A reader can look at the constructor and immediately know the full set of collaborators.

### Why Not Static?

Static methods and global state cut through the dependency tree. They bypass injection, which means:

- **Not testable.** You cannot swap a static method with a mock.
- **Not swappable.** Production, testing, and development all get the same implementation.
- **Not decoratable.** You cannot wrap a static call with tracing, caching, or retry logic.

```
// WRONG -- static method hides the dependency
class UserService:
  static getUser(id: String) -> User:
    return Database.query("SELECT * FROM users WHERE id = ?", id)

// RIGHT -- dependency is injected and swappable
class UserService:
  private readonly db: IDatabase
  constructor(db: IDatabase):
    this.db = db

  getUser(id: String) -> User:
    return this.db.query("SELECT * FROM users WHERE id = ?", id)
```

The injectable version can be tested with a mock database, decorated with tracing, and swapped for a different implementation per environment -- all without changing a single line of `UserService`.

---

## 4. Entry Point Wiring

All services are created at the application entry point -- the "big bang" of the dependency graph. This is the only place where constructors are called for services and adapters.

```
// main -- the composition root
function main():
  // 1. Create adapters (impure IO boundaries)
  fs         = new FileSystemAdapter()
  httpClient = new HttpClientAdapter()
  logger     = new ConsoleLogger()
  db         = new PostgresAdapter(connectionString)

  // 2. Create domain services (pure behavior + DI)
  userRepo   = new UserRepository(db)
  emailSender = new SmtpEmailSender(httpClient)
  userService = new UserService(userRepo, logger)
  notifier   = new NotificationService(emailSender, logger)

  // 3. Create entry-level orchestrator
  app = new Application(userService, notifier)

  // 4. Start
  app.run()
```

### Why Wire at the Entry Point?

- **The entire dependency graph is visible in one place.** No hunting through factories, lazy initializers, or service locator registrations to understand what depends on what.
- **All dependencies are ready before any logic runs.** No "first request" initialization surprises.
- **Swapping implementations is trivial.** For tests, replace the adapter constructors with mocks. For a different environment, pass different config. The services themselves do not change.

The dependency graph is a **tree**, not a mutable web. Each service receives its dependencies once, at construction, and those references never change. There is no re-wiring at runtime, no conditional resolution, no ambient context.

This pattern applies regardless of whether you wire manually (as in TypeScript or Go) or use a DI container (as in C#). The principle is the same: construct everything once, up front, at the root.

---

## 5. Quick Checklist

**Structures vs Objects:**

- [ ] Structures are pure data -- no side effects, no service references.
- [ ] Objects (services) hold only readonly config and injected dependencies.
- [ ] Service methods take structures as input and return structures as output.

**Stateless Services:**

- [ ] No mutable instance state on any service.
- [ ] All members are `readonly` (or language equivalent) and set at construction.
- [ ] All state flows through method parameters and return values.

**Constructor Injection:**

- [ ] Every dependency appears in the constructor signature.
- [ ] No `new` inside service methods (except for simple data transfer objects).
- [ ] No service locator or ambient context patterns.
- [ ] No static methods that contain business logic.
- [ ] Interfaces defined for all external dependencies (repositories, HTTP clients, file systems).

**Entry Point Wiring:**

- [ ] All services constructed at the application entry point (composition root).
- [ ] Dependency graph is a tree, wired once and never mutated.
- [ ] Swapping implementations requires changing only the entry point.

---

## Related Articles

- [Software Design Philosophy](../software-design-philosophy/index.md) -- the foundational "why" behind all patterns
- [SOLID Principles](../solid-principles/index.md) -- the principles that motivate these patterns
- [Functional Practices](../functional-practices/index.md) -- immutability, pure functions, total functions, and railway oriented programming
- [Domain-Driven Design](../domain-driven-design/index.md) -- how structures map to Records, Principals, and Aggregate Roots
- [Three-Layer Architecture](../three-layer-architecture/index.md) -- how layers, mappers, and error mappers fit together

## Language-Specific Details

See language-specific guides for implementation details:

- [TypeScript/Bun](./languages/typescript.md)
- [C#/.NET](./languages/csharp.md)
- [Go](./languages/go.md)

## Folder Structure

Domain services follow the bounded context structure from [Domain-Driven Design](../domain-driven-design/index.md):

```
lib/                        # Domain layer
  <bounded-context>/
    <entity>/
      structures.ts|cs|go   # Record, Principal
      interfaces.ts|cs|go   # IXxxService, IXxxRepository
      service.ts|cs|go      # XxxService implementation
      errors.ts|cs|go       # XxxNotFound, XxxValidationError

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
