# Testing in TypeScript/Bun

## Framework: `bun:test` + `expect`

Bun test runner with its built-in `expect` assertions.

For package setup and the required Knip quality gates, see
[TypeScript/Bun Quality Gates](../../typescript-quality/).

Import `expect` from `bun:test` alongside `describe`/`it` — no assertion
library or test preload is required.

## Test Structure: describe / it

```typescript
import { beforeEach, describe, expect, it } from 'bun:test';

describe('UserService', () => {
  let mockRepo: IUserRepository;
  let subject: UserService;

  beforeEach(() => {
    mockRepo = {
      /* ... */
    };
    subject = new UserService(mockRepo);
  });

  it('should create user with valid input', async () => {
    // Arrange
    const input: UserRecord = { name: 'Alice', email: 'alice@test.com' };
    const expected = 'Alice';

    // Act
    const actual = await subject.create(input);

    // Assert
    expect(actual.principal.record.name).toBe(expected);
  });
});
```

## Assertions (expect)

```typescript
// Equality
expect(actual).toBe(expected); // strict equality
expect(actual).toEqual(expected); // deep equality

// Boolean
expect(result).toBe(true);
expect(result).toBe(false);

// Null / undefined
expect(value).toBeNull();
expect(value).toBeUndefined();
expect(value).toBeDefined();

// Truthiness
expect(value).toBeTruthy();
expect(value).toBeFalsy();

// Numbers
expect(count).toBeGreaterThan(5);
expect(count).toBeLessThan(10);
expect(count).toBeGreaterThanOrEqual(1);

// Strings
expect(text).toContain('substring');
expect(text).toStartWith('prefix');
expect(text).toEndWith('suffix');
expect(text).toMatch(/pattern/);

// Arrays
expect(items).toHaveLength(3);
expect(items).toContain('item');
expect(Array.isArray(items)).toBe(true);

// Objects
expect(obj).toHaveProperty('key');
expect(obj).toHaveProperty('key', 'value');

// Types
expect(typeof value).toBe('string');
expect(typeof value).toBe('number');
expect(value).toBeInstanceOf(SomeClass);

// Errors
expect(() => fn()).toThrow();
expect(() => fn()).toThrow('message');
expect(() => fn()).toThrow(Error);

// Async
await expect(promise).resolves.toBe(value);
await expect(promise).rejects.toThrow(Error);

// Negation
expect(actual).not.toBe(other);
```

## Parameterized Tests — `it.each`

```typescript
import { describe, expect, it } from 'bun:test';

describe('StatusFormatter', () => {
  it.each([
    { input: 'pending', expected: 'Pending' },
    { input: 'running', expected: 'Running' },
    { input: 'completed', expected: 'Completed' },
  ])('should format status "$input" as "$expected"', async ({ input, expected }) => {
    const subject = new StatusFormatter();
    const actual = subject.format(input);
    expect(actual).toBe(expected);
  });
});
```

## Manual Mocks

Implement the interface directly:

```typescript
class MemoryFileSystem implements IFileSystemAdapter {
  private readonly files = new Map<string, string>();

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}
```

## Spy Patterns

```typescript
// Collect calls
const logged: string[] = [];
const spyLogger: ILogger = {
  log: (msg: string) => logged.push(msg),
};
// Assert: expect(logged).toEqual(['msg1', 'msg2']);

// Capture argument
let captured: any = null;
const mockSender: ISender = {
  send: (payload: any) => {
    captured = payload;
  },
};
// Assert: expect(captured).toHaveProperty('id', '123');

// Count calls
let count = 0;
const mockClient: IClient = {
  fetch: () => {
    count++;
    throw new Error('fail');
  },
};
// Assert: expect(count).toBe(3);
```

## Functional Test — Contract Test

```typescript
import { beforeEach, describe, expect, it } from 'bun:test';

function repoContractTests(name: string, createRepo: () => ITaskRepository) {
  describe(`ITaskRepository contract: ${name}`, () => {
    let subject: ITaskRepository;

    beforeEach(() => {
      subject = createRepo();
    });

    it('should save and retrieve by id', async () => {
      const input = createTestTask();

      await subject.save(input);
      const actual = await subject.findById(input.id);

      expect(actual).not.toBeNull();
      expect(actual!.name).toBe(input.name);
    });
  });
}

repoContractTests('MemoryRepo', () => new TaskMemoryRepo());
repoContractTests('FileRepo', () => new TaskFileRepo(mockFs, mapper, '/tmp/test.json'));
```

## Integration Test — Testcontainers

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GenericContainer, StartedTestContainer } from 'testcontainers';

describe('PostRepository (Postgres)', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let subject: PostRepository;

  beforeEach(async () => {
    container = await new GenericContainer('postgres:16')
      .withExposedPorts(5432)
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'testdb' })
      .start();

    pool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: 'postgres',
      password: 'test',
      database: 'testdb',
    });

    await pool.query(`CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)`);
    subject = new PostRepository(pool, new PostRepoMapper());
  });

  afterEach(async () => {
    await pool.end();
    await container.stop();
  });

  it('should persist and retrieve a post', async () => {
    // Arrange
    const input = { title: 'Test Post', description: 'A test', tags: ['test'] };

    // Act
    const created = await subject.create(input);
    const actual = await subject.get(created.principal.id);

    // Assert
    expect(actual).not.toBeNull();
    expect(actual!.principal.record.title).toBe('Test Post');
  });
});
```

## Test Folder Structure

| Test Type   | Location            |
| ----------- | ------------------- |
| Unit        | `test/unit/`        |
| Functional  | `test/unit/` (same) |
| Integration | `test/integration/` |
