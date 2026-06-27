---
id: typescript-quality
title: TypeScript/Bun Quality Gates
---

# TypeScript/Bun Quality Gates

This standard defines the default setup for TypeScript projects that use Bun,
`bun:test`, `should`, and Knip.

It is intentionally split into two Knip workflows:

- **Agent workflow:** loose, noisy, and review-heavy.
- **Pre-commit workflow:** conservative, narrow, and suitable for blocking commits.

## Required Dependencies

```bash
bun add -D typescript @types/bun should @types/should knip
```

Use `@types/bun` for Bun's TypeScript declarations.

## Bun Test Setup

Use `bun:test` with `should` assertions.

### `bunfig.toml`

```toml
[test]
preload = ["./test/setup.ts"]
coverageSkipTestFiles = true
```

### `test/setup.ts`

```typescript
import 'should';
```

The preload enables `.should` assertions, such as `actual.should.equal(expected)`.
Import `should` directly in a test file only when using the function form, such
as `should(value).be.null()`.

### Test Example

```typescript
import { describe, it } from 'bun:test';

import { add } from '../../src/add';

describe('add', () => {
  it('should add two numbers', () => {
    // Arrange
    const expected = 3;

    // Act
    const actual = add(1, 2);

    // Assert
    actual.should.equal(expected);
  });
});
```

Keep the normal testing conventions from
[Testing in TypeScript/Bun](../testing/languages/typescript.md).

## Package Scripts

Use these scripts as the baseline.

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test test/unit",
    "test:integration": "bun test test/integration",
    "knip:agent": "bun scripts/knip-agent.ts",
    "knip:precommit": "bun scripts/knip-precommit.ts"
  }
}
```

Use helper scripts instead of `cmd1 && cmd2` so both Knip passes always run,
even when the first pass finds issues.

### `scripts/knip-agent.ts`

```typescript
const steps = [
  ['default', ['x', 'knip', '--config', 'knip.json', '--include-entry-exports']],
  ['production', ['x', 'knip', '--config', 'knip.json', '--production', '--strict', '--include-entry-exports']],
] as const;

let failed = false;

for (const [name, args] of steps) {
  console.error(`\nknip agent (${name})`);
  const result = Bun.spawnSync({
    cmd: ['bun', ...args],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  failed ||= !result.success;
}

process.exit(failed ? 1 : 0);
```

### `scripts/knip-precommit.ts`

```typescript
const steps = [
  ['default', ['x', 'knip', '--config', 'knip.precommit.json', '--include', 'files']],
  ['production', ['x', 'knip', '--config', 'knip.precommit.json', '--production', '--include', 'files']],
] as const;

let failed = false;

for (const [name, args] of steps) {
  console.error(`\nknip pre-commit (${name})`);
  const result = Bun.spawnSync({
    cmd: ['bun', ...args],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  failed ||= !result.success;
}

process.exit(failed ? 1 : 0);
```

## Knip Agent Workflow

Agents must run the loose workflow before cleanup work:

```bash
bun run knip:agent
```

This runs Knip twice:

1. **Default mode:** normal analysis, where tests and tooling can count as usage.
2. **Production mode:** `--production --strict`, where test code does not count as
   production usage and dev dependencies are ignored.

The agent workflow should raise many findings. That is expected. The agent must
inspect each finding and decide whether it is real.

### Do Not Encode Agent False Positives

Do **not** add noisy agent findings to `ignore`, `ignoreFiles`,
`ignoreDependencies`, or similar Knip suppression lists just because they are
false positives today.

False positives are temporary analysis results, not durable project knowledge.
If a finding is false today, it may become true after later code changes. Leave
the configuration noisy and make the agent spend the review effort.

Only edit Knip configuration when the project boundary is wrong, for example:

- a real runtime entry point is missing from `entry`
- generated output is accidentally included in `project`
- workspace boundaries are incomplete
- import aliases need `paths`

## Loose Agent Config

Start with a broad `knip.json`.

```json
{
  "$schema": "https://unpkg.com/knip@latest/schema.json",
  "entry": [
    "src/index.ts!",
    "scripts/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}",
    "test/**/*.{test,spec}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"
  ],
  "project": [
    "*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}",
    "src/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}!",
    "scripts/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}",
    "test/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"
  ]
}
```

The `!` suffix marks production patterns. Knip uses those patterns during
`--production`.

Add every real runtime entry point for the project, such as `src/server.ts!` or
`src/cli.ts!`. Do not list optional entry names that do not exist, because Knip
will report configuration hints for unmatched patterns.

## Conservative Pre-commit Workflow

Pre-commit must run a conservative workflow:

```bash
bun run knip:precommit
```

This also runs Knip twice:

1. **Default mode:** catches files unused by the whole project.
2. **Production mode:** catches source files only used by tests or development
   tooling.

The pre-commit workflow includes only the `files` issue type. It intentionally
does not block on unused exports, enum members, dependency issues, or type-only
findings because those categories can be noisy in real projects.

If `knip:precommit` fails, treat it as real dead code unless you can prove the
configuration boundary is wrong.

## Conservative Pre-commit Config

Create `knip.precommit.json` for the conservative gate.

```json
{
  "$schema": "https://unpkg.com/knip@latest/schema.json",
  "entry": ["src/index.ts!", "test/**/*.{test,spec}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"],
  "project": ["src/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}!", "test/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"]
}
```

Add every real runtime entry point for the project. Do not add arbitrary files
as entries to silence unused-file findings.

## Pre-commit Hook

For Bun projects, add a hook like this to `nix/pre-commit.nix`.

```nix
a-knip = {
  enable = true;
  name = "Knip dead code";
  entry = "bun run knip:precommit";
  files = "(^|/)(package\\.json|bun\\.lockb?|knip(\\.precommit)?\\.json|bunfig\\.toml|tsconfig[^/]*\\.json|.*\\.(js|cjs|mjs|jsx|ts|cts|mts|tsx))$";
  pass_filenames = false;
  language = "system";
};
```

If Bun is not already available in the Nix shell, add the Bun package through
the standard Nix package flow in [Nix](../nix.md). If the project intentionally
uses `node_modules/.bin`, declare that in `.envrc` only when the binary's
existence is traceable to `package.json`.

## Verification

After setup, run:

```bash
bun test
bun run knip:agent
bun run knip:precommit
pre-commit run a-knip --all-files
```

Expected behavior:

- `bun test` runs tests with `should` assertions available from `test/setup.ts`.
- `knip:agent` may fail with many findings that require human/agent judgment.
- `knip:precommit` fails only for unused files in default or production mode.
- production mode flags source files that are reachable only from tests.

## References

- Knip production mode: <https://knip.dev/features/production-mode>
- Knip configuration: <https://knip.dev/reference/configuration>
- Knip project files: <https://knip.dev/guides/configuring-project-files>
- Bun test configuration: <https://bun.com/docs/test/configuration>
- Bun TypeScript setup: <https://bun.com/docs/typescript>
