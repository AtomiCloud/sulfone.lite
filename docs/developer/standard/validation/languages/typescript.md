# Validation in TypeScript/Bun

## Library: Zod

Zod is a TypeScript-first schema validation library with static type inference.

```bash
bun add zod
```

```typescript
import { z } from 'zod';
```

## Schema Definition

### Primitives

```typescript
// Basic types
z.string();
z.number();
z.boolean();
z.null();
z.undefined();
z.any();
z.unknown();

// Coercion (parse string to number, etc.)
z.coerce.number(); // "42" -> 42
z.coerce.boolean(); // "true" -> true
z.coerce.date(); // "2024-03-15" -> Date

// String validation
z.string().min(2);
z.string().max(100);
z.string().length(10);
z.string().email();
z.string().url();
z.string().uuid();
z.string().regex(/^\d{5}$/);
z.string().trim();
z.string().toLowerCase();

// Number validation
z.number().int();
z.number().positive();
z.number().negative();
z.number().min(0);
z.number().max(100);
z.number().finite();

// Optional/nullable
z.string().optional(); // string | undefined
z.string().nullable(); // string | null
z.string().nullish(); // string | null | undefined
z.string().default('default value');
```

### Objects

```typescript
// Basic object
const UserSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  age: z.number().int().positive().optional(),
});

// Partial (all fields optional)
const PartialUserSchema = UserSchema.partial();

// Pick/Omit
const NameOnlySchema = UserSchema.pick({ name: true });
const WithoutAgeSchema = UserSchema.omit({ age: true });

// Extend
const AdminSchema = UserSchema.extend({ role: z.literal('admin') });

// Merge
const MergedSchema = UserSchema.merge(AnotherSchema);

// Strict (reject unknown keys)
const StrictSchema = z.object({ name: z.string() }).strict();

// Passthrough (allow unknown keys)
const LooseSchema = z.object({ name: z.string() }).passthrough();
```

### Arrays

```typescript
// Basic array
z.array(z.string());
z.array(z.number());

// Constraints
z.array(z.string()).min(1); // at least 1 element
z.array(z.string()).max(10); // at most 10 elements
z.array(z.string()).length(5); // exactly 5 elements
z.array(z.string()).nonempty(); // at least 1 element

// Tuple
z.tuple([z.string(), z.number()]); // [string, number]
```

### Unions and Literals

```typescript
// Union
z.union([z.string(), z.number()]);
z.string().or(z.number()); // shorthand

// Literal
z.literal('active');
z.literal(42);

// Enum-like
const StatusSchema = z.enum(['pending', 'active', 'completed']);
type Status = z.infer<typeof StatusSchema>; // 'pending' | 'active' | 'completed'

// Discriminated union
const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('keypress'), key: z.string() }),
]);
```

### Records

```typescript
// String keys, string values
z.record(z.string());

// String keys, number values
z.record(z.number());

// Custom key type
z.record(z.string().regex(/^\d+$/), z.boolean());
```

## Parsing

### parse

Throws on invalid data:

```typescript
try {
  const user = UserSchema.parse(input);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.log(error.errors);
  }
}
```

### safeParse

Returns result object, never throws:

```typescript
const result = UserSchema.safeParse(input);

if (result.success) {
  const user = result.data;
} else {
  const errors = result.error.errors;
}
```

### parseAsync

For async refinements:

```typescript
const result = await UserSchema.parseAsync(input);
```

## Type Inference

```typescript
const UserSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  age: z.number().optional(),
});

// Infer type from schema
type User = z.infer<typeof UserSchema>;
// { name: string; email: string; age?: number | undefined }

// Infer input type (before transformations)
type UserInput = z.input<typeof UserSchema>;
```

## Transformations

Transform data during parsing:

```typescript
const SearchSchema = z.object({
  query: z.string().transform(q => q.toLowerCase().trim()),
  page: z.coerce.number().default(1),
  limit: z.coerce.number().default(20),
});

const result = SearchSchema.parse({ query: '  HELLO  ' });
// { query: "hello", page: 1, limit: 20 }
```

## Refinements

Custom validation logic:

```typescript
const PasswordSchema = z
  .string()
  .min(8)
  .refine(password => /[A-Z]/.test(password), 'Must contain uppercase letter')
  .refine(password => /[0-9]/.test(password), 'Must contain a number');

// Async refinement
const UsernameSchema = z.string().refine(async username => {
  const exists = await checkUsernameExists(username);
  return !exists;
}, 'Username already taken');
```

## Cross-Field Validation

```typescript
const RegistrationSchema = z
  .object({
    password: z.string().min(8),
    confirmPassword: z.string(),
  })
  .refine(data => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });
```

## Error Handling

```typescript
const result = UserSchema.safeParse(input);

if (!result.success) {
  const formatted = result.error.format();
  // {
  //   email: { _errors: ["Invalid email"] },
  //   age: { _errors: ["Must be a positive number"] },
  //   _errors: []
  // }

  // Or flat list
  const errors = result.error.errors;
  // [
  //   { path: ["email"], message: "Invalid email", code: "invalid_string" },
  //   { path: ["age"], message: "Must be a positive number", code: "too_small" }
  // ]
}
```

## Integration Patterns

### Express Request Validation

```typescript
import { z } from 'zod';
import { Request, Response } from 'express';

const CreateUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  age: z.number().int().positive().optional(),
});

// Express handler
async function createUser(req: Request, res: Response) {
  const result = CreateUserSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      errors: result.error.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  const user = result.data; // typed!
  // ...
}
```

### Bun/Fetch Request Validation

```typescript
import { z } from 'zod';

const CreateUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  age: z.number().int().positive().optional(),
});

// Bun/Fetch handler
async function createUser(req: Request): Promise<Response> {
  const result = CreateUserSchema.safeParse(await req.json());

  if (!result.success) {
    return new Response(
      JSON.stringify({
        errors: result.error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const user = result.data; // typed!
  // ...
}
```

### Domain Invariants

```typescript
// Domain type with invariant
class Email {
  private constructor(private readonly value: string) {}

  static create(value: string): Result<Email, string> {
    const schema = z.string().email();
    const result = schema.safeParse(value);

    if (!result.success) {
      return err('Invalid email format');
    }
    return ok(new Email(value));
  }

  get Value() {
    return this.value;
  }
}
```
