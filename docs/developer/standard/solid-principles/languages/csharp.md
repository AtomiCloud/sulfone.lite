# SOLID Principles in C#/.NET

## Folder Structure

```
{Service}.Domain/         # Pure class library — interfaces, services
{Service}.App/            # Adapters, DI wiring
{Service}.UnitTest/       # Unit + functional tests
{Service}.IntTest/        # Integration tests
```

## Single Responsibility (SRP)

```csharp
// GOOD — separated
public class UserValidator
{
    public ValidationResult Validate(UserRecord record) { /* ... */ }
}

public class UserService(IUserRepository repo, UserValidator validator) : IUserService
{
    public async Task<User> Create(UserRecord record) { /* ... */ }
}
```

## Open/Closed (OCP)

```csharp
public interface INotifier
{
    Task Notify(string message);
}

public class EmailNotifier : INotifier { /* ... */ }
public class SlackNotifier : INotifier { /* ... */ }
```

## Liskov Substitution (LSP)

Verified by functional tests — same test suite against all implementations.

## Interface Segregation (ISP)

```csharp
// Segregated interfaces
public interface IReadRepository<T>
{
    Task<T?> FindById(string id);
}

public interface IWriteRepository<T>
{
    Task<T> Save(T entity);
    Task Delete(string id);
}
```

## Dependency Inversion (DIP)

```csharp
// Domain defines interface
public interface IUserRepository
{
    Task<UserPrincipal?> FindById(string id);
}

// App layer implements
public class PostgresUserRepo : IUserRepository { /* ... */ }

// DI registration
builder.Services.AddScoped<IUserRepository, PostgresUserRepo>();
```
