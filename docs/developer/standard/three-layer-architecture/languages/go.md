# Three-Layer Architecture in Go

## Folder Structure

```
lib/                        # Domain layer
  project/                  # Bounded context
    task/
      structures.go         # TaskRecord, TaskPrincipal, Task
      interfaces.go         # TaskService, TaskRepository
      service.go            # NewTaskService
      errors.go             # ErrTaskNotFound, TaskValidationError

adapters/                   # Adapter layer
  project/                  # Bounded context
    task/
      api/
        controller.go       # TaskController (HTTP handlers)
        req.go              # CreateTaskReq, ListTaskReq
        res.go              # TaskRes, TaskListRes
        validator.go        # ValidateCreateTaskReq
        mapper.go           # TaskApiMapper
      data/
        repo.go             # NewPostgresTaskRepo, NewMemoryTaskRepo
        mapper.go           # TaskDataMapper
```

## Domain Layer

```go
// lib/project/task/structures.go
type TaskRecord struct {
    Name     string
    Priority string
}

type TaskPrincipal struct {
    Id     string
    Record TaskRecord
}
```

```go
// lib/project/task/interfaces.go
type TaskService interface {
    Create(ctx context.Context, record TaskRecord) (*TaskPrincipal, error)
    GetById(ctx context.Context, id string) (*TaskPrincipal, error)
    List(ctx context.Context) ([]TaskPrincipal, error)
}

type TaskRepository interface {
    Save(ctx context.Context, principal TaskPrincipal) error
    FindById(ctx context.Context, id string) (*TaskPrincipal, error)
    FindAll(ctx context.Context) ([]TaskPrincipal, error)
}
```

## API Layer — Request/Response

```go
// adapters/project/task/api/req.go
type CreateTaskReq struct {
    Name     string `json:"name"`
    Priority string `json:"priority,omitempty"`
}

type ListTaskReq struct {
    Limit  int `json:"limit"`
    Offset int `json:"offset"`
}
```

```go
// adapters/project/task/api/res.go
type TaskRes struct {
    Id       string `json:"id"`
    Name     string `json:"name"`
    Priority string `json:"priority"`
}

type TaskListRes struct {
    Items []TaskRes `json:"items"`
    Total int       `json:"total"`
}
```

## API Mapper

```go
// adapters/project/task/api/mapper.go
type TaskApiMapper struct{}

func (m *TaskApiMapper) ToRecord(req CreateTaskReq) task.TaskRecord {
    priority := req.Priority
    if priority == "" { priority = "medium" }
    return task.TaskRecord{Name: req.Name, Priority: priority}
}

func (m *TaskApiMapper) ToRes(p task.TaskPrincipal) TaskRes {
    return TaskRes{Id: p.Id, Name: p.Record.Name, Priority: p.Record.Priority}
}

func (m *TaskApiMapper) ToResList(principals []task.TaskPrincipal) TaskListRes {
    items := make([]TaskRes, len(principals))
    for i, p := range principals {
        items[i] = m.ToRes(p)
    }
    return TaskListRes{Items: items, Total: len(principals)}
}
```

## Data Mapper

```go
// adapters/project/task/data/mapper.go
type TaskRow struct {
    Id       string
    Name     string
    Priority int
}

type TaskDataMapper struct{}

func (m *TaskDataMapper) ToRow(p task.TaskPrincipal) TaskRow {
    return TaskRow{Id: p.Id, Name: p.Record.Name, Priority: priorityToInt(p.Record.Priority)}
}

func (m *TaskDataMapper) ToPrincipal(row TaskRow) task.TaskPrincipal {
    return task.TaskPrincipal{Id: row.Id, Record: task.TaskRecord{Name: row.Name, Priority: intToPriority(row.Priority)}}
}
```

## Controller (HTTP)

```go
// adapters/project/task/api/controller.go
type TaskController struct {
    service *task.TaskService
    mapper  *TaskApiMapper
}

func (c *TaskController) Create(w http.ResponseWriter, r *http.Request) {
    var req CreateTaskReq
    json.NewDecoder(r.Body).Decode(&req)

    input := c.mapper.ToRecord(req)
    principal, _ := c.service.Create(r.Context(), input)

    res := c.mapper.ToRes(*principal)
    json.NewEncoder(w).Encode(res)
}
```

## Entry Point Wiring

```go
// main.go
dataMapper := &data.TaskDataMapper{}
apiMapper := &api.TaskApiMapper{}

repo := data.NewPostgresTaskRepo(pool, dataMapper)
service := task.NewTaskService(repo)
controller := api.NewTaskController(service, apiMapper)
```
