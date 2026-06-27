---
name: testing
description: Testing conventions across 5 levels — unit, functional, integration, SIT, and E2E. Use when writing tests, reviewing test code, choosing test strategies, or working with mocks/spies.
invocation:
  - test
  - testing
  - tests
  - unit-test
  - integration-test
  - functional-test
  - sit
  - e2e
---

# Testing Conventions

## Quick Reference

### Test Pyramid (bottom → top)

| Level           | Scope                        | Box       | Speed   | Coverage Goal                          |
| --------------- | ---------------------------- | --------- | ------- | -------------------------------------- |
| **Unit**        | Single class/function        | White-box | Fast    | 100% code coverage                     |
| **Functional**  | Interface contract           | Black-box | Fast    | All implementations pass same contract |
| **Integration** | Adapter + real dependency    | White-box | Medium  | 100% adapter coverage                  |
| **SIT**         | Full system, single endpoint | Black-box | Slow    | Endpoint-by-endpoint behavior          |
| **E2E**         | Full system + UI             | Black-box | Slowest | Critical happy paths only              |

### Frameworks

| Language       | Unit + Functional        | Integration                 | SIT | E2E        |
| -------------- | ------------------------ | --------------------------- | --- | ---------- |
| TypeScript/Bun | `bun:test` + `should`    | `bun:test` + Testcontainers | k6  | Playwright |
| C#/.NET        | xUnit + FluentAssertions | xUnit + Testcontainers      | k6  | Playwright |
| Go             | `testing` + testify      | `testing` + testify + TC    | k6  | Playwright |

### Test Naming Conventions

| Language   | Pattern                               | Example                                              |
| ---------- | ------------------------------------- | ---------------------------------------------------- |
| TypeScript | `describe`/`it` (native bun:test)     | `describe('UserService', () => { it('should...') })` |
| C#         | class = describe, method = it         | `class UserService_Create { It_should_create() }`    |
| Go         | testify suite = describe, method = it | `func (s *UserServiceSuite) TestCreate_it_should()`  |

### Parameterized Tests

| Language   | Pattern                                           |
| ---------- | ------------------------------------------------- |
| TypeScript | `test.each` / `it.each` (bun:test built-in)       |
| C#         | `TheoryData<>` + `[ClassData]` (NEVER InlineData) |
| Go         | Table-driven tests                                |

### Test Folder Structure

| Language   | Unit + Functional                           | Integration                                                |
| ---------- | ------------------------------------------- | ---------------------------------------------------------- |
| TypeScript | Separate test directory                     | Separate test directory                                    |
| C#         | `{Service}.UnitTest/` project               | `{Service}.IntTest/` project                               |
| Go         | `lib/` folder (`_test.go` alongside domain) | `adapters/` folder (`_test.go` + `//go:build integration`) |

## Core Principles

1. **Arrange-Act-Assert** — Three distinct sections with comments
2. **Standard Variable Names** — `subject`, `input`, `expected`, `actual`
3. **Triangulation** — Multiple test cases prove correctness
4. **Spies for Side Effects** — Collect calls, verify arguments, count calls
5. **Deterministic & Fast** — No random, no sleep, no real IO (unit tests)
6. **Test Pyramid** — Many unit tests, fewer integration, minimal E2E
7. **Testability as Design Feedback** — Hard to test = design problem

## See Also

Full documentation: [testing/](../../../docs/developer/standard/testing/)

Related skills:

- [`/stateless-oop-di`](../stateless-oop-di/) — For testable code design
- [`/three-layer-architecture`](../three-layer-architecture/) — For testing pure domain logic
- [`/domain-modeling`](../domain-modeling/) — For domain types used in tests
- [`/error-handling`](../error-handling/) — For testing error paths
