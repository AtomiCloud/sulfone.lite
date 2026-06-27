# Testing in Go

## Framework: `testing` + testify

## Test Structure: testify suite = describe, method = it

```go
// lib/post/service_test.go
package post_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/suite"
)

type PostServiceSuite struct {
    suite.Suite
    repo    *MockPostRepository
    subject *PostService
}

func (s *PostServiceSuite) SetupTest() {
    s.repo = NewMockPostRepository()
    s.subject = NewPostService(s.repo)
}

func (s *PostServiceSuite) TestCreate_it_should_create_post() {
    // Arrange
    input := PostRecord{Title: "Hello", Description: "World"}

    // Act
    actual, err := s.subject.Create(context.Background(), input)

    // Assert
    s.Require().NoError(err)
    s.Assert().Equal("Hello", actual.Principal.Record.Title)
    s.Assert().NotEmpty(actual.Principal.Id)
}

func (s *PostServiceSuite) TestCreate_it_should_reject_empty_title() {
    // Arrange
    input := PostRecord{Title: "", Description: "World"}

    // Act
    _, err := s.subject.Create(context.Background(), input)

    // Assert
    s.Assert().Error(err)
}

func TestPostServiceSuite(t *testing.T) {
    suite.Run(t, new(PostServiceSuite))
}
```

## testify Assertions

```go
// Equality
s.Assert().Equal(expected, actual)
s.Assert().NotEqual(other, actual)

// Errors
s.Require().NoError(err)
s.Assert().Error(err)
s.Assert().ErrorIs(err, ErrNotFound)

// Nil
s.Assert().Nil(value)
s.Assert().NotNil(value)

// Boolean
s.Assert().True(result)
s.Assert().False(result)

// Collections
s.Assert().Len(items, 3)
s.Assert().Contains(items, "item")
s.Assert().Empty(items)
```

## Table-Driven Tests

```go
func (s *ValidatorSuite) TestValidate_it_should_handle_cases() {
    tests := []struct {
        name    string
        input   PostRecord
        wantErr bool
    }{
        {"valid post", PostRecord{Title: "Hi", Description: "World"}, false},
        {"empty title", PostRecord{Title: "", Description: "World"}, true},
        {"empty description", PostRecord{Title: "Hi", Description: ""}, true},
    }

    for _, tt := range tests {
        s.Run(tt.name, func() {
            err := s.subject.Validate(tt.input)
            if tt.wantErr {
                s.Assert().Error(err)
            } else {
                s.Require().NoError(err)
            }
        })
    }
}
```

## Manual Mocks

```go
type MockPostRepository struct {
    posts []PostPrincipal
}

func NewMockPostRepository() *MockPostRepository {
    return &MockPostRepository{posts: make([]PostPrincipal, 0)}
}

func (m *MockPostRepository) Search(ctx context.Context, params PostSearch) ([]PostPrincipal, error) {
    return m.posts, nil
}

func (m *MockPostRepository) Create(ctx context.Context, record PostRecord) (*Post, error) {
    p := PostPrincipal{Id: uuid.New().String(), Record: record}
    m.posts = append(m.posts, p)
    return &Post{Principal: p}, nil
}
```

## Spy Patterns

```go
// Collect calls
type SpyLogger struct {
    Logged []string
}

func (s *SpyLogger) Log(msg string) {
    s.Logged = append(s.Logged, msg)
}
// Assert: s.Assert().Equal([]string{"msg1", "msg2"}, spy.Logged)

// Capture argument
type SpySender struct {
    Captured interface{}
}

func (s *SpySender) Send(payload interface{}) {
    s.Captured = payload
}
// Assert: s.Assert().Equal("123", spy.Captured.(CreateRequest).Id)

// Count calls
type SpyClient struct {
    CallCount int
}

func (s *SpyClient) Fetch() error {
    s.CallCount++
    return errors.New("fail")
}
// Assert: s.Assert().Equal(3, spy.CallCount)
```

## Functional Test — Contract Test

