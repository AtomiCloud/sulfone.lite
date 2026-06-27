# Stateless OOP with DI in C#/.NET

## Folder Structure

```
{Service}.Domain/         # Pure class library
  User/
    UserRecord.cs
    IUserService.cs
    IUserRepository.cs
    UserService.cs

{Service}.App/            # ASP.NET/Console — DI wiring, adapters
  Repos/
    PostgresUserRepo.cs
  Controllers/
  Program.cs              # DI registration

{Service}.UnitTest/       # Unit + functional tests
{Service}.IntTest/        # Integration tests
```

## Structures (Records)

```csharp
// {Service}.Domain/User/UserRecord.cs
public record UserRecord
{
    public required string Name { get; init; }
    public required string Email { get; init; }
}

public record UserPrincipal
{
    public required string Id { get; init; }
    public required UserRecord Record { get; init; }
}
```

## Interfaces

```csharp
// {Service}.Domain/User/IUserRepository.cs
public interface IUserRepository
{
    Task<UserPrincipal?> FindById(string id);
    Task<UserPrincipal> Save(UserRecord record);
}
```

## Stateless Service

```csharp
// {Service}.Domain/User/UserService.cs
public class UserService(IUserRepository repo, ILogger<UserService> logger) : IUserService
{
    public async Task<UserPrincipal> Create(UserRecord record)
    {
        logger.LogInformation("Creating user: {Name}", record.Name);
        return await repo.Save(record);
    }
}
```

## DI Registration (App layer)

```csharp
// {Service}.App/Program.cs
builder.Services.AddScoped<IUserRepository, PostgresUserRepo>();
builder.Services.AddScoped<IUserService, UserService>();
```
