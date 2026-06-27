# Stateless OOP with DI in Go

## Folder Structure

```
lib/                      # Domain layer
  identity/               # Bounded context
    user/
      structures.go       # User, UserRecord
      interfaces.go       # UserRepository interface
      service.go          # UserService

adapters/                 # Adapter layer
  repos/
    postgres/
      user_repo.go
```

## Structures

```go
// lib/user/structures.go
type UserRecord struct {
    Name  string
    Email string
}

type UserPrincipal struct {
    Id     string
    Record UserRecord
}
```

## Interfaces

```go
// lib/user/interfaces.go
type UserRepository interface {
    FindById(ctx context.Context, id string) (*UserPrincipal, error)
    Save(ctx context.Context, record UserRecord) (*UserPrincipal, error)
}
```

## Stateless Service

```go
// lib/user/service.go
type UserService struct {
    repo   UserRepository
    logger Logger
}

func NewUserService(repo UserRepository, logger Logger) *UserService {
    return &UserService{repo: repo, logger: logger}
}

func (s *UserService) Create(ctx context.Context, record UserRecord) (*UserPrincipal, error) {
    s.logger.Info("Creating user", "name", record.Name)
    return s.repo.Save(ctx, record)
}
```

## Entry Point Wiring

```go
// main.go
repo := postgres.NewUserRepo(pool)
logger := slog.Default()
userService := user.NewUserService(repo, logger)
```
