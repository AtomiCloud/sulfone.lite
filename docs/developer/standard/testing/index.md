# Testing Conventions

Testing is how we know the code works. But not all tests serve the same purpose. This article defines the complete testing pyramid for AtomiCloud: what each level tests, how it tests, and when to use it.

This article builds on [Software Design Philosophy](../software-design-philosophy/index.md), [SOLID Principles](../solid-principles/index.md), and [Stateless OOP and Dependency Injection](../stateless-oop-di/index.md). The patterns in those articles -- visible dependencies, stateless services, constructor injection -- are what make testing tractable.

---

## The Test Pyramid

```
                    ┌─────────────────────┐
                    │        E2E          │    Frontend only
                    │    (Black-box)      │    Playwright, Cypress
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │        SIT          │    Full system, client's eye
                    │    (Black-box)      │    k6, Gatling, Postman
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │    Integration      │    Module by module
                    │    (Black-box)      │    Testcontainers, mocks
                    └──────────┬──────────┘
                               │
           ┌───────────────────┴───────────────────┐
           │                                       │
    ┌──────┴──────┐                        ┌───────┴───────┐
    │  Functional │                        │     Unit      │
    │  (Black-box)│                        │  (White-box)  │
    │   LSP tests │                        │ 100% coverage │
    └─────────────┘                        └───────────────┘
```

The pyramid shape is deliberate: tests at the bottom are fast, cheap, and numerous. Tests at the top are slow, expensive, and few. A healthy codebase has many unit tests, some functional tests, fewer integration tests, and a minimal number of SIT/E2E tests.

---

## Unit Tests (White-Box)

Unit tests are **white-box tests** that examine the internal implementation of a single class or function. They know about private implementation details (in our case, extracted as injectable services). They aim for **100% code coverage**.

### Characteristics

- **Scope:** Single class or function
- **Visibility:** White-box (knows about dependencies and internal structure)
- **Speed:** Milliseconds
- **Coverage goal:** 100% of branches and paths
- **Dependencies:** All collaborators are mocked

### The AAA Pattern

Every unit test follows the same structure: **Arrange, Act, Assert**.

```typescript
it('should calculate order total', () => {
  // Arrange - set up the test
  const mockPricing = { sum: items => items.reduce((a, b) => a + b.price, 0) };
  const subject = new OrderService(mockRepo, mockPricing);
  const input = [
    { id: '1', name: 'Widget', price: 10 },
    { id: '2', name: 'Gadget', price: 20 },
  ];
  const expected = 30;

  // Act - do one thing
  const actual = subject.calculateTotal(input);

  // Assert - verify the result
  actual.should.eql(expected);
});
```

### Standard Variable Names

| Variable   | Purpose                        |
| ---------- | ------------------------------ |
| `subject`  | The class/function under test  |
| `input`    | Input parameters               |
| `expected` | Expected result                |
| `actual`   | Actual result from method call |

### Triangulation: Test Multiple Values

One test case might pass by accident. Multiple cases prove correctness.

```typescript
// WRONG - Single case, might pass by luck
it('should format status', () => {
  expect(formatStatus('pending')).toBe('Pending');
});

// RIGHT - Multiple cases prove the logic
it.each([
  ['pending', 'Pending'],
  ['running', 'Running'],
  ['completed', 'Completed'],
])('should format status (%s -> %s)', (input, expected) => {
  expect(formatStatus(input)).toBe(expected);
});
```

### Spies and Mocks for Side Effects

Pure functions don't need spies -- just check the return value. But when code has side effects (logging, I/O), use spies to verify behavior.

```typescript
// Arrange - set up collection
const logs: string[] = [];
const spyLogger = {
  log: (msg: string) => logs.push(msg),
};
const subject = new Service(spyLogger);

// Act
subject.doSomething();

// Assert - verify what was called
logs.should.eql(['expected message']);
```

### Deterministic and Fast

Tests must be:

- **Deterministic** -- No random values, no real time
- **Fast** -- No sleep, no real I/O
- **Isolated** -- No dependence on test order

