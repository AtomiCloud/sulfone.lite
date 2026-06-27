# Testing in TypeScript/Bun

## Framework: `bun:test` + `should`

Bun test runner with `should` assertion library.

## Test Structure: describe / it

```typescript
import { describe, it, beforeEach } from 'bun:test';
import '../setup.ts';
import should from 'should';

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
    actual.principal.record.name.should.equal(expected);
  });
});
```

## Assertions (should)

```typescript
import should from 'should';

// Equality
actual.should.equal(expected); // strict equality
actual.should.deepEqual(expected); // deep equality

// Boolean
result.should.be.true();
result.should.be.false();

// Null/undefined
should(value).be.null();
should(value).be.undefined();
value.should.not.be.undefined();

// Truthiness
value.should.be.ok(); // truthy
value.should.not.be.ok(); // falsy

// Numbers
count.should.be.above(5);
count.should.be.below(10);
count.should.be.within(1, 10);

// Strings
text.should.containEql('substring');
text.should.startWith('prefix');
text.should.endWith('suffix');

// Arrays
items.should.have.length(3);
items.should.containEql('item');
items.should.be.an.Array();

// Objects
obj.should.have.property('key');
obj.should.have.property('key', 'value');

// Types
value.should.be.a.String();
value.should.be.a.Number();
value.should.be.an.Object();
value.should.be.an.Array();
value.should.be.a.Function();

// Errors
should(() => fn()).throw();
should(() => fn()).throw('message');
should(() => fn()).throw(Error);

// Async
await promise.should.be.resolved();
await promise.should.be.resolvedWith(value);
await promise.should.be.rejected();
await promise.should.be.rejectedWith(Error);

// Negation
actual.should.not.equal(other);
```

## Parameterized Tests — `it.each`

```typescript
import { describe, it } from 'bun:test';
import should from 'should';

describe('StatusFormatter', () => {
  it.each([
    { input: 'pending', expected: 'Pending' },
    { input: 'running', expected: 'Running' },
    { input: 'completed', expected: 'Completed' },
  ])('should format status "$input" as "$expected"', async ({ input, expected }) => {
    const subject = new StatusFormatter();
    const actual = subject.format(input);
    actual.should.equal(expected);
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
// Assert: logged.should.deepEqual(['msg1', 'msg2']);

// Capture argument
let captured: any = null;
const mockSender: ISender = {
  send: (payload: any) => {
    captured = payload;
  },
};
// Assert: captured.should.have.property('id', '123');

// Count calls
let count = 0;
const mockClient: IClient = {
  fetch: () => {
    count++;
    throw new Error('fail');
  },
};
// Assert: count.should.equal(3);
```

## Functional Test — Contract Test

```typescript
import { describe, it, beforeEach } from 'bun:test';
import should from 'should';

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

      should(actual).not.be.null();
      actual!.name.should.equal(input.name);
    });
  });
}

repoContractTests('MemoryRepo', () => new TaskMemoryRepo());
repoContractTests('FileRepo', () => new TaskFileRepo(mockFs, mapper, '/tmp/test.json'));
```

## Integration Test — Testcontainers

```typescript
import { describe, it, beforeEach, afterEach } from 'bun:test';
import should from 'should';
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
    should(actual).not.be.null();
    actual!.principal.record.title.should.equal('Test Post');
  });
});
```

## Test Folder Structure

| Test Type   | Location            |
| ----------- | ------------------- |
| Unit        | `test/unit/`        |
| Functional  | `test/unit/` (same) |
| Integration | `test/integration/` |
