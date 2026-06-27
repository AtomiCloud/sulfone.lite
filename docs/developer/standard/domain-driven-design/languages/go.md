# Domain-Driven Design in Go

## Folder Structure

```
lib/                      # Domain layer
  blog/                   # Bounded context
    post/
      structures.go       # PostRecord, PostPrincipal, Post
      interfaces.go       # IPostService, IPostRepository
      service.go          # PostService implementation
      errors.go           # PostNotFoundError, PostValidationError
    author/
      structures.go
      interfaces.go
      service.go
  identity/               # Different bounded context
    user/
      structures.go
      interfaces.go
      service.go

adapters/                 # Adapter layer
  repos/
  controllers/
```

## Record (Pure Data, No Identity)

```go
// lib/blog/post/structures.go
type PostRecord struct {
    Title       string
    Description string
    Tags        []string
}

type AuthorRecord struct {
    Name        string
    DateOfBirth time.Time
}
```

## Multiple Records per Entity

When an entity has fields with different update rates, split into multiple Records:

```go
// lib/identity/user/structures.go

// Frequently changed by user
type UserRecord struct {
    DisplayName string
    Bio         string
    AvatarUrl   string
}

// Locked at creation, never changes
type UserImmutableRecord struct {
    Email     string
    CreatedAt time.Time
}

// Updated by external sync, infrequent
type UserSyncRecord struct {
    StripeCustomerId string
    GithubId         *string
    LastSyncAt       time.Time
}
```

## Principal (Record + Identity)

**Single Record:**

```go
type PostPrincipal struct {
    Id     string
    Record PostRecord
}

type AuthorPrincipal struct {
    Id     string
    Record AuthorRecord
}
```

**Multiple Records:**

```go
type UserPrincipal struct {
    Id        string
    Record    UserRecord           // Mutable profile
    Immutable UserImmutableRecord  // Create-only
    Sync      UserSyncRecord       // Externally synced
}
```

## Aggregate Root (Assembled View)

```go
type Post struct {
    Principal PostPrincipal
    Author    AuthorPrincipal
}

type Author struct {
    Principal AuthorPrincipal
    Posts     []PostPrincipal
}
```

## Service Interface (CRUD Blessed Path)

```go
// lib/blog/post/interfaces.go
type IPostService interface {
    Search(ctx context.Context, params PostSearch) ([]PostPrincipal, error)
    Get(ctx context.Context, id string) (*Post, error)
    Create(ctx context.Context, record PostRecord) (*Post, error)
    Update(ctx context.Context, id string, record PostRecord) (*Post, error)
    Delete(ctx context.Context, id string) error
}
```

## Repository Interface (Same Shape)

```go
type IPostRepository interface {
    Search(ctx context.Context, params PostSearch) ([]PostPrincipal, error)
    Get(ctx context.Context, id string) (*Post, error)
    Create(ctx context.Context, record PostRecord) (*Post, error)
    Update(ctx context.Context, id string, record PostRecord) (*Post, error)
    Delete(ctx context.Context, id string) error
}
```

## Search Params

```go
type PostSearch struct {
    TitleContains *string
    Tags          []string
    Limit         int
    Offset        int
}
```

## Domain Errors

```go
// lib/blog/post/errors.go
type PostNotFoundError struct {
    Id string
}

func (e *PostNotFoundError) Error() string {
    return fmt.Sprintf("post not found: %s", e.Id)
}

type PostValidationError struct {
    Field  string
    Reason string
}

func (e *PostValidationError) Error() string {
    return fmt.Sprintf("invalid %s: %s", e.Field, e.Reason)
}
```