```typescript
// WRONG - Uses real time (slow, non-deterministic)
it('should timeout after 1 second', async () => {
  const start = Date.now();
  await subject.doSomething();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeGreaterThan(1000);
});

// RIGHT - Uses injected clock (fast, deterministic)
it('should timeout after deadline', () => {
  const clock = new FakeClock();
  const subject = new Service(clock);
  clock.tick(1001);
  subject.hasTimedOut().should.be.true();
});
```

---

## Functional Tests (Black-Box)

Functional tests are **black-box tests** that verify behavior through interfaces. They do not know about internal implementation -- only inputs, outputs, and the interface contract.

### Characteristics

- **Scope:** Interface contract
- **Visibility:** Black-box (tests against interface, not implementation)
- **Speed:** Fast (still mocked)
- **Coverage goal:** All interface behaviors
- **Key property:** Verifies LSP (Liskov Substitution Principle)

### Why Functional Tests Matter

Functional tests validate the **interface contract**. They ensure that any implementation of the interface will behave correctly. This is the essence of the Liskov Substitution Principle.

```typescript
// The interface
interface IPaymentProcessor {
  charge(amount: Money, card: CardDetails): Result<Charge, PaymentError>;
  refund(chargeId: string): Result<Refund, PaymentError>;
}

// Functional test - tests the contract, not a specific implementation
describe('IPaymentProcessor contract', () => {
  // This test runs against ANY implementation
  function testContract(createProcessor: () => IPaymentProcessor) {
    it('should charge successfully with valid card', () => {
      const subject = createProcessor();
      const result = subject.charge(Money.usd(10.0), validCard);
      expect(result.isOk()).toBe(true);
    });

    it('should reject invalid card', () => {
      const subject = createProcessor();
      const result = subject.charge(Money.usd(10.0), invalidCard);
      expect(result.isErr()).toBe(true);
    });
  }

  // Test Stripe implementation
  describe('StripePaymentProcessor', () => {
    testContract(() => new StripePaymentProcessor(mockStripeClient));
  });

  // Test PayPal implementation
  describe('PaypalPaymentProcessor', () => {
    testContract(() => new PaypalPaymentProcessor(mockPaypalClient));
  });
});
```

### Unit vs Functional: Same Folder, Different Purpose

In practice, unit tests and functional tests often live in the same test folder. But they serve different purposes:

| Aspect      | Unit Test                  | Functional Test      |
| ----------- | -------------------------- | -------------------- |
| Knows about | Internal dependencies      | Interface only       |
| Mocks       | All collaborators          | All collaborators    |
| Validates   | Implementation correctness | Contract correctness |
| Fails when  | Code bug                   | Interface violation  |

---

## Integration Tests

Integration tests verify that modules work together correctly. They test the **wiring** between components, not individual units.

### Characteristics

- **Scope:** Multiple modules working together
- **Visibility:** Black-box from module perspective
- **Speed:** Slower (may use real databases, queues)
- **Coverage goal:** Critical integration paths

### Example: Repository + Database

```typescript
describe("OrderRepository integration", () => {
  let db: Database;
  let repo: OrderRepository;

  beforeAll(async () => {
    // Real database connection (Testcontainers, Docker, etc.)
    db = await Database.startTestContainer();
    repo = new OrderRepository(db);
  });

  afterAll(async () => {
    await db.stop();
  });

  it("should persist and retrieve order", async () => {
    const order = Order.create({ items: [...], total: Money.usd(100) });
    await repo.save(order);
    const retrieved = await repo.getById(order.id);
    expect(retrieved).toEqual(order);
  });
});
```

Integration tests test **module by module**, not the whole system at once. A repository integration test uses a real database but still mocks external services like payment processors.

---

## SIT (System Integration Testing)

SIT tests the **entire system from a client's perspective**. This is fully black-box testing: the test has no access to the code, no coverage metrics, only the external API.

### Characteristics

