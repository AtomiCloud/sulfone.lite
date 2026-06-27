# Three-Layer Architecture in TypeScript/Bun

## Folder Structure

```
src/
  lib/                      # Domain layer
    project/                # Bounded context
      task/
        structures.ts       # TaskRecord, TaskPrincipal, Task
        interfaces.ts       # ITaskService, ITaskRepository
        service.ts          # TaskService
        errors.ts           # TaskNotFound, TaskValidationError

  adapters/                 # Adapter layer
    project/                # Bounded context
      task/
        api/
          controller.ts     # TaskController (CLI/HTTP)
          req.ts            # CreateTaskReq, ListTaskReq
          res.ts            # TaskRes, TaskListRes
          validator.ts      # validateCreateTaskReq
          mapper.ts         # TaskApiMapper (Req ↔ Record, Principal ↔ Res)
        data/
          repo.ts           # PostgresTaskRepo, MemoryTaskRepo
          mapper.ts         # TaskDataMapper (Principal ↔ Row)
```

## Domain Layer

```typescript
// src/lib/project/task/structures.ts
interface TaskRecord {
  name: string;
  priority: string;
}

interface TaskPrincipal {
  id: string;
  record: TaskRecord;
}
```

```typescript
// src/lib/project/task/interfaces.ts
interface ITaskService {
  create(record: TaskRecord): Promise<TaskPrincipal>;
  getById(id: string): Promise<TaskPrincipal | null>;
  list(): Promise<TaskPrincipal[]>;
}

interface ITaskRepository {
  save(principal: TaskPrincipal): Promise<void>;
  findById(id: string): Promise<TaskPrincipal | null>;
  findAll(): Promise<TaskPrincipal[]>;
}
```

## API Layer — Request/Response

```typescript
// src/adapters/project/task/api/req.ts
interface CreateTaskReq {
  name: string;
  priority?: string;
}

interface ListTaskReq {
  limit?: number;
  offset?: number;
}
```

```typescript
// src/adapters/project/task/api/res.ts
interface TaskRes {
  id: string;
  name: string;
  priority: string;
}

interface TaskListRes {
  items: TaskRes[];
  total: number;
}
```

## API Mapper

```typescript
// src/adapters/project/task/api/mapper.ts
class TaskApiMapper {
  toRecord(req: CreateTaskReq): TaskRecord {
    return { name: req.name, priority: req.priority ?? 'medium' };
  }

  toRes(principal: TaskPrincipal): TaskRes {
    return { id: principal.id, name: principal.record.name, priority: principal.record.priority };
  }

  toResList(principals: TaskPrincipal[]): TaskListRes {
    return {
      items: principals.map(p => this.toRes(p)),
      total: principals.length,
    };
  }
}
```

## Data Mapper

```typescript
// src/adapters/project/task/data/mapper.ts
interface TaskRow {
  id: string;
  name: string;
  priority: number;
}

class TaskDataMapper {
  toRow(principal: TaskPrincipal): TaskRow {
    return { id: principal.id, name: principal.record.name, priority: priorityToNumber(principal.record.priority) };
  }

  toPrincipal(row: TaskRow): TaskPrincipal {
    return { id: row.id, record: { name: row.name, priority: numberToPriority(row.priority) } };
  }
}
```

## Controller (CLI)

```typescript
// src/adapters/project/task/api/controller.ts
class TaskCliController {
  constructor(
    private service: ITaskService,
    private mapper: TaskApiMapper,
    private output: IOutputAdapter,
  ) {}

  async create(args: CreateTaskReq & { '--json'?: boolean }): Promise<number> {
    const input = this.mapper.toRecord(args);
    const task = await this.service.create(input);
    const res = this.mapper.toRes(task);
    if (args['--json']) this.output.json(res);
    else this.output.text(`Created: ${res.id}`);
    return 0;
  }
}
```

## Entry Point Wiring

```typescript
// src/main.ts
const dataMapper = new TaskDataMapper();
const apiMapper = new TaskApiMapper();

const repo = new PostgresTaskRepo(pool, dataMapper);
const service = new TaskService(repo);
const controller = new TaskCliController(service, apiMapper, consoleOutput);
```
