# Functional Practices

The [SOLID principles](../solid-principles/index.md) give us the rules for managing dependencies. Functional practices constrain the system further, eliminating entire categories of bugs by restricting what code is allowed to do. These four practices -- immutability, pure functions, total functions, and railway oriented programming -- apply across every AtomiCloud codebase regardless of language.

This article builds on [Software Design Philosophy](../software-design-philosophy/index.md) and [SOLID Principles](../solid-principles/index.md). The patterns described here are used extensively by [Three-Layer Architecture](../three-layer-architecture/index.md) (error mapping between layers) and [Stateless OOP with DI](../stateless-oop-di/index.md) (stateless services and immutable structures).

---

## Immutability

Immutability means never modifying existing data. Instead, every transformation produces a new value.

### The Rule

Never mutate inputs. Always return new values.

```
// WRONG -- mutates the input
function applyDiscount(order: Order, pct: Float) -> Order:
  order.total = order.total * (1 - pct)   // caller's data is corrupted
  return order

// RIGHT -- returns a new value
function applyDiscount(order: Order, pct: Float) -> Order:
  return Order(
    ...order,
    total: order.total * (1 - pct)
  )
```

The caller's original `order` is untouched. There are no surprises, no temporal coupling, no need to track mutation history.

### Benefits

- **Predictable:** Data does not change under you.
- **Thread-safe:** No locks needed -- immutable data cannot cause race conditions.
- **Debuggable:** You can always inspect the original and the transformed value side by side.
- **Enables time-travel:** Undo/redo, event sourcing, and audit logs all become trivial when every state is a new snapshot.

---

## Pure Functions

A pure function's output depends only on its inputs, and it produces no side effects. It does not read global state, write to a database, log a message, or throw an exception.

```
// Pure -- output depends only on inputs
function calculateTax(amount: Money, rate: Float) -> Money:
  return amount * rate

// Impure -- reads external state, writes to a log
function calculateTax(amount: Money) -> Money:
  rate = GlobalConfig.taxRate       // reads global state
  Logger.log("Calculating tax")     // side effect
  return amount * rate
```

Pure functions are:

- **Testable:** Call with inputs, assert on output. No setup, no teardown, no mocking.
- **Cacheable:** Same inputs always produce the same output, so results can be memoized.
- **Parallelizable:** No shared state means no ordering constraints.
- **Locally reasoned about:** You can understand the function by reading it alone, without tracing call chains or global state.

**The entire domain layer should be pure.** Domain logic operates on structures and returns structures. Side effects (database calls, HTTP requests, logging) live at the boundaries -- in adapters and controllers. This is the central insight of [Three-Layer Architecture](../three-layer-architecture/index.md): the domain is a pure computational core surrounded by impure IO shells.

---

## Total Functions

A total function returns a valid result for **every valid input**. It never throws, never panics, never returns undefined behavior.

Contrast with a partial function:

```
// Partial function -- LIES about its type
function divide(a: Int, b: Int) -> Int:
  if b == 0:
    throw DivisionByZeroError    // type says Int, but sometimes throws
  return a / b

// Total function -- HONEST about its type
function divide(a: Int, b: Int) -> Result<Int, DivisionError>:
  if b == 0:
    return Err(DivisionError("cannot divide by zero"))
  return Ok(a / b)
```

The partial version lies. Its type signature says "give me two ints and I will give you an int." But for some inputs, it blows up. Every caller must remember to wrap it in try/catch, and the compiler cannot help them remember.

The total version tells the truth. Its return type says "you will get either an Int or a DivisionError." The caller is forced by the type system to handle both cases.

**Rules for total functions:**

- Never throw exceptions for expected failure paths. Exceptions are for truly unexpected situations (out of memory, hardware failure).
- Encode failure in the return type using `Result<T, E>` (or the language equivalent).
- The type signature is the contract. It must be honest about all possible outcomes.

---

## Railway Oriented Programming

Railway oriented programming (ROP) is the composable pattern that makes total functions practical at scale. It models computation as two parallel rails: a **happy path** (success) and an **error path** (failure).

### The Result Type

At the core is `Result<T, E>` -- a value that is either `Ok(T)` (success) or `Err(E)` (failure).

```
Result<User, UserError>
  = Ok(User { id: "1", name: "Alice" })
  | Err(UserError.NotFound("1"))
```

### Composing Results

ROP provides a small set of combinators that chain operations without manual error checking:

| Combinator                      | Purpose                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `.map(fn)`                      | Transform the success value. Errors pass through unchanged.                       |
| `.mapErr(fn)`                   | Transform the error value. Successes pass through unchanged.                      |
| `.andThen(fn)` / `.flatMap(fn)` | Chain to another operation that also returns a `Result`. Short-circuits on error. |
| `.match(ok, err)`               | Handle both cases explicitly. Terminal operation.                                 |

