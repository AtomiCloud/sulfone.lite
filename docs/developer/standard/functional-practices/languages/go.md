# Functional Practices in Go

## Immutability

Go does not enforce immutability at the type level. Convention-based approach:

- Return new structs instead of mutating
- Use value receivers where possible
- Avoid pointer receivers unless mutation is the explicit purpose

```go
type User struct {
    Id    string
    Name  string
    Email string
}

func UpdateName(user User, name string) User {
    user.Name = name
    return user
}
```

## Pure Functions

Methods on structs are pure when all fields are immutable. No standalone functions for business logic.

```go
// Pure method — all fields immutable
type NameFormatter struct {
    suffix string  // unexported + immutable → method is pure
}

func (f *NameFormatter) Format(first, last string) string {
    return first + " " + last + " " + f.suffix
}

// Impure — reads clock (external state)
type TimestampFormatter struct{}

func (f *TimestampFormatter) Format(name string) string {
    return fmt.Sprintf("%s at %s", name, time.Now().Format(time.RFC3339))
}
```

**Rule:** Methods are pure if all struct fields are set at construction and never mutated, and the method has no side effects.

## Error Handling — (value, error) Pattern

Go uses `(value, error)` returns. No Result type, no ROP.

**Basic pattern:**

```go
func GetUser(ctx context.Context, id string) (*User, error) {
    user, err := repo.FindById(ctx, id)
    if err != nil {
        return nil, fmt.Errorf("get user %s: %w", id, err)
    }
    return user, nil
}
```

**Error wrapping with context:**

```go
if err != nil {
    return nil, fmt.Errorf("process order %s: %w", id, err)
}
```

**Error inspection:**

```go
if errors.Is(err, ErrNotFound) { /* handle */ }

var notFound *OrderNotFoundError
if errors.As(err, &notFound) { /* use notFound.Id */ }
```

**Custom error types:**

```go
var ErrNotFound = errors.New("not found")

type OrderNotFoundError struct {
    Id string
}
func (e *OrderNotFoundError) Error() string {
    return fmt.Sprintf("order not found: %s", e.Id)
}
```

**Rules:**

- Every error checked with `if err != nil`
- Never ignore returned errors
- Wrap errors with context at each boundary via `fmt.Errorf` + `%w`
- Use `errors.Is`/`errors.As` for inspection
- Sentinel errors for simple types, struct errors for data-carrying

## Folder Structure

```
lib/                    # Domain layer
  {bounded-context}/
    {domain}/
adapters/               # Adapter layer
  {bounded-context}/
    {domain}/
```
