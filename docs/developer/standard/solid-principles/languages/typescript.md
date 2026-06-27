# SOLID Principles in TypeScript/Bun

## Folder Structure

```
src/
  lib/                    # Domain layer
    {bounded-context}/
      {domain}/
        structures.ts
        interfaces.ts
        service.ts
  adapters/               # Adapter layer
    {bounded-context}/
      {domain}/
```

## Single Responsibility (SRP)

Each class has one reason to change.

```typescript
// BAD — does validation AND persistence
class UserService {
  validate(user: User): boolean {
    /* ... */
  }
  save(user: User): void {
    /* db call */
  }
}

// GOOD — separated responsibilities
class UserValidator {
  validate(user: User): ValidationResult {
    /* ... */
  }
}

class UserService {
  constructor(
    private repo: IUserRepository,
    private validator: UserValidator,
  ) {}
  create(record: UserRecord): Promise<User> {
    /* ... */
  }
}
```

## Open/Closed (OCP)

Open for extension, closed for modification. Use interfaces.

```typescript
interface INotifier {
  notify(message: string): void;
}

class EmailNotifier implements INotifier {
  notify(message: string): void {
    /* send email */
  }
}

class SlackNotifier implements INotifier {
  notify(message: string): void {
    /* send slack */
  }
}
```

## Liskov Substitution (LSP)

Any implementation of an interface must be substitutable. Functional tests verify this.

## Interface Segregation (ISP)

Small, focused interfaces over large monolithic ones.

```typescript
// BAD — too many methods
interface IRepository {
  find(id: string): Promise<User>;
  save(user: User): Promise<void>;
  delete(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  export(format: string): Promise<Buffer>;
}

// GOOD — segregated
interface IReadRepository {
  find(id: string): Promise<User>;
}

interface IWriteRepository {
  save(user: User): Promise<void>;
  delete(id: string): Promise<void>;
}
```

## Dependency Inversion (DIP)

Depend on abstractions (interfaces), not concretions.

```typescript
// Domain defines the interface
interface IUserRepository {
  findById(id: string): Promise<User | null>;
}

// Adapter implements it
class PostgresUserRepo implements IUserRepository {
  async findById(id: string): Promise<User | null> {
    /* ... */
  }
}

// Service depends on interface
class UserService {
  constructor(private repo: IUserRepository) {}
}
```
