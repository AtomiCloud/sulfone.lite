# Testing — Reference

## AAA Pattern

| Section     | Purpose                                           |
| ----------- | ------------------------------------------------- |
| **Arrange** | Construct subject, define inputs, define expected |
| **Act**     | `actual = subject.method(input)`                  |
| **Assert**  | `actual == expected`                              |

Each section must be explicitly commented (`// Arrange`, `// Act`, `// Assert`).

## Standard Variables

| Variable   | Usage                           |
| ---------- | ------------------------------- |
| `subject`  | The class/function being tested |
| `input`    | Input parameters                |
| `expected` | Expected result                 |
| `actual`   | Actual result                   |

## Test Pyramid

| Level           | Scope                        | Box       | Speed   | Coverage Goal         |
| --------------- | ---------------------------- | --------- | ------- | --------------------- |
| **Unit**        | Single class/function        | White-box | Fast    | 100% domain coverage  |
| **Functional**  | Interface contract           | Black-box | Fast    | All implementations   |
| **Integration** | Adapter + real dependency    | White-box | Medium  | 100% adapter coverage |
| **SIT**         | Full system, single endpoint | Black-box | Slow    | Endpoint behavior     |
| **E2E**         | Full system + UI             | Black-box | Slowest | Critical happy paths  |

## Frameworks

| Language       | Unit + Functional        | Integration                 | SIT | E2E        |
| -------------- | ------------------------ | --------------------------- | --- | ---------- |
| TypeScript/Bun | `bun:test` + `should`    | `bun:test` + Testcontainers | k6  | Playwright |
| C#/.NET        | xUnit + FluentAssertions | xUnit + Testcontainers      | k6  | Playwright |
| Go             | `testing` + testify      | `testing` + testify + TC    | k6  | Playwright |

## Mock Patterns

| Pattern          | Use Case              | Implementation                |
| ---------------- | --------------------- | ----------------------------- |
| Collect calls    | Verify what was sent  | `calls.push(arg)` then assert |
| Capture argument | Verify payload        | `captured = arg` then assert  |
| Count calls      | Verify retry behavior | `count++` then assert         |
| Return value     | Stub dependency       | `return mockValue`            |

## Testability Feedback

| Difficulty                        | Problem               | Fix                        |
| --------------------------------- | --------------------- | -------------------------- |
| Too many collaborators in Arrange | SRP violation         | Split the class            |
| Hidden state affecting results    | Implicit dependencies | Make dependencies explicit |
| Cannot swap implementation        | Missing interfaces    | Extract interface          |
| Side effects everywhere           | Impure functions      | Push IO to boundaries      |

## Folder Structure

| Language   | Unit + Functional                    | Integration                                         |
| ---------- | ------------------------------------ | --------------------------------------------------- |
| TypeScript | `test/unit/`, `test/integration/`    | `test/integration/`                                 |
| C#         | `{Service}.UnitTest/` project        | `{Service}.IntTest/` project                        |
| Go         | `lib/` (`_test.go` alongside domain) | `adapters/` (`_test.go` + `//go:build integration`) |

## Quick Checklist

- [ ] AAA pattern with section comments
- [ ] Variables: `subject`, `input`, `expected`, `actual`
- [ ] All dependencies injected via constructor
- [ ] No real IO in unit tests
- [ ] Functional tests against interface, not implementation
- [ ] Integration tests use Testcontainers for real dependencies

## Cross-References

- [Testing (Full Documentation)](../../../docs/developer/standard/testing/)
- [`/stateless-oop-di`](../stateless-oop-di/) — Testable code design
- [`/error-handling`](../error-handling/) — Testing error paths
