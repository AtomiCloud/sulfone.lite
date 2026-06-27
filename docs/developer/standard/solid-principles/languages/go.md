# SOLID Principles in Go

## Folder Structure

```
lib/                      # Domain layer
  {bounded-context}/
    {domain}/
adapters/                 # Adapter layer
  {bounded-context}/
    {domain}/
```

## Single Responsibility (SRP)

```go
// GOOD — separated
type UserValidator struct{}
func (v *UserValidator) Validate(record UserRecord) error { /* ... */ }

type UserService struct {
    repo      UserRepository
    validator *UserValidator
}
func NewUserService(repo UserRepository, v *UserValidator) *UserService {
    return &UserService{repo: repo, validator: v}
}
```

## Open/Closed (OCP)

Go interfaces are implicit — any struct that matches the method set satisfies the interface.

```go
type Notifier interface {
    Notify(ctx context.Context, message string) error
}

type EmailNotifier struct{ /* ... */ }
func (n *EmailNotifier) Notify(ctx context.Context, message string) error { /* ... */ }

type SlackNotifier struct{ /* ... */ }
func (n *SlackNotifier) Notify(ctx context.Context, message string) error { /* ... */ }
```

## Liskov Substitution (LSP)

Verified by functional tests — same test suite against all implementations.

## Interface Segregation (ISP)

```go
type Reader interface {
    FindById(ctx context.Context, id string) (*User, error)
}

type Writer interface {
    Save(ctx context.Context, record UserRecord) (*UserPrincipal, error)
    Delete(ctx context.Context, id string) error
}
```

## Dependency Inversion (DIP)

```go
// Domain defines interface
type UserRepository interface {
    FindById(ctx context.Context, id string) (*UserPrincipal, error)
}

// Adapter implements
type PostgresUserRepo struct { pool *pgxpool.Pool }
func (r *PostgresUserRepo) FindById(ctx context.Context, id string) (*UserPrincipal, error) { /* ... */ }

// Wired at entry point
repo := postgres.NewUserRepo(pool)
service := user.NewUserService(repo)
```
