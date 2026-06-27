# Data Validation

Validation ensures data meets expected constraints before processing. This guide defines validation patterns, when to use them, and how to implement them across AtomiCloud projects.

This article builds on [Three-Layer Architecture](../three-layer-architecture/index.md) and [Error Handling](../functional-practices/index.md). Validation happens at layer boundaries, and validation errors follow error-handling conventions.

---

## Why Use Validation Libraries

### Reduce Boilerplate

Without libraries, validation code is repetitive:

```typescript
// Manual validation - lots of boilerplate
function validateUser(input: unknown): User {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid input');
  }
  if (typeof input.name !== 'string' || input.name.length < 2) {
    throw new Error('Name must be at least 2 characters');
  }
  if (!input.email.includes('@')) {
    throw new Error('Invalid email');
  }
  // ... more checks
  return input as User;
}
```

With a library, it's declarative:

```typescript
// Zod schema - concise, type-safe
const UserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
});

const user = UserSchema.parse(input); // throws on invalid, returns typed User
```

### Reduce Tests

Validation libraries are battle-tested. You don't need to test that:

- Email validation works correctly
- Minimum/maximum constraints are enforced
- Required fields are checked
- Type coercion handles edge cases

You only test your custom validators.

### Type Safety

Schemas can infer types, ensuring your validation and types never drift:

```typescript
const UserSchema = z.object({
  name: z.string(),
  age: z.number().int().positive(),
});

type User = z.infer<typeof UserSchema>; // { name: string; age: number }
```

---

## Validation at Boundaries

### Input Validation

Validate all external input at the API boundary (controllers, adapters):

```text
External World → [Validate] → Controller → Domain
```

**What to validate:**

- Presence (required fields)
- Format (email, URL, date format)
- Range (min/max numbers, string length)
- Type (string, number, boolean)
- Structure (nested objects, arrays)

**What NOT to validate:**

- Business rules (belongs in domain)
- Cross-field dependencies (often domain invariants)
- Existence checks (database queries)

### Domain Invariants

Business rules live in the domain layer:

```csharp
// Domain invariant in entity
public record Order
{
    public Money Total { get; init; }

    public Order(Money total)
    {
        if (total.Amount < 0)
            throw new DomainException("Order total cannot be negative");
        Total = total;
    }
}
```

### Input Validation vs Domain Invariants

| Aspect     | Input Validation        | Domain Invariants                    |
| ---------- | ----------------------- | ------------------------------------ |
| Location   | API boundary            | Domain constructors/methods          |
| Purpose    | Sanitize external input | Enforce business rules               |
| Examples   | Email format, required  | Order total >= 0, status transitions |
| Error type | ValidationError (400)   | DomainException (422/500)            |
| Library    | Validation library      | Domain code                          |

---

## Validation Patterns

### Schema Validation

Define a schema, parse input against it:

```typescript
const CreateOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
  shippingAddress: z.object({
    street: z.string(),
    city: z.string(),
    zipCode: z.string().regex(/^\d{5}$/),
  }),
});

const order = CreateOrderSchema.parse(requestBody);
```

### Transform and Validate

Parse, then transform:

```typescript
const SearchSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().max(100).default(20),
  query: z.string().trim().optional(),
});

// "page=2&limit=50" -> { page: 2, limit: 50, query: undefined }
```

### Cross-Field Validation

Validate relationships between fields:

```go
type Registration struct {
    Password     string `validate:"required,min=8"`
    Confirmation string `validate:"required,eqfield=Password"`
}
```

---

## Error Messages

Return meaningful, actionable errors:

```json
{
  "errors": {
    "email": ["Must be a valid email address"],
    "age": ["Must be at least 18"],
    "items[0].quantity": ["Must be greater than 0"]
  }
}
```

**Guidelines:**

- Field-specific errors (not just "validation failed")
- Actionable messages (tell user what to fix)
- Don't expose internal structure
- Use consistent format

---

## Quick Checklist

**Input Validation:**

- [ ] All external input validated at boundary
- [ ] Required fields checked
- [ ] Format validation (email, URL, etc.)
- [ ] Range constraints (min/max)
- [ ] Type safety from schema
- [ ] Meaningful error messages

**Domain Invariants:**

- [ ] Business rules in domain layer
- [ ] Entity constructors enforce invariants
- [ ] Meaningful domain exceptions

**General:**

- [ ] Use validation library, not hand-coded
- [ ] Don't test library validators
- [ ] Parse, don't validate

---

## Language-Specific Details

See language-specific guides for implementation details:

- [TypeScript/Bun](./languages/typescript.md) — Zod library usage
- [C#/.NET](./languages/csharp.md) — FluentValidation library usage
- [Go](./languages/go.md) — go-playground/validator struct tags

## Related Articles

- [Three-Layer Architecture](../three-layer-architecture/index.md) — Where validation happens
- [Error Handling](../functional-practices/index.md) — Returning validation errors
- [Domain Modeling](../domain-driven-design/index.md) — Domain invariants