- **Scope:** Full system
- **Visibility:** Black-box (client's eye view)
- **Speed:** Slow
- **Coverage goal:** Critical user journeys
- **Tools:** k6, Gatling, Postman, custom scripts

### Why SIT?

Integration tests verify pairs of modules. SIT verifies that the entire assembled system works. This catches:

- Configuration errors
- Wiring mistakes
- Environment-specific issues
- Performance problems under load

### SIT Example with k6

```javascript
// k6 script - tests from outside the system
import http from 'k6/http';
import { check } from 'k6';

export default function () {
  // Create order
  const createRes = http.post(
    'https://api.example.com/orders',
    JSON.stringify({
      items: [{ productId: 'widget-1', quantity: 2 }],
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );

  check(createRes, {
    'create returns 201': r => r.status === 201,
    'create returns order id': r => r.json('id') !== undefined,
  });

  const orderId = createRes.json('id');

  // Get order
  const getRes = http.get(`https://api.example.com/orders/${orderId}`);

  check(getRes, {
    'get returns 200': r => r.status === 200,
    'get returns correct order': r => r.json('id') === orderId,
  });
}
```

### No Coverage Metrics

SIT is black-box. We cannot measure code coverage. Instead, we measure:

- Response times
- Error rates
- Throughput
- User journey completion

---

## E2E (End-to-End Testing)

E2E tests verify the **entire user experience**, including the frontend. These are the most expensive tests to write and maintain.

### Characteristics

- **Scope:** Full stack including UI
- **Visibility:** Black-box (user's eye view)
- **Speed:** Slowest
- **Coverage goal:** Critical happy paths only

### E2E Is Only Needed for Frontend

If you are building a backend API, you do not need E2E tests. SIT covers your needs. E2E is specifically for verifying that:

- The frontend renders correctly
- User interactions work
- Frontend and backend integrate properly

### Example with Playwright

```typescript
test('user can create order', async ({ page }) => {
  await page.goto('/orders/new');

  await page.fill('[data-testid="product-search"]', 'widget');
  await page.click('[data-testid="product-widget-1"]');
  await page.click('[data-testid="add-to-order"]');

  await page.click('[data-testid="submit-order"]');

  await expect(page.locator('[data-testid="order-success"]')).toBeVisible();
  await expect(page.locator('[data-testid="order-id"]')).toHaveText(/ORD-/);
});
```

### E2E Tests Should Be Minimal

E2E tests are brittle and expensive. Keep them to a minimum:

- Test the critical happy path
- Test the most common user journey
- Leave edge cases to lower-level tests

---

## Test Organization

Group tests logically:

```
src/
  services/
    OrderService.ts
    OrderService.test.ts        # Unit tests (white-box)
    OrderService.functional.ts  # Functional tests (black-box, LSP)

tests/
  integration/
    order-repository.test.ts    # Integration (module + database)
  sit/
    order-flow.test.ts          # SIT (full system, k6)
  e2e/
    order-creation.spec.ts      # E2E (Playwright, frontend)
```

---

## Quick Checklist

**Unit Tests:**

- [ ] AAA pattern with comments
- [ ] Variable names: subject, input, expected, actual
- [ ] Multiple test cases (triangulation)
- [ ] Spies for side effects
- [ ] Deterministic (no random, no real time)
- [ ] Fast (no sleep, no real I/O)
- [ ] 100% coverage goal

**Functional Tests:**

- [ ] Tests against interfaces, not implementations
- [ ] Same contract tests for all implementations
- [ ] Verifies LSP (Liskov Substitution Principle)

**Integration Tests:**

- [ ] Tests module combinations
- [ ] Uses real databases/queues where appropriate
- [ ] Still mocks external services

**SIT:**

- [ ] Full system from client's perspective
- [ ] Black-box only (no code access)
- [ ] No coverage metrics (measure behavior instead)
- [ ] Uses tools like k6, Gatling

**E2E:**

- [ ] Includes frontend
- [ ] Tests critical happy paths only
- [ ] Uses Playwright, Cypress, or similar

---

## Language-Specific Details

See language-specific guides for implementation details:

- [TypeScript/Bun](./languages/typescript.md) - bun:test
- [C#/.NET](./languages/csharp.md) - xUnit + FluentAssertions
- [Go](./languages/go.md) - testing + testify

## Related Articles

- [Software Design Philosophy](../software-design-philosophy/index.md) -- the foundational "why"
- [SOLID Principles](../solid-principles/index.md) -- LSP for functional tests
- [Stateless OOP and Dependency Injection](../stateless-oop-di/index.md) -- designing testable code
- [Three-Layer Architecture](../three-layer-architecture/index.md) -- testing pure domain logic
