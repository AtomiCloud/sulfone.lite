# Three-Layer Architecture in C#/.NET

## Folder Structure

```
{Service}.Domain/           # Pure class library
  Project/                  # Bounded context
    Task/
      TaskRecord.cs
      TaskPrincipal.cs
      ITaskService.cs
      ITaskRepository.cs
      TaskService.cs
      TaskErrors.cs

{Service}.App/              # ASP.NET/Console
  Project/                  # Bounded context
    Task/
      API/
        Controller.cs
        Req.cs
        Res.cs
        Validator.cs
        Mapper.cs
      Data/
        Repo.cs
        Mapper.cs
  Program.cs

{Service}.UnitTest/         # Unit + functional tests
{Service}.IntTest/          # Integration tests
```

## Domain Layer

```csharp
// {Service}.Domain/Project/Task/TaskRecord.cs
public record TaskRecord
{
    public required string Name { get; init; }
    public required string Priority { get; init; }
}

public record TaskPrincipal
{
    public required string Id { get; init; }
    public required TaskRecord Record { get; init; }
}
```

```csharp
// {Service}.Domain/Project/Task/ITaskService.cs
public interface ITaskService
{
    Task<TaskPrincipal> Create(TaskRecord record);
    Task<TaskPrincipal?> GetById(string id);
    Task<TaskPrincipal[]> List();
}
```

## API Layer — Request/Response

```csharp
// {Service}.App/Project/Task/API/Req.cs
public record CreateTaskReq
{
    public required string Name { get; init; }
    public string? Priority { get; init; }
}

public record ListTaskReq
{
    public int? Limit { get; init; }
    public int? Offset { get; init; }
}
```

```csharp
// {Service}.App/Project/Task/API/Res.cs
public record TaskRes
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Priority { get; init; }
}

public record TaskListRes
{
    public required TaskRes[] Items { get; init; }
    public required int Total { get; init; }
}
```

## API Mapper

```csharp
// {Service}.App/Project/Task/API/Mapper.cs
public class TaskApiMapper
{
    public TaskRecord ToRecord(CreateTaskReq req) =>
        new() { Name = req.Name, Priority = req.Priority ?? "medium" };

    public TaskRes ToRes(TaskPrincipal p) =>
        new() { Id = p.Id, Name = p.Record.Name, Priority = p.Record.Priority };

    public TaskListRes ToResList(TaskPrincipal[] principals) =>
        new() { Items = principals.Select(ToRes).ToArray(), Total = principals.Length };
}
```

## DI Registration

```csharp
// {Service}.App/Program.cs
builder.Services.AddScoped<ITaskRepository, PostgresTaskRepo>();
builder.Services.AddScoped<ITaskService, TaskService>();
builder.Services.AddSingleton<TaskApiMapper>();
builder.Services.AddSingleton<TaskDataMapper>();
```
