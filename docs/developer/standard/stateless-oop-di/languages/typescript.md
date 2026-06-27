# Stateless OOP with DI in TypeScript/Bun

## Folder Structure

```
src/
  lib/                    # Domain layer — pure code
    identity/             # Bounded context
      user/
        structures.ts     # User, UserRecord
        interfaces.ts     # IUserRepository, ILogger
        service.ts        # UserService
    commerce/             # Bounded context
      order/
        structures.ts
        service.ts
  adapters/               # Adapter layer — impure code
    repos/
    controllers/
```

## Structures (Pure Data)

```typescript
// src/lib/user/structures.ts
interface User {
  id: string;
  name: string;
  email: string;
}

interface UserRecord {
  name: string;
  email: string;
}
```

## Interfaces (Dependency Contracts)

```typescript
// src/lib/user/interfaces.ts
interface ILogger {
  log(message: string): void;
}

interface IUserRepository {
  findById(id: string): Promise<User | null>;
  save(user: User): Promise<void>;
}
```

## Stateless Service

```typescript
// src/lib/user/service.ts
class UserService {
  constructor(
    private readonly repo: IUserRepository,
    private readonly logger: ILogger,
  ) {}

  async create(record: UserRecord): Promise<User> {
    this.logger.log(`Creating user: ${record.name}`);
    const user: User = { id: crypto.randomUUID(), ...record };
    await this.repo.save(user);
    return user;
  }
}
```

## Entry Point Wiring

```typescript
// src/main.ts
const logger = new ConsoleLogger();
const repo = new PostgresUserRepo(pool);
const userService = new UserService(repo, logger);
```

## Adapter (Impure Implementation)

```typescript
// src/adapters/repos/postgres/user.repo.ts
class PostgresUserRepo implements IUserRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<User | null> {
    const row = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return row.rows[0] ?? null;
  }
}
```
