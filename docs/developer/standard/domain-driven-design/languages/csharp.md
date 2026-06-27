# Domain-Driven Design in C#/.NET

## Folder Structure

```
{Service}.Domain/         # Pure class library — entities, interfaces, value objects
  Blog/
    Post/
      PostRecord.cs
      PostPrincipal.cs
      Post.cs
      IPostService.cs
      IPostRepository.cs
    Author/
      AuthorRecord.cs
      AuthorPrincipal.cs
      Author.cs
      IAuthorService.cs
  Identity/
    User/
      ...

{Service}.App/            # ASP.NET/Console — controllers, repos, mappers, DI wiring
  Repos/
  Controllers/
  Mappers/

{Service}.UnitTest/       # Unit tests + functional tests
{Service}.IntTest/        # Integration tests
```

## Record (Pure Data, No Identity)

```csharp
// {Service}.Domain/Blog/Post/PostRecord.cs
public record PostRecord
{
    public required string Title { get; init; }
    public required string Description { get; init; }
    public required string[] Tags { get; init; }
}

public record AuthorRecord
{
    public required string Name { get; init; }
    public required DateOnly DateOfBirth { get; init; }
}
```

## Multiple Records per Entity

When an entity has fields with different update rates, split into multiple Records:

```csharp
// {Service}.Domain/Identity/User/UserRecord.cs

// Frequently changed by user
public record UserRecord
{
    public required string DisplayName { get; init; }
    public required string Bio { get; init; }
    public required string AvatarUrl { get; init; }
}

// Locked at creation, never changes
public record UserImmutableRecord
{
    public required string Email { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
}

// Updated by external sync, infrequent
public record UserSyncRecord
{
    public required string StripeCustomerId { get; init; }
    public required string? GithubId { get; init; }
    public required DateTimeOffset LastSyncAt { get; init; }
}
```

## Principal (Record + Identity)

**Single Record:**

```csharp
// {Service}.Domain/Blog/Post/PostPrincipal.cs
public record PostPrincipal
{
    public required string Id { get; init; }
    public required PostRecord Record { get; init; }
}

public record AuthorPrincipal
{
    public required string Id { get; init; }
    public required AuthorRecord Record { get; init; }
}
```

**Multiple Records:**

```csharp
// {Service}.Domain/Identity/User/UserPrincipal.cs
public record UserPrincipal
{
    public required string Id { get; init; }
    public required UserRecord Record { get; init; }           // Mutable profile
    public required UserImmutableRecord Immutable { get; init; }  // Create-only
    public required UserSyncRecord Sync { get; init; }         // Externally synced
}
```

## Aggregate Root (Assembled View)

```csharp
// {Service}.Domain/Blog/Post/Post.cs
public record Post
{
    public required PostPrincipal Principal { get; init; }
    public required AuthorPrincipal Author { get; init; }
}

public record Author
{
    public required AuthorPrincipal Principal { get; init; }
    public required PostPrincipal[] Posts { get; init; }
}
```

## Service Interface (CRUD Blessed Path)

> Result type library to be determined. See error-handling skill for updates.

```csharp
// {Service}.Domain/Blog/Post/IPostService.cs
public interface IPostService
{
    Task<PostPrincipal[]> Search(PostSearch search);
    Task<Post?> Get(string id);
    Task<Post> Create(PostRecord record);
    Task<Post?> Update(string id, PostRecord record);
    Task Delete(string id);
}
```

## Repository Interface (Same Shape)

```csharp
// {Service}.Domain/Blog/Post/IPostRepository.cs
public interface IPostRepository
{
    Task<PostPrincipal[]> Search(PostSearch search);
    Task<Post?> Get(string id);
    Task<Post> Create(PostRecord record);
    Task<Post?> Update(string id, PostRecord record);
    Task Delete(string id);
}
```

## Search Params

```csharp
public record PostSearch
{
    public string? TitleContains { get; init; }
    public string[]? Tags { get; init; }
    public required int Limit { get; init; }
    public required int Offset { get; init; }
}
```

## Domain Errors

```csharp
// {Service}.Domain/Blog/Post/PostErrors.cs
public class PostNotFound(string id)
{
    public string Id { get; } = id;
}

public class PostValidationError(string field, string reason)
{
    public string Field { get; } = field;
    public string Reason { get; } = reason;
}
```
