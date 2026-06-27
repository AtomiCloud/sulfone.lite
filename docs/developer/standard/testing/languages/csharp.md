# Testing in C#/.NET

## Framework: xUnit + FluentAssertions

## Test Structure: class = describe, method = it

```csharp
// {Service}.UnitTest/UserService_CreateTests.cs
public class UserService_Create
{
    [Fact]
    public void It_should_create_user_with_valid_input()
    {
        // Arrange
        var repo = new MockUserRepository();
        var subject = new UserService(repo);
        var input = new UserRecord { Name = "Alice", Email = "alice@test.com" };

        // Act
        var actual = subject.Create(input);

        // Assert
        actual.Principal.Record.Name.Should().Be("Alice");
    }

    [Fact]
    public void It_should_assign_generated_id()
    {
        // Arrange
        var repo = new MockUserRepository();
        var subject = new UserService(repo);
        var input = new UserRecord { Name = "Alice", Email = "alice@test.com" };

        // Act
        var actual = subject.Create(input);

        // Assert
        actual.Principal.Id.Should().NotBeNullOrEmpty();
    }
}
```

## FluentAssertions

```csharp
// Equality
actual.Should().Be(expected);
actual.Should().BeEquivalentTo(expected);

// Strings
actual.Should().StartWith("AB").And.EndWith("HI");
actual.Should().HaveLength(9);

// Booleans
result.Should().BeTrue();
result.Should().BeFalse();

// Null
result.Should().BeNull();
result.Should().NotBeNull();

// Collections
items.Should().HaveCount(3);
items.Should().Contain("item");
items.Should().BeEmpty();

// Exceptions
act.Should().Throw<InvalidOperationException>().WithMessage("Expected message");
```

## Parameterized Tests — TheoryData + ClassData

**NEVER use `[InlineData]`.** Always use `TheoryData<>` generators + `[ClassData]`.

```csharp
private class CreateUser_Data : TheoryData<UserRecord, string>
{
    public CreateUser_Data()
    {
        Add(new UserRecord { Name = "Alice" }, "Alice");
        Add(new UserRecord { Name = "Bob" }, "Bob");
    }
}

[Theory]
[ClassData(typeof(CreateUser_Data))]
public void It_should_create_user(UserRecord input, string expectedName)
{
    // Arrange
    var subject = new UserService(new MockUserRepository());

    // Act
    var actual = subject.Create(input);

    // Assert
    actual.Principal.Record.Name.Should().Be(expectedName);
}
```

## Manual Mocks (no Moq)

```csharp
public class MockUserRepository : IUserRepository
{
    private readonly List<UserPrincipal> _users = new();

    public Task<UserPrincipal[]> Search(UserSearch search) =>
        Task.FromResult(_users.ToArray());

    public Task<User> Create(UserRecord record)
    {
        var principal = new UserPrincipal { Id = Guid.NewGuid().ToString(), Record = record };
        _users.Add(principal);
        return Task.FromResult(new User { Principal = principal });
    }
}
```

## Spy Patterns

```csharp
// Collect calls
public class SpyLogger : ILogger
{
    public readonly List<string> Logged = new();

    public void Log(string message) => Logged.Add(message);
}
// Assert: spy.Logged.Should().Equal("msg1", "msg2");

// Capture argument
public class SpySender : ISender
{
    public object? Captured;

    public void Send(object payload) => Captured = payload;
}
// Assert: spy.Captured.Should().BeEquivalentTo(new { Id = "123" });

// Count calls
public class SpyClient : IClient
{
    public int CallCount;

    public void Fetch() { CallCount++; throw new Exception("fail"); }
}
// Assert: spy.CallCount.Should().Be(3);
```

## Functional Test — Contract Test

```csharp
// {Service}.UnitTest/TaskRepositoryContract.cs
public abstract class TaskRepositoryContract
{
    protected abstract ITaskRepository CreateRepo();

    [Fact]
    public async Task It_should_save_and_retrieve_by_id()
    {
        var subject = CreateRepo();
        var input = CreateTestTask();

        await subject.Save(input);
        var actual = await subject.FindById(input.Id);

        actual.Should().NotBeNull();
        actual!.Name.Should().Be(input.Name);
    }

    [Fact]
    public async Task It_should_list_all_saved_tasks()
    {
        var subject = CreateRepo();
        await subject.Save(CreateTestTask("task-1"));
        await subject.Save(CreateTestTask("task-2"));

        var actual = await subject.FindAll();

        actual.Should().HaveCount(2);
    }

    private static TaskPrincipal CreateTestTask(string? name = null) =>
        new() { Id = Guid.NewGuid().ToString(), Record = new TaskRecord { Name = name ?? "test", Priority = "medium" } };
}

// Memory implementation
public class MemoryTaskRepositoryContract : TaskRepositoryContract
{
    protected override ITaskRepository CreateRepo() => new MemoryTaskRepository();
}

// File implementation
public class FileTaskRepositoryContract : TaskRepositoryContract, IAsyncLifetime
{
    private readonly string _tempPath = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    private IFileSystemAdapter _fs = null!;

    protected override ITaskRepository CreateRepo() =>
        new FileTaskRepository(_fs, new TaskRepoMapper(), Path.Combine(_tempPath, "tasks.json"));

    public Task InitializeAsync()
    {
        Directory.CreateDirectory(_tempPath);
        _fs = new FileSystemAdapter();
        return Task.CompletedTask;
    }

    public Task DisposeAsync()
    {
        Directory.Delete(_tempPath, recursive: true);
        return Task.CompletedTask;
    }
}
```

## Test Folder Structure

| Test Type   | Project               |
| ----------- | --------------------- |
| Unit        | `{Service}.UnitTest/` |
| Functional  | `{Service}.UnitTest/` |
| Integration | `{Service}.IntTest/`  |

## Integration Test — Testcontainers

```csharp
// {Service}.IntTest/PostRepositoryTests.cs
public class PostRepositoryTests : IAsyncLifetime
{
    private PostgresContainer _container = null!;
    private NpgsqlConnection _connection = null!;
    private PostRepository _subject = null!;

    public async Task InitializeAsync()
    {
        _container = new PostgresBuilder()
            .WithImage("postgres:16")
            .WithDatabase("testdb")
            .WithUsername("postgres")
            .WithPassword("test")
            .Build();

        await _container.StartAsync();

        _connection = new NpgsqlConnection(_container.GetConnectionString());
        await _connection.OpenAsync();

        await _connection.ExecuteAsync("CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, description TEXT)");

        _subject = new PostRepository(_connection, new PostRepoMapper());
    }

    public async Task DisposeAsync()
    {
        await _connection.DisposeAsync();
        await _container.DisposeAsync();
    }

    [Fact]
    public async Task It_should_persist_and_retrieve_post()
    {
        // Arrange
        var input = new PostRecord { Title = "Test", Description = "A test", Tags = [] };

        // Act
        var created = await _subject.Create(input);
        var actual = await _subject.Get(created.Principal.Id);

        // Assert
        actual.Should().NotBeNull();
        actual!.Principal.Record.Title.Should().Be("Test");
    }
}
```