```go
// lib/project/task/repo_contract_test.go
package task_test

type TaskRepositoryContractSuite struct {
    suite.Suite
    createRepo func() TaskRepository
    subject    TaskRepository
}

func (s *TaskRepositoryContractSuite) SetupTest() {
    s.subject = s.createRepo()
}

func (s *TaskRepositoryContractSuite) TestIt_should_save_and_retrieve_by_id() {
    input := TaskPrincipal{Id: uuid.New().String(), Record: TaskRecord{Name: "test", Priority: "medium"}}

    s.subject.Save(context.Background(), input)
    actual, _ := s.subject.FindById(context.Background(), input.Id)

    s.Assert().NotNil(actual)
    s.Assert().Equal(input.Record.Name, actual.Record.Name)
}

func (s *TaskRepositoryContractSuite) TestIt_should_list_all_saved_tasks() {
    s.subject.Save(context.Background(), TaskPrincipal{Id: uuid.New().String(), Record: TaskRecord{Name: "task-1"}})
    s.subject.Save(context.Background(), TaskPrincipal{Id: uuid.New().String(), Record: TaskRecord{Name: "task-2"}})

    actual, _ := s.subject.FindAll(context.Background())

    s.Assert().Len(actual, 2)
}

// Memory implementation
type MemoryTaskRepositorySuite struct {
    TaskRepositoryContractSuite
}

func (s *MemoryTaskRepositorySuite) SetupSuite() {
    s.createRepo = func() TaskRepository {
        return NewMemoryTaskRepository()
    }
}

func TestMemoryTaskRepositorySuite(t *testing.T) {
    suite.Run(t, new(MemoryTaskRepositorySuite))
}

// File implementation
type FileTaskRepositorySuite struct {
    TaskRepositoryContractSuite
    tempDir string
}

func (s *FileTaskRepositorySuite) SetupSuite() {
    s.tempDir, _ = os.MkdirTemp("", "task-repo-*")
    fs := &FileSystemAdapter{}
    s.createRepo = func() TaskRepository {
        return NewFileTaskRepository(fs, &TaskRepoMapper{}, filepath.Join(s.tempDir, "tasks.json"))
    }
}

func (s *FileTaskRepositorySuite) TearDownSuite() {
    os.RemoveAll(s.tempDir)
}

func TestFileTaskRepositorySuite(t *testing.T) {
    suite.Run(t, new(FileTaskRepositorySuite))
}
```

## Test Folder Structure

| Test Type   | Location                                            |
| ----------- | --------------------------------------------------- |
| Unit        | `lib/` (`_test.go` alongside domain code)           |
| Functional  | `lib/` (same as unit)                               |
| Integration | `adapters/` (`_test.go` + `//go:build integration`) |

Integration tests use build tag:

```go
//go:build integration

package repo_test
```

## Integration Test — Testcontainers

```go
// adapters/repos/postgres/post_repo_test.go
//go:build integration

package postgres_test

import (
    "context"
    "testing"

    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/stretchr/testify/suite"
)

type PostRepositorySuite struct {
    suite.Suite
    container *postgres.PostgresContainer
    pool      *pgxpool.Pool
    subject   *PostRepository
}

func (s *PostRepositorySuite) SetupSuite() {
    ctx := context.Background()

    container, _ := postgres.Run(ctx, "postgres:16",
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("postgres"),
        postgres.WithPassword("test"),
    )
    s.container = container

    connStr, _ := container.ConnectionString(ctx, "sslmode=disable")
    pool, _ := pgxpool.New(ctx, connStr)
    s.pool = pool

    pool.Exec(ctx, "CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, description TEXT)")
    s.subject = NewPostRepository(pool, &PostRepoMapper{})
}

func (s *PostRepositorySuite) TearDownSuite() {
    s.pool.Close()
    s.container.Terminate(context.Background())
}

func (s *PostRepositorySuite) TestIt_should_persist_and_retrieve_post() {
    // Arrange
    input := PostRecord{Title: "Test", Description: "A test", Tags: []string{}}

    // Act
    created, err := s.subject.Create(context.Background(), input)
    s.Require().NoError(err)

    actual, err := s.subject.Get(context.Background(), created.Principal.Id)
    s.Require().NoError(err)

    // Assert
    s.Assert().NotNil(actual)
    s.Assert().Equal("Test", actual.Principal.Record.Title)
}

func TestPostRepositorySuite(t *testing.T) {
    suite.Run(t, new(PostRepositorySuite))
}
```
