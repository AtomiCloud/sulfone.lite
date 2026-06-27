# Functional Practices in C#/.NET

## Immutability

- Use `record` types with `init` setters
- Use `with` expressions for immutable updates
- Use `IReadOnlyList<T>` and `IReadOnlyDictionary<K,V>`
- Never mutate method arguments

```csharp
public record User
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Email { get; init; }
}

var updated = user with { Name = "New Name" };
```

## Pure Functions

Instance methods are pure when all members are readonly. No static methods.

```csharp
// Pure instance method — all members readonly
public class NameFormatter
{
    private readonly string _suffix;  // readonly → method is pure

    public string Format(string first, string last) => $"{first} {last} {_suffix}";
}

// Impure — reads clock (external state)
public class TimestampFormatter
{
    public string Format(string name) => $"{name} at {DateTime.UtcNow}";
}
```

**Rule:** Instance methods are pure if all class members are readonly and the method has no side effects.

## Total Functions

> Result type library to be determined. See error-handling skill for updates.

C# domain errors use plain classes:

```csharp
public class UserNotFound(string id)
{
    public string Id { get; } = id;
}
```

> Result type and ROP combinator patterns for C# are TBA. Once the library is pinned, this section will document `.Then()`, `.ThenAwait()`, `.Match()`, and `.ToResultOfSeq()` patterns.

## Folder Structure

```
{Service}.Domain/       # Pure class library — entities, interfaces, value objects
{Service}.App/          # ASP.NET/Console — controllers, repos, mappers, DI wiring
{Service}.UnitTest/     # Unit tests + functional tests
{Service}.IntTest/      # Integration tests
```