### A Chained Example

Without ROP, error handling is repetitive and obscures the business logic:

```
// Without ROP -- manual error checking at every step
function processOrder(id: String) -> Result<Invoice, OrderError>:
  orderResult = repo.getOrder(id)
  if orderResult.isErr():
    return Err(orderResult.unwrapErr())

  order = orderResult.unwrap()
  validationResult = validator.validate(order)
  if validationResult.isErr():
    return Err(validationResult.unwrapErr())

  pricingResult = pricing.calculate(order)
  if pricingResult.isErr():
    return Err(pricingResult.unwrapErr())

  return Ok(Invoice.from(pricingResult.unwrap()))
```

With ROP, the happy path reads like a straight line:

```
// With ROP -- composable chain, errors handled automatically
function processOrder(id: String) -> Result<Invoice, OrderError>:
  return repo.getOrder(id)
    .andThen(order -> validator.validate(order))
    .andThen(order -> pricing.calculate(order))
    .map(priced -> Invoice.from(priced))
```

If any step fails, the error propagates down the error rail automatically. No manual checking, no nested if/else, no forgotten error paths.

### Error Mapping Between Layers

ROP completes the mapper story from [Three-Layer Architecture](../three-layer-architecture/index.md). In a three-layer system, each layer has its own data models **and its own error types**. Mappers convert data between layers; `.mapErr()` converts errors between layers.

```
// Repository returns RepositoryError
// Domain needs DomainError
// Controller needs ProblemDetails

function getUser(id: String) -> Result<UserResponse, ProblemDetails>:
  return userRepo.findById(id)                        // Result<DataModel, RepoError>
    .map(data -> toUserDomain(data))                  // Result<User, RepoError>
    .mapErr(repoErr -> toDomainError(repoErr))        // Result<User, DomainError>
    .andThen(user -> enrichUser(user))                 // Result<EnrichedUser, DomainError>
    .map(user -> toUserResponse(user))                 // Result<UserResponse, DomainError>
    .mapErr(domErr -> toProblemDetails(domErr))         // Result<UserResponse, ProblemDetails>
```

Data flows forward through `.map()` and `.andThen()`. Errors flow sideways through `.mapErr()`. The entire pipeline is composable, type-safe, and explicit about every transformation.

---

## Grouping, Not Encapsulation

We prefer **grouping** over **encapsulation**.

Encapsulation implies hiding -- the private/public distinction, information hiding, secrets kept within boundaries. While this sounds good in theory, it often leads to code that hides too much. Private methods become hidden dependencies. Internal state becomes a black box that tests cannot inspect.

**Grouping** means putting related things together:

- Things that change together? Group them.
- Things that share a reason to change? Group them.
- Things that form a cohesive concept? Group them.

Grouping does not require hiding. A group can be fully transparent -- every member visible, every dependency explicit -- while still providing the benefit of cohesion.

---

## Quick Checklist

**Immutability:**

- [ ] Never mutate input parameters -- always return new values.
- [ ] Use immutable data constructs (`record`, `readonly`, ownership semantics).

**Pure Functions:**

- [ ] Domain logic depends only on its inputs and produces no side effects.
- [ ] Side effects are confined to adapters and controllers at the system boundary.

**Total Functions:**

- [ ] Expected failures are encoded in the return type (`Result<T, E>`), not thrown as exceptions.
- [ ] Type signatures honestly describe all possible outcomes.

**Railway Oriented Programming:**

- [ ] Results are composed using `.map()`, `.andThen()`, `.mapErr()`.
- [ ] Error types are mapped between layers just like data types.
- [ ] No bare `try/catch` wrapping expected error paths.

**Grouping:**

- [ ] Related code lives together -- grouped by reason to change.
- [ ] Dependencies remain visible even within groups.
- [ ] No hiding behind private/public boundaries that obscure behavior.

---

## Language-Specific Details

See language-specific guides for implementation details:

- [TypeScript/Bun](./languages/typescript.md)
- [C#/.NET](./languages/csharp.md)
- [Go](./languages/go.md)

## Related Articles

- [Software Design Philosophy](../software-design-philosophy/index.md) -- the foundational "why" behind all practices
- [SOLID Principles](../solid-principles/index.md) -- the rules that motivate these constraints
- [Domain-Driven Design](../domain-driven-design/index.md) -- how structures map to Records, Principals, and Aggregate Roots
- [Three-Layer Architecture](../three-layer-architecture/index.md) -- how layers, mappers, and error mappers fit together
- [Stateless OOP and Dependency Injection](../stateless-oop-di/index.md) -- how stateless services and immutable structures are wired
